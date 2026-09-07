import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * REQUIRES A DATABASE. This is the one suite in the repo that does.
 *
 * Atomic redemption is a property of a SQL statement, not of TypeScript: the
 * guarantee is that Postgres takes a row lock for the UPDATE and re-evaluates
 * the WHERE clause against the committed row, so two racing redemptions of a
 * single-use invite serialize. A mock cannot demonstrate that — it would only
 * demonstrate that the mock was written to agree with the implementation.
 *
 * `pnpm test` therefore now needs the dev Postgres running:
 *     docker compose -f docker-compose.dev.yml up -d
 * CI already provisions a postgres:16 service and applies migrations before the
 * unit-test step, so this runs there unchanged.
 *
 * It FAILS rather than skips when there is no database. A suite that silently
 * skips its most important test is how a suite quietly stops testing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiEnv = join(here, "..", "..", ".env");
if (!process.env.DATABASE_URL && existsSync(apiEnv)) {
  process.loadEnvFile(apiEnv);
}
if (!process.env.DATABASE_URL) {
  throw new Error(
    "invites.test.ts needs DATABASE_URL. Start the dev database with " +
      "`docker compose -f docker-compose.dev.yml up -d`, or set DATABASE_URL.",
  );
}

// Imported AFTER the env is loaded: the Prisma singleton reads DATABASE_URL when
// it is constructed at module load, so a static import would run too early.
const { Role, prismaClient } = await import("@sketchsync/db");
const { acceptInvite, hashInviteToken, issueInvite, redeemInvite } = await import(
  "./invites.js"
);

const TAG = `invite-test-${Date.now()}`;
let ownerId = "";
let roomId = "";
const userIds: string[] = [];

async function makeUser(label: string): Promise<string> {
  const user = await prismaClient.user.create({
    data: { email: `${TAG}-${label}@local.test`, passwordHash: "x", name: label },
  });
  userIds.push(user.id);
  return user.id;
}

/** Mint an invite with sensible defaults; overrides applied afterwards. */
async function makeInvite(opts: {
  maxUses?: number;
  expiresInHours?: number;
  role?: (typeof Role)[keyof typeof Role];
}) {
  return issueInvite({
    roomId,
    createdBy: ownerId,
    role: opts.role ?? Role.EDITOR,
    expiresInHours: opts.expiresInHours ?? 24,
    maxUses: opts.maxUses ?? 1,
  });
}

beforeAll(async () => {
  ownerId = await makeUser("owner");
  const room = await prismaClient.room.create({
    data: { slug: `${TAG}-room`, name: "Invite test board", ownerId },
  });
  roomId = room.id;
  await prismaClient.roomMember.create({
    data: { roomId, userId: ownerId, role: Role.OWNER },
  });
});

afterAll(async () => {
  // Room cascade removes invites and memberships; users must go last because
  // Invite.createdBy and Room.ownerId are RESTRICT.
  await prismaClient.room.deleteMany({ where: { id: roomId } });
  await prismaClient.user.deleteMany({ where: { id: { in: userIds } } });
  await prismaClient.$disconnect();
});

describe("invite storage", () => {
  it("never stores the raw token — only its SHA-256", async () => {
    const { token, invite } = await makeInvite({});
    const stored = await prismaClient.invite.findUnique({
      where: { id: invite.id },
      select: { tokenHash: true },
    });
    expect(stored?.tokenHash).toBe(hashInviteToken(token));
    expect(stored?.tokenHash).not.toBe(token);
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // And the raw value appears nowhere in the row.
    const raw = await prismaClient.$queryRaw<
      { c: bigint }[]
    >`SELECT count(*) AS c FROM "Invite" WHERE "tokenHash" = ${token}`;
    expect(Number(raw[0]?.c ?? 0)).toBe(0);
  });
});

describe("atomic redemption", () => {
  it("TWO CONCURRENT REDEMPTIONS OF A SINGLE-USE INVITE: exactly one wins", async () => {
    // The acceptance criterion for the whole invite design. Fired with
    // Promise.all so both statements are in flight before either commits.
    const { token } = await makeInvite({ maxUses: 1 });

    const [a, b] = await Promise.all([redeemInvite(token), redeemInvite(token)]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ ok: false, reason: "exhausted" });

    const after = await prismaClient.invite.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: { usedCount: true },
    });
    expect(after?.usedCount).toBe(1); // never 2
  });

  it("holds under wider contention: 10 concurrent attempts on one use", async () => {
    const { token } = await makeInvite({ maxUses: 1 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => redeemInvite(token)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);

    const after = await prismaClient.invite.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: { usedCount: true },
    });
    expect(after?.usedCount).toBe(1);
  });

  it("honours a multi-use budget exactly — no over-spend under concurrency", async () => {
    const { token } = await makeInvite({ maxUses: 3 });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => redeemInvite(token)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);

    const after = await prismaClient.invite.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: { usedCount: true },
    });
    expect(after?.usedCount).toBe(3); // not 8, and not 4
  });

  it("returns the room and role the invite was minted for", async () => {
    const { token } = await makeInvite({ role: Role.VIEWER });
    const result = await redeemInvite(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.roomId).toBe(roomId);
      expect(result.value.role).toBe(Role.VIEWER);
    }
  });
});

describe("redemption refusals", () => {
  it("refuses an unknown token", async () => {
    expect(await redeemInvite("no-such-token")).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("refuses a revoked invite, and says so", async () => {
    const { token, invite } = await makeInvite({});
    await prismaClient.invite.update({
      where: { id: invite.id },
      data: { revokedAt: new Date() },
    });
    expect(await redeemInvite(token)).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("refuses an expired invite, judged by the DATABASE clock", async () => {
    const { token, invite } = await makeInvite({});
    await prismaClient.invite.update({
      where: { id: invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await redeemInvite(token)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("refuses once the use budget is spent", async () => {
    const { token } = await makeInvite({ maxUses: 1 });
    expect((await redeemInvite(token)).ok).toBe(true);
    expect(await redeemInvite(token)).toMatchObject({
      ok: false,
      reason: "exhausted",
    });
  });

  it("does not spend a use when it refuses", async () => {
    const { token, invite } = await makeInvite({ maxUses: 5 });
    await prismaClient.invite.update({
      where: { id: invite.id },
      data: { revokedAt: new Date() },
    });
    await redeemInvite(token);
    const after = await prismaClient.invite.findUnique({
      where: { id: invite.id },
      select: { usedCount: true },
    });
    expect(after?.usedCount).toBe(0);
  });
});

describe("acceptInvite — redemption plus membership", () => {
  it("creates the membership at the invite's role", async () => {
    const userId = await makeUser("accept-1");
    const { token } = await makeInvite({ role: Role.VIEWER });

    const result = await acceptInvite(token, userId);
    expect(result).toMatchObject({ ok: true, roomId, role: Role.VIEWER });

    const member = await prismaClient.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { role: true },
    });
    expect(member?.role).toBe(Role.VIEWER);
  });

  it("upgrades an existing member but NEVER demotes one", async () => {
    const userId = await makeUser("accept-2");

    const editor = await makeInvite({ role: Role.EDITOR });
    expect((await acceptInvite(editor.token, userId)).ok).toBe(true);

    // Redeeming a VIEWER link afterwards must not take edit rights away.
    const viewer = await makeInvite({ role: Role.VIEWER });
    const second = await acceptInvite(viewer.token, userId);
    expect(second).toMatchObject({ ok: true, role: Role.EDITOR });

    const member = await prismaClient.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { role: true },
    });
    expect(member?.role).toBe(Role.EDITOR);
  });

  it("two DIFFERENT users racing one single-use invite: only one gets in", async () => {
    const a = await makeUser("race-a");
    const b = await makeUser("race-b");
    const { token } = await makeInvite({ maxUses: 1 });

    const [ra, rb] = await Promise.all([
      acceptInvite(token, a),
      acceptInvite(token, b),
    ]);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);

    const members = await prismaClient.roomMember.count({
      where: { roomId, userId: { in: [a, b] } },
    });
    expect(members).toBe(1);
  });

  it("propagates the refusal reason instead of joining anyway", async () => {
    const userId = await makeUser("accept-3");
    const { token, invite } = await makeInvite({});
    await prismaClient.invite.update({
      where: { id: invite.id },
      data: { revokedAt: new Date() },
    });

    expect(await acceptInvite(token, userId)).toMatchObject({
      ok: false,
      reason: "revoked",
    });
    const member = await prismaClient.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    expect(member).toBeNull();
  });
});
