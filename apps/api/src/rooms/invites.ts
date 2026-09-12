import { createHash, randomBytes } from "node:crypto";
import { Prisma, Role, prismaClient, type Invite } from "@sketchsync/db";

/**
 * Room invite minting and redemption.
 *
 * SAME PATTERN AS apps/api/src/auth/ticket.ts, on purpose: a random opaque
 * value, only its SHA-256 persisted, the raw token returned exactly once, and
 * redemption performed as ONE atomic statement. Two credential systems that
 * behave identically are one set of properties to reason about; two that differ
 * subtly are a bug waiting for the difference to matter.
 *
 * The one deliberate divergence: a WsTicket is consumed by DELETE, because it
 * is single-use and disposable. An invite carries a use budget and an audit
 * trail, so it is consumed by INCREMENT and survives redemption.
 */

/** 32 random bytes, base64url — URL-safe, so it can live in an accept link. */
function newInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface IssuedInvite {
  invite: Invite;
  /** The RAW token. Returned to the creator once and never stored. */
  token: string;
}

/**
 * Mint an invite for a room. Returns the raw token, which the caller must hand
 * back to the client immediately — it cannot be recovered afterwards.
 *
 * `role` is typed as the Prisma Role but the API layer restricts it to
 * EDITOR/VIEWER (see InviteRole in @sketchsync/shared); OWNER invites are not
 * a supported way to reach a second owner.
 */
export async function issueInvite(params: {
  roomId: string;
  createdBy: string;
  role: Role;
  expiresInHours: number;
  maxUses: number;
}): Promise<IssuedInvite> {
  const token = newInviteToken();
  const expiresAt = new Date(Date.now() + params.expiresInHours * 60 * 60 * 1000);

  const invite = await prismaClient.invite.create({
    data: {
      roomId: params.roomId,
      tokenHash: hashInviteToken(token),
      role: params.role,
      createdBy: params.createdBy,
      expiresAt,
      maxUses: params.maxUses,
    },
  });

  return { invite, token };
}

/** Why a redemption attempt failed. Callers map these to a status + message. */
export type RedeemFailure = "not_found" | "revoked" | "expired" | "exhausted";

export interface RedeemSuccess {
  roomId: string;
  role: Role;
  inviteId: string;
}

/**
 * What redeeming an invite actually did.
 *
 * `alreadyMember` is the outcome that matters, and it exists because of a real
 * bug. Redeeming a VIEWER invite as an existing EDITOR used to report success,
 * redirect into the board, SPEND A USE, and grant exactly what the user already
 * had — silently. An owner handing out a view-only link had no way to discover
 * it had not applied. Now that case is named, costs nothing, and is reported.
 */
export type AcceptKind = "joined" | "upgraded" | "alreadyMember";

export interface AcceptSuccess {
  ok: true;
  kind: AcceptKind;
  roomId: string;
  /** The role the user holds AFTER this call. */
  role: Role;
  /** Their previous role, when they already had one. */
  previousRole?: Role;
  /** Whether a use was consumed. Always false for `alreadyMember`. */
  usedAUse: boolean;
}

const ROLE_ORDER: Record<Role, number> = { OWNER: 3, EDITOR: 2, VIEWER: 1 };

function rankOf(role: Role): number {
  return ROLE_ORDER[role];
}

/** Higher of two roles by privilege. Local to avoid importing ROLE_RANK's
 *  ordering concerns into this module's error paths. */
function higherRole(a: Role, b: Role): Role {
  return rankOf(a) >= rankOf(b) ? a : b;
}

/**
 * Validate an invite WITHOUT consuming it.
 *
 * Split out because "does this redemption need to spend a use?" has to be
 * decided before the atomic increment, and that decision depends on the
 * invite's room and role.
 *
 * THIS READ IS NOT THE VALIDITY GATE. The increment below re-checks every
 * condition against the committed row, so a concurrent revoke, expiry or
 * exhaustion landing between the two still refuses correctly.
 */
async function inspectInvite(
  tokenHash: string,
): Promise<
  | { ok: true; id: string; roomId: string; role: Role }
  | { ok: false; reason: RedeemFailure }
> {
  const invite = await prismaClient.invite.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      roomId: true,
      role: true,
      revokedAt: true,
      expiresAt: true,
      usedCount: true,
      maxUses: true,
    },
  });
  if (!invite) return { ok: false, reason: "not_found" };
  if (invite.revokedAt !== null) return { ok: false, reason: "revoked" };
  if (invite.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  if (invite.usedCount >= invite.maxUses) return { ok: false, reason: "exhausted" };
  return { ok: true, id: invite.id, roomId: invite.roomId, role: invite.role };
}

/**
 * Consume one use: validate and increment in a single statement.
 *
 * ```sql
 * UPDATE "Invite" SET "usedCount" = "usedCount" + 1
 * WHERE "tokenHash" = $1 AND "revokedAt" IS NULL
 *   AND "expiresAt" > NOW() AND "usedCount" < "maxUses"
 * RETURNING ...
 * ```
 *
 * THE ATOMICITY IS THE WHOLE POINT. Postgres takes a row lock for the UPDATE
 * and re-evaluates the WHERE clause against the committed row, so two requests
 * racing on a single-use invite serialize: the first moves usedCount 0 -> 1, the
 * second then fails `usedCount < maxUses` and returns no row. Reading the invite
 * and then updating it — even inside a transaction at READ COMMITTED — would let
 * both reads see usedCount = 0 and both proceed.
 *
 * `NOW()` is the DATABASE clock, so a skewed application server cannot extend an
 * invite's life, exactly as with WsTicket expiry.
 */
export async function redeemInvite(
  rawToken: string,
): Promise<{ ok: true; value: RedeemSuccess } | { ok: false; reason: RedeemFailure }> {
  const tokenHash = hashInviteToken(rawToken);

  const rows = await prismaClient.$queryRaw<
    { id: string; roomId: string; role: Role }[]
  >`
    UPDATE "Invite"
    SET "usedCount" = "usedCount" + 1
    WHERE "tokenHash" = ${tokenHash}
      AND "revokedAt" IS NULL
      AND "expiresAt" > NOW()
      AND "usedCount" < "maxUses"
    RETURNING "id", "roomId", "role"
  `;

  const row = rows[0];
  if (row) {
    return { ok: true, value: { inviteId: row.id, roomId: row.roomId, role: row.role } };
  }

  // The UPDATE cannot distinguish "no such token" from "already used up", so
  // diagnose with a read. Not security-sensitive: it runs only after the atomic
  // gate has already refused, and reports on a token the caller already holds.
  const diagnosis = await inspectInvite(tokenHash);
  if (!diagnosis.ok) return { ok: false, reason: diagnosis.reason };
  // Refused by the gate, yet every condition now reads as satisfiable — the row
  // changed between the two queries. Something else consumed it.
  return { ok: false, reason: "exhausted" };
}

/**
 * Accept an invite: work out what it would actually change, then do the least
 * that achieves it.
 *
 *   - Not a member          -> join at the invite's role.       (spends a use)
 *   - Member at a LOWER role -> upgrade to the invite's role.   (spends a use)
 *   - Member at the SAME or HIGHER role, board owner included
 *                           -> NOTHING. No use spent, no role change, reported
 *                              to the caller as `alreadyMember`.
 *
 * WHY NOT SPENDING A USE MATTERS. A single-use link handed to someone who
 * already has access would otherwise be burnt on a no-op, and the next person it
 * was meant for would be told it had "already been used". Charging a use for a
 * change that did not happen is indefensible once the no-op is detectable at all.
 *
 * NEVER-DEMOTE IS KEPT. A VIEWER link cannot strip an EDITOR's access — that
 * would turn a link into a weapon, and anyone holding one could downgrade a
 * colleague. Demotion stays the owner's explicit act through the member list,
 * where it is deliberate and attributable.
 *
 * THE BOARD OWNER IS NEVER TOUCHED. OWNER outranks both invite roles, so the
 * same-or-higher branch already covers it — but it is also checked explicitly,
 * because "the owner's role cannot be changed by a link" is too important to
 * rest on a rank comparison some later edit might reorder.
 */
export async function acceptInvite(
  rawToken: string,
  userId: string,
): Promise<AcceptSuccess | { ok: false; reason: RedeemFailure }> {
  const tokenHash = hashInviteToken(rawToken);

  // Look before consuming. The increment below remains the real gate; this read
  // exists only to decide whether consuming is warranted at all.
  const inspected = await inspectInvite(tokenHash);
  if (!inspected.ok) return { ok: false, reason: inspected.reason };

  const existing = await prismaClient.roomMember.findUnique({
    where: { roomId_userId: { roomId: inspected.roomId, userId } },
    select: { role: true },
  });

  if (existing) {
    const room = await prismaClient.room.findUnique({
      where: { id: inspected.roomId },
      select: { ownerId: true },
    });
    const isOwner = room?.ownerId === userId;

    if (isOwner || rankOf(existing.role) >= rankOf(inspected.role)) {
      return {
        ok: true,
        kind: "alreadyMember",
        roomId: inspected.roomId,
        role: existing.role,
        previousRole: existing.role,
        usedAUse: false,
      };
    }
  }

  // A real change. Only now is a use spent, under the atomic gate.
  const redeemed = await redeemInvite(rawToken);
  if (!redeemed.ok) return redeemed;

  const { roomId, role } = redeemed.value;

  // Re-read after the increment: another request may have changed this
  // membership in between. `higherRole` keeps never-demote true even in that
  // race, so a concurrent upgrade cannot be undone by a lower-role redemption.
  const current = await prismaClient.roomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
    select: { role: true },
  });
  const effective = current ? higherRole(current.role, role) : role;

  await prismaClient.roomMember.upsert({
    where: { roomId_userId: { roomId, userId } },
    update: { role: effective },
    create: { roomId, userId, role: effective },
  });

  return current
    ? {
        ok: true,
        kind: "upgraded",
        roomId,
        role: effective,
        previousRole: current.role,
        usedAUse: true,
      }
    : { ok: true, kind: "joined", roomId, role: effective, usedAUse: true };
}

/** Public, non-sensitive view of an invite. NEVER includes the token or hash. */
export interface InviteView {
  id: string;
  role: Role;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  revokedAt: string | null;
  /** Derived: whether this invite would be accepted right now. */
  active: boolean;
}

export function toInviteView(invite: Invite): InviteView {
  const active =
    invite.revokedAt === null &&
    invite.expiresAt.getTime() > Date.now() &&
    invite.usedCount < invite.maxUses;
  return {
    id: invite.id,
    role: invite.role,
    createdBy: invite.createdBy,
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt.toISOString(),
    maxUses: invite.maxUses,
    usedCount: invite.usedCount,
    revokedAt: invite.revokedAt?.toISOString() ?? null,
    active,
  };
}

/** Narrow a Prisma unique-violation, used when a concurrent accept races the
 *  membership upsert. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}
