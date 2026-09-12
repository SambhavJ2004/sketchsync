import { expect, test } from "@playwright/test";
import {
  acceptInvite,
  cleanup,
  createInvite,
  createRoom,
  createUser,
  inviteUrl,
  inviteUsedCount,
  joinRoom,
  memberRole,
  type SeededRoom,
  type SeededUser,
} from "../fixtures/seed.js";
import { boardUrl, contextFor, waitForCanvas } from "../fixtures/board.js";

/**
 * REDEEMING AN INVITE WHEN YOU ARE ALREADY A MEMBER.
 *
 * This is the hole two bugs hid in. Every other spec redeems with a
 * freshly-created user who has never been a member of the room, so the
 * already-a-member branch was never executed — and inside it, a VIEWER invite
 * redeemed by an existing EDITOR reported success, redirected into the board,
 * SPENT A USE, and granted nothing, with no signal to anyone.
 *
 * The rules now, and what each test below pins:
 *   - higher or equal existing role -> no change, NO USE SPENT, reported
 *   - lower existing role           -> upgrade, use spent
 *   - board owner                   -> never touched
 *   - never-demote survives         -> a VIEWER link cannot strip EDITOR
 */

const rooms: SeededRoom[] = [];
const users: SeededUser[] = [];

async function participant(label: string): Promise<SeededUser> {
  const u = await createUser(label);
  users.push(u);
  return u;
}

async function board(
  by: SeededUser,
  name: string,
  opts: { visibility?: "PRIVATE" | "LINK"; linkRole?: "EDITOR" | "VIEWER" } = {},
): Promise<SeededRoom> {
  const r = await createRoom(by, name, opts);
  rooms.push(r);
  return r;
}

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await cleanup(rooms, users);
});

// ───────────────────────────────────────────────────────────────────────────
// Existing member at a HIGHER role — the reported bug
// ───────────────────────────────────────────────────────────────────────────

test("EDITOR redeeming a VIEWER invite: unchanged, no use spent, and told so", async ({
  browser,
}) => {
  const owner = await participant("ex-owner-higher");
  const room = await board(owner, "Higher role board", { visibility: "LINK" });

  const guest = await participant("ex-guest-higher");
  await joinRoom(guest, room.slug); // -> EDITOR, the ordinary way
  expect(await memberRole(room.id, guest.userId)).toBe("EDITOR");

  const invite = await createInvite(owner, room.slug, { role: "VIEWER", maxUses: 1 });

  const ctx = await contextFor(browser, guest);
  const page = await ctx.newPage();
  await page.goto(inviteUrl(invite.token));
  await waitForCanvas(page);

  // NEVER-DEMOTE: a view-only link must not strip an editor's access. If it
  // could, anyone holding one could downgrade a colleague.
  expect(
    await memberRole(room.id, guest.userId),
    "a VIEWER invite must not demote an existing EDITOR",
  ).toBe("EDITOR");

  // NO USE SPENT. This is the half that made the bug expensive: a single-use
  // link burnt on a no-op would tell the next person it was "already used".
  expect(
    await inviteUsedCount(invite.id),
    "a redemption that changed nothing must not consume a use",
  ).toBe(0);

  // AND THE USER IS TOLD. Silence is what let this go unnoticed.
  await expect(page.getByText(/already an Editor/i)).toBeVisible();

  // Still lands in the board, editing intact.
  expect(page.url()).toContain(`/room/${room.slug}`);
  await expect(page.getByTestId("tool-rect")).toBeEnabled();

  await ctx.close();
});

test("the unspent invite still works for the person it was meant for", async ({
  browser,
}) => {
  // The consequence of not spending a use, stated as its own assertion: the
  // single-use link survives the no-op and grants access to a new person.
  const owner = await participant("ex-owner-survives");
  const room = await board(owner, "Survives board", { visibility: "LINK" });

  const existing = await participant("ex-existing");
  await joinRoom(existing, room.slug); // -> EDITOR

  const invite = await createInvite(owner, room.slug, { role: "VIEWER", maxUses: 1 });

  // Burnt on a no-op under the old behaviour.
  expect((await acceptInvite(existing, invite.token)).status).toBe(200);
  expect(await inviteUsedCount(invite.id)).toBe(0);

  const intended = await participant("ex-intended");
  const ctx = await contextFor(browser, intended);
  const page = await ctx.newPage();
  await page.goto(inviteUrl(invite.token));
  await waitForCanvas(page);

  expect(await memberRole(room.id, intended.userId)).toBe("VIEWER");
  expect(await inviteUsedCount(invite.id)).toBe(1);
  await expect(page.getByTestId("read-only-badge")).toBeVisible();

  await ctx.close();
});

// ───────────────────────────────────────────────────────────────────────────
// Existing member at an EQUAL role
// ───────────────────────────────────────────────────────────────────────────

test("EDITOR redeeming an EDITOR invite: no change, no use spent", async ({
  browser,
}) => {
  const owner = await participant("ex-owner-equal");
  const room = await board(owner, "Equal role board", { visibility: "LINK" });

  const guest = await participant("ex-guest-equal");
  await joinRoom(guest, room.slug); // -> EDITOR

  const invite = await createInvite(owner, room.slug, { role: "EDITOR", maxUses: 1 });

  const ctx = await contextFor(browser, guest);
  const page = await ctx.newPage();
  await page.goto(inviteUrl(invite.token));
  await waitForCanvas(page);

  expect(await memberRole(room.id, guest.userId)).toBe("EDITOR");
  expect(
    await inviteUsedCount(invite.id),
    "an invite granting what you already have is not a use",
  ).toBe(0);
  await expect(page.getByText(/already an Editor/i)).toBeVisible();

  await ctx.close();
});

// ───────────────────────────────────────────────────────────────────────────
// Existing member at a LOWER role — the one case that SHOULD change
// ───────────────────────────────────────────────────────────────────────────

test("VIEWER redeeming an EDITOR invite: upgraded, and the use IS spent", async ({
  browser,
}) => {
  const owner = await participant("ex-owner-lower");
  // Link grants VIEWER, so the guest starts genuinely read-only.
  const room = await board(owner, "Lower role board", {
    visibility: "LINK",
    linkRole: "VIEWER",
  });

  const guest = await participant("ex-guest-lower");
  await joinRoom(guest, room.slug);
  expect(
    await memberRole(room.id, guest.userId),
    "a view-only link must grant VIEWER, not EDITOR",
  ).toBe("VIEWER");

  const invite = await createInvite(owner, room.slug, { role: "EDITOR", maxUses: 1 });

  const ctx = await contextFor(browser, guest);
  const page = await ctx.newPage();
  await page.goto(inviteUrl(invite.token));
  await waitForCanvas(page);

  expect(await memberRole(room.id, guest.userId)).toBe("EDITOR");
  expect(
    await inviteUsedCount(invite.id),
    "a real upgrade must consume a use",
  ).toBe(1);

  // The upgrade reaches the canvas, not just the row.
  await expect(page.getByTestId("tool-rect")).toBeEnabled();
  await expect(page.getByTestId("read-only-badge")).toHaveCount(0);
  await expect(page.getByText(/Viewer to Editor/i)).toBeVisible();

  await ctx.close();
});

// ───────────────────────────────────────────────────────────────────────────
// The board owner
// ───────────────────────────────────────────────────────────────────────────

test("the OWNER redeeming their own VIEWER invite stays OWNER", async ({ browser }) => {
  // OWNER outranks every invite role, so the same-or-higher branch covers this —
  // but an owner who accidentally opens their own view-only link must not lock
  // themselves out of their own board, so it is pinned separately.
  const owner = await participant("ex-owner-self");
  const room = await board(owner, "Owner self board");

  const invite = await createInvite(owner, room.slug, { role: "VIEWER", maxUses: 1 });

  const ctx = await contextFor(browser, owner);
  const page = await ctx.newPage();
  await page.goto(inviteUrl(invite.token));
  await waitForCanvas(page);

  expect(await memberRole(room.id, owner.userId)).toBe("OWNER");
  expect(await inviteUsedCount(invite.id)).toBe(0);
  await expect(page.getByTestId("tool-rect")).toBeEnabled();
  // Owner controls still there — they did not demote themselves by clicking a link.
  await page.getByTestId("share-trigger").click();
  await expect(page.getByTestId("create-invite")).toBeVisible();

  await ctx.close();
});

// ───────────────────────────────────────────────────────────────────────────
// linkRole: what "anyone with the link" actually grants
// ───────────────────────────────────────────────────────────────────────────

test("a linkRole VIEWER board grants VIEWER on join, not EDITOR", async ({ browser }) => {
  // Before linkRole existed, "anyone with the link" always meant "can edit",
  // which is what made a VIEWER invite on a LINK board pointless: the recipient
  // could ignore it, open the board URL and click Join for edit rights.
  const owner = await participant("link-owner-viewer");
  const room = await board(owner, "View-only link board", {
    visibility: "LINK",
    linkRole: "VIEWER",
  });

  const stranger = await participant("link-stranger-viewer");
  const ctx = await contextFor(browser, stranger);
  const page = await ctx.newPage();
  await page.goto(boardUrl(room.slug));

  await expect(page.getByText("Join this board?")).toBeVisible();
  await page.getByRole("button", { name: "Join board" }).click();
  await waitForCanvas(page);

  expect(await memberRole(room.id, stranger.userId)).toBe("VIEWER");
  await expect(page.getByTestId("read-only-badge")).toBeVisible();
  await expect(page.getByTestId("tool-rect")).toBeDisabled();

  await ctx.close();
});

test("a linkRole EDITOR board still grants EDITOR (the default is unchanged)", async ({
  browser,
}) => {
  // The migration defaults linkRole to EDITOR precisely so existing LINK boards
  // behave exactly as they did. This pins that no-change default.
  const owner = await participant("link-owner-editor");
  const room = await board(owner, "Editable link board", { visibility: "LINK" });

  const stranger = await participant("link-stranger-editor");
  const ctx = await contextFor(browser, stranger);
  const page = await ctx.newPage();
  await page.goto(boardUrl(room.slug));

  await page.getByRole("button", { name: "Join board" }).click();
  await waitForCanvas(page);

  expect(await memberRole(room.id, stranger.userId)).toBe("EDITOR");
  await expect(page.getByTestId("tool-rect")).toBeEnabled();

  await ctx.close();
});

test("the owner can switch what the link grants, from the share panel", async ({
  browser,
}) => {
  const owner = await participant("link-owner-toggle");
  const room = await board(owner, "Toggle board", { visibility: "LINK" });

  const ctx = await contextFor(browser, owner);
  const page = await ctx.newPage();
  await page.goto(boardUrl(room.slug));
  await waitForCanvas(page);

  await page.getByTestId("share-trigger").click();
  await expect(page.getByTestId("link-role-editor")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByTestId("link-role-viewer").click();
  await expect(page.getByTestId("link-role-viewer")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Persisted, not just local state: a new joiner gets the new role.
  const joiner = await participant("link-joiner-after-toggle");
  const ctx2 = await contextFor(browser, joiner);
  const page2 = await ctx2.newPage();
  await page2.goto(boardUrl(room.slug));
  await page2.getByRole("button", { name: "Join board" }).click();
  await waitForCanvas(page2);
  expect(await memberRole(room.id, joiner.userId)).toBe("VIEWER");

  await ctx2.close();
  await ctx.close();
});
