import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  WEB_ORIGIN,
  acceptInvite,
  cleanup,
  createInvite,
  createRoom,
  createUser,
  expireInvite,
  inviteUrl,
  removeMember,
  revokeInvite,
  setMemberRole,
  type SeededRoom,
  type SeededUser,
} from "../fixtures/seed.js";
import {
  boardUrl,
  contextFor,
  openBoard,
  waitForCanvas,
} from "../fixtures/board.js";

/**
 * Phase 3: who can open a board, how they get in, and what happens when that is
 * taken away.
 *
 * Everything here was manual-only until this file existed. The last two blocks
 * matter most: they are the first browser-level exercise of the api -> realtime
 * eviction call and of the terminal close code, neither of which any other
 * spec touches.
 */

let owner: SeededUser;
let privateRoom: SeededRoom;
let linkRoom: SeededRoom;
const rooms: SeededRoom[] = [];
const users: SeededUser[] = [];

/** Register for cleanup as we go — several tests mint their own participants. */
async function participant(label: string): Promise<SeededUser> {
  const u = await createUser(label);
  users.push(u);
  return u;
}

async function board(
  by: SeededUser,
  name: string,
  visibility?: "PRIVATE" | "LINK",
): Promise<SeededRoom> {
  const r = await createRoom(by, name, visibility ? { visibility } : {});
  rooms.push(r);
  return r;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  owner = await participant("acc-owner");
  // PRIVATE is the default and the production shape; spelled out here because
  // this file is precisely about the difference.
  privateRoom = await board(owner, "Private board", "PRIVATE");
  linkRoom = await board(owner, "Link board", "LINK");
});

test.afterAll(async () => {
  await cleanup(rooms, users);
});

// ───────────────────────────────────────────────────────────────────────────
// Reaching a board you are not a member of
// ───────────────────────────────────────────────────────────────────────────

test("a stranger on a PRIVATE board is refused, and offered no way in", async ({
  browser,
}) => {
  const stranger = await participant("acc-stranger-private");
  const ctx = await contextFor(browser, stranger);
  const page = await ctx.newPage();
  await page.goto(boardUrl(privateRoom.slug));

  await expect(page.getByTestId("no-access")).toBeVisible();
  await expect(
    page.getByTestId("no-access").getByText("You don't have access to this board"),
  ).toBeVisible();

  // THE REGRESSION THIS GUARDS. Every 403 used to render as "Join this board?",
  // so a private board offered a button that could only ever produce another
  // 403. There must be no join affordance at all.
  await expect(page.getByRole("button", { name: /join/i })).toHaveCount(0);
  await expect(page.locator("canvas")).toHaveCount(0);

  await ctx.close();
});

test("a stranger on a LINK board still gets the join prompt, and joining works", async ({
  browser,
}) => {
  const stranger = await participant("acc-stranger-link");
  const ctx = await contextFor(browser, stranger);
  const page = await ctx.newPage();
  await page.goto(boardUrl(linkRoom.slug));

  // The old behaviour, now opt-in rather than universal.
  await expect(page.getByText("Join this board?")).toBeVisible();
  await page.getByRole("button", { name: "Join board" }).click();

  await waitForCanvas(page);
  expect(page.url()).toContain(`/room/${linkRoom.slug}`);
  // Joined as EDITOR, so the drawing tools are live.
  await expect(page.getByTestId("tool-rect")).toBeEnabled();

  await ctx.close();
});

// ───────────────────────────────────────────────────────────────────────────
// Redeeming an invite
// ───────────────────────────────────────────────────────────────────────────

test("an EDITOR invite grants editing on a private board", async ({ browser }) => {
  const guest = await participant("acc-editor-invite");
  const invite = await createInvite(owner, privateRoom.slug, { role: "EDITOR" });

  const ctx = await contextFor(browser, guest);
  const page = await ctx.newPage();
  await page.goto(inviteUrl(invite.token));

  // Redeem -> redirect into the board, no join prompt in between.
  await waitForCanvas(page);
  expect(page.url()).toContain(`/room/${privateRoom.slug}`);
  await expect(page.getByTestId("tool-rect")).toBeEnabled();
  await expect(page.getByTestId("read-only-badge")).toHaveCount(0);

  await ctx.close();
});

test("a VIEWER invite grants read-only, with the drawing tools actually disabled", async ({
  browser,
}) => {
  const guest = await participant("acc-viewer-invite");
  const invite = await createInvite(owner, privateRoom.slug, { role: "VIEWER" });

  const ctx = await contextFor(browser, guest);
  const page = await ctx.newPage();
  await page.goto(inviteUrl(invite.token));

  await waitForCanvas(page);
  expect(page.url()).toContain(`/room/${privateRoom.slug}`);

  // The role has to reach the CANVAS, not just the membership row — this is the
  // half that used to be fetched and never read.
  await expect(page.getByTestId("read-only-badge")).toBeVisible();
  await expect(page.getByTestId("tool-rect")).toBeDisabled();
  await expect(page.getByTestId("tool-pencil")).toBeDisabled();
  await expect(page.getByTestId("tool-select")).toBeEnabled();

  await ctx.close();
});

test("the invite URL is spent: going back to it fails rather than re-joining", async ({
  browser,
}) => {
  const first = await participant("acc-single-a");
  const second = await participant("acc-single-b");
  const invite = await createInvite(owner, privateRoom.slug, { maxUses: 1 });

  const ctxA = await contextFor(browser, first);
  const pageA = await ctxA.newPage();
  await pageA.goto(inviteUrl(invite.token));
  await waitForCanvas(pageA);
  expect(pageA.url(), "the first redemption must succeed").toContain("/room/");
  await ctxA.close();

  // A DIFFERENT user, same link. The atomic redemption is unit-tested against
  // true concurrency; what matters here is that the second person is refused and
  // told why, rather than silently landing on a board they cannot open.
  const ctxB = await contextFor(browser, second);
  const pageB = await ctxB.newPage();
  await pageB.goto(inviteUrl(invite.token));
  await expect(pageB.getByTestId("invite-failed")).toBeVisible();
  await expect(pageB.getByTestId("invite-failed").getByText(/already been used/i)).toBeVisible();
  await expect(pageB.locator("canvas")).toHaveCount(0);
  await ctxB.close();
});

test("each invite failure says which one it was", async ({ browser }) => {
  // Expired, revoked and used-up are three different situations and a user can
  // act on each differently ("ask for a new one" vs "you already used this").
  // Flattening them into "invalid link" is the failure this pins.
  const guest = await participant("acc-failures");
  const ctx = await contextFor(browser, guest);
  const page = await ctx.newPage();

  const expired = await createInvite(owner, privateRoom.slug);
  await expireInvite(expired.id);
  await page.goto(inviteUrl(expired.token));
  await expect(page.getByTestId("invite-failed")).toBeVisible();
  await expect(page.getByTestId("invite-failed").getByText(/expired/i)).toBeVisible();

  const revoked = await createInvite(owner, privateRoom.slug);
  await revokeInvite(owner, privateRoom.slug, revoked.id);
  await page.goto(inviteUrl(revoked.token));
  await expect(page.getByTestId("invite-failed")).toBeVisible();
  await expect(page.getByTestId("invite-failed").getByText(/revoked/i)).toBeVisible();

  const spender = await participant("acc-spender");
  const used = await createInvite(owner, privateRoom.slug, { maxUses: 1 });
  const spent = await acceptInvite(spender, used.token);
  expect(spent.status, "setup: the first redemption must succeed").toBe(200);
  await page.goto(inviteUrl(used.token));
  await expect(page.getByTestId("invite-failed")).toBeVisible();
  await expect(page.getByTestId("invite-failed").getByText(/already been used/i)).toBeVisible();

  // A token that never existed reads differently again.
  await page.goto(inviteUrl("not-a-real-token-at-all"));
  await expect(page.getByTestId("invite-failed").getByText(/isn't valid/i)).toBeVisible();

  await ctx.close();
});

test("revoking an invite stops it working for the next person", async ({ browser }) => {
  // Multi-use, so the link is demonstrably still live when it is revoked —
  // otherwise this could pass against an invite that was simply used up.
  const invite = await createInvite(owner, privateRoom.slug, { maxUses: 5 });
  const before = await participant("acc-revoke-before");
  const after = await participant("acc-revoke-after");

  const firstUse = await acceptInvite(before, invite.token);
  expect(firstUse.status, "the invite must work before it is revoked").toBe(200);

  await revokeInvite(owner, privateRoom.slug, invite.id);

  const ctx = await contextFor(browser, after);
  const page = await ctx.newPage();
  await page.goto(inviteUrl(invite.token));
  await expect(page.getByTestId("invite-failed")).toBeVisible();
  await expect(page.getByTestId("invite-failed").getByText(/revoked/i)).toBeVisible();
  await ctx.close();
});

test("an invite link survives being sent through sign-in", async ({ browser }) => {
  const guest = await participant("acc-signin-return");
  const invite = await createInvite(owner, privateRoom.slug, { role: "EDITOR" });

  // A context with NO cookie: someone opening an invite link before signing in,
  // which is the ordinary case for a link sent by email.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(inviteUrl(invite.token));

  // The token must be carried through the redirect, not dropped. `<Protected>`
  // would have bounced to a bare /signin and lost it.
  await page.waitForURL(/\/signin\?next=/);
  expect(
    decodeURIComponent(page.url()),
    "the return path must still hold the token",
  ).toContain(`/invite/${invite.token}`);

  await page.getByLabel("Email").fill(guest.email);
  await page.getByLabel("Password").fill(guest.password);
  await page.getByRole("button", { name: /sign in/i }).click();

  // Back to the invite, redeemed, and into the board.
  await waitForCanvas(page);
  expect(page.url()).toContain(`/room/${privateRoom.slug}`);
  await ctx.close();
});

// ───────────────────────────────────────────────────────────────────────────
// The share panel
// ───────────────────────────────────────────────────────────────────────────

test("a non-owner sees who has access but NO owner controls", async ({ browser }) => {
  const member = await participant("acc-panel-member");
  const invite = await createInvite(owner, privateRoom.slug, { role: "EDITOR" });
  expect((await acceptInvite(member, invite.token)).status).toBe(200);

  const ctx = await contextFor(browser, member);
  const page = await openBoard(ctx, privateRoom.slug);
  await page.getByTestId("share-trigger").click();
  await expect(page.getByTestId("share-panel")).toBeVisible();

  // The member list IS visible to any member: presence and cursors already
  // disclose who is here, so hiding it would make the two views disagree.
  await expect(page.getByTestId("member-list")).toBeVisible();
  await expect(page.getByTestId("owner-badge")).toBeVisible();

  // ABSENT, not disabled. An affordance that cannot act is worse than none, and
  // a disabled control still tells a non-owner the feature is theirs to use.
  await expect(page.getByTestId("visibility-private")).toHaveCount(0);
  await expect(page.getByTestId("create-invite")).toHaveCount(0);
  await expect(page.locator('[data-testid^="remove-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="role-"]')).toHaveCount(0);

  await ctx.close();
});

// ───────────────────────────────────────────────────────────────────────────
// Access taken away while the board is open
//
// These two are the first browser-level exercise of the api -> realtime
// eviction call. Everything before this point would pass with that endpoint
// switched off entirely.
// ───────────────────────────────────────────────────────────────────────────

test("a demotion reaches an OPEN board and flips the toolbar, with no reload", async ({
  browser,
}) => {
  const member = await participant("acc-demote");
  const room = await board(owner, "Demotion board");
  const invite = await createInvite(owner, room.slug, { role: "EDITOR" });
  expect((await acceptInvite(member, invite.token)).status).toBe(200);

  const ctx: BrowserContext = await contextFor(browser, member);
  const page: Page = await openBoard(ctx, room.slug);
  await expect(page.getByTestId("tool-rect")).toBeEnabled();

  // A sentinel on `window`: any navigation wipes it, so its survival is proof
  // the toolbar changed in place rather than the page reloading.
  await page.evaluate(() => {
    (window as unknown as { __noReload?: boolean }).__noReload = true;
  });

  await setMemberRole(owner, room.slug, member.userId, "VIEWER");

  // The gateway rewrites conn.role and sends an `error` frame; the client
  // re-asks the API for its role and switches the UI.
  await expect(page.getByTestId("read-only-badge")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("tool-rect")).toBeDisabled();

  expect(
    await page.evaluate(
      () => (window as unknown as { __noReload?: boolean }).__noReload === true,
    ),
    "the page must not have reloaded",
  ).toBe(true);

  // A demotion is not a disconnect: they stay on the board, just read-only.
  expect(await page.evaluate(() => window.__sketchsync?.socketOpen())).toBe(true);

  await ctx.close();
});

test("a removal closes the socket, says why, and is NOT retried", async ({ browser }) => {
  const member = await participant("acc-evict");
  const room = await board(owner, "Eviction board");
  const invite = await createInvite(owner, room.slug, { role: "EDITOR" });
  expect((await acceptInvite(member, invite.token)).status).toBe(200);

  const ctx = await contextFor(browser, member);
  const page = await openBoard(ctx, room.slug);

  // Every connect attempt mints exactly one ticket, so this counter is how a
  // reconnect loop becomes visible.
  const ticketsBefore = await page.evaluate(
    () => window.__sketchsync?.ticketRequests() ?? 0,
  );

  await removeMember(owner, room.slug, member.userId);

  // Told why, and blocked from drawing into a board that is gone. A toast would
  // have let them keep working into a dead canvas.
  await expect(page.getByTestId("evicted-overlay")).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByTestId("evicted-overlay").getByText("You no longer have access to this board"),
  ).toBeVisible();

  expect(await page.evaluate(() => window.__sketchsync?.status())).toBe("evicted");
  expect(await page.evaluate(() => window.__sketchsync?.socketOpen())).toBe(false);

  // THE POINT OF THE CLOSE CODE. Without treating 4403 as terminal, the backoff
  // loop would reconnect immediately — minting a ticket each time and being
  // refused at `join`, several times a second at first. A fixed wait is right
  // here: this asserts that something does NOT happen, and there is no event for
  // that. Backoff starts at 500ms, so 4s would cover several attempts.
  await page.waitForTimeout(4000);
  const ticketsAfter = await page.evaluate(
    () => window.__sketchsync?.ticketRequests() ?? 0,
  );
  expect(
    ticketsAfter,
    "an evicted client must not fight the eviction by reconnecting",
  ).toBe(ticketsBefore);

  await ctx.close();
});

test("a removed member cannot get back in by reloading", async ({ browser }) => {
  // The eviction endpoint is best-effort and NOT the security boundary. This is
  // the boundary: membership is re-checked on every join, so the removal holds
  // even if the socket notification never landed.
  const member = await participant("acc-evict-reload");
  const room = await board(owner, "Re-entry board");
  const invite = await createInvite(owner, room.slug, { role: "EDITOR" });
  expect((await acceptInvite(member, invite.token)).status).toBe(200);

  await removeMember(owner, room.slug, member.userId);

  const ctx = await contextFor(browser, member);
  const page = await ctx.newPage();
  await page.goto(boardUrl(room.slug));

  await expect(page.getByTestId("no-access")).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(0);
  await ctx.close();
});

test("the rooms list drops a board once you are removed from it", async ({ browser }) => {
  const member = await participant("acc-evict-list");
  const room = await board(owner, "Listing board");
  const invite = await createInvite(owner, room.slug, { role: "EDITOR" });
  expect((await acceptInvite(member, invite.token)).status).toBe(200);

  const ctx = await contextFor(browser, member);
  const page = await ctx.newPage();
  await page.goto(`${WEB_ORIGIN}/rooms`);
  await expect(page.getByText("Listing board")).toBeVisible();

  await removeMember(owner, room.slug, member.userId);
  await page.reload();
  await expect(page.getByText("Listing board")).toHaveCount(0);

  await ctx.close();
});
