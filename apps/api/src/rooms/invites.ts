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
 * Redeem an invite: validate and CONSUME one use in a single statement.
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
 *
 * On failure this does a second, read-only query purely to explain WHY, since
 * the UPDATE cannot distinguish "no such token" from "already used up". That
 * read is not security-sensitive: it runs only after the atomic gate has already
 * refused, and it reports on a token the caller already holds.
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

  return { ok: false, reason: await explainFailure(tokenHash) };
}

/**
 * Diagnose a refused redemption. Ordered most-specific-first so the message
 * names the reason a user can act on ("this link expired" beats "invalid link").
 */
async function explainFailure(tokenHash: string): Promise<RedeemFailure> {
  const invite = await prismaClient.invite.findUnique({
    where: { tokenHash },
    select: { revokedAt: true, expiresAt: true, usedCount: true, maxUses: true },
  });
  if (!invite) return "not_found";
  if (invite.revokedAt !== null) return "revoked";
  if (invite.expiresAt.getTime() <= Date.now()) return "expired";
  if (invite.usedCount >= invite.maxUses) return "exhausted";
  // Refused by the atomic gate but every condition now reads as satisfiable —
  // only possible if the row changed between the two queries. Treat as
  // exhausted: something else consumed it.
  return "exhausted";
}

/**
 * Accept an invite for a user: redeem it, then create or upgrade the membership.
 *
 * Redemption happens FIRST and outside the membership write. If the membership
 * upsert were to fail, a use is still spent — which is the safe direction: a
 * wasted use is recoverable by issuing another invite, whereas granting
 * membership without consuming a use would make every invite unbounded.
 *
 * An existing member keeps the HIGHER of their current role and the invite's, so
 * redeeming a VIEWER link can never silently demote an EDITOR.
 */
export async function acceptInvite(
  rawToken: string,
  userId: string,
): Promise<
  | { ok: true; roomId: string; role: Role }
  | { ok: false; reason: RedeemFailure }
> {
  const redeemed = await redeemInvite(rawToken);
  if (!redeemed.ok) return redeemed;

  const { roomId, role } = redeemed.value;

  const existing = await prismaClient.roomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
    select: { role: true },
  });

  const effective = existing ? higherRole(existing.role, role) : role;

  await prismaClient.roomMember.upsert({
    where: { roomId_userId: { roomId, userId } },
    update: { role: effective },
    create: { roomId, userId, role: effective },
  });

  return { ok: true, roomId, role: effective };
}

/** Higher of two roles by privilege. Local to avoid importing ROLE_RANK's
 *  ordering concerns into this module's error paths. */
function higherRole(a: Role, b: Role): Role {
  const rank: Record<Role, number> = { OWNER: 3, EDITOR: 2, VIEWER: 1 };
  return rank[a] >= rank[b] ? a : b;
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
