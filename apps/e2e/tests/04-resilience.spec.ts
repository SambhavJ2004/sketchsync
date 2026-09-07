import { expect, test } from "@playwright/test";
import {
  cleanup,
  createRoom,
  createUser,
  joinRoom,
  type SeededRoom,
  type SeededUser,
} from "../fixtures/seed.js";
import {
  boardUrl,
  contextFor,
  drawRect,
  dropSocket,
  openBoard,
  scene,
  waitForCanvas,
  waitForScene,
  waitForSocket,
} from "../fixtures/board.js";

/**
 * Failure-mode behaviour. These do NOT stop real services — killing the API or
 * gateway mid-suite makes every later test flaky and the processes are shared.
 * Instead each failure is produced at the network layer with page.route /
 * CDP offline, which is deterministic and scoped to one context.
 */

let owner: SeededUser;
let peer: SeededUser;
let room: SeededRoom;

test.beforeAll(async () => {
  owner = await createUser("res-a");
  peer = await createUser("res-b");
  // LINK, not the PRIVATE default: this file needs a second user in the board
  // but is not testing how they got there. Leaving it PRIVATE would make every
  // test here fail on invite plumbing that has nothing to do with what they
  // assert. Access acquisition itself is covered against PRIVATE boards.
  room = await createRoom(owner, "resilience board", { visibility: "LINK" });
  await joinRoom(peer, room.slug);
});
test.afterAll(async () => {
  await cleanup([room], [owner, peer]);
});

test("session gone is terminal: redirect to /signin?next=<board>, retries stop", async ({
  browser,
}) => {
  const ctx = await contextFor(browser, owner);
  const page = await ctx.newPage();

  // Ticket issuance 401 == the session is gone. This is the ONLY signal the
  // client can read, because a browser cannot see a failed handshake's status.
  //
  // /auth/me is 401'd TOO, because that is what "the session is gone" actually
  // means: one dead cookie fails both. Mocking only the ticket endpoint would
  // simulate an impossible state — signed out for the socket, signed in for the
  // app — in which /signin correctly bounces the still-authenticated user
  // straight back to the board.
  const unauthorized = (route: import("@playwright/test").Route): Promise<void> =>
    route.fulfill({ status: 401, body: JSON.stringify({ message: "Not authenticated" }) });
  await page.route("**/api/auth/ws-ticket", unauthorized);
  await page.route("**/api/auth/me", unauthorized);

  await page.goto(boardUrl(room.slug)).catch(() => undefined);
  // The client redirects with window.location, which can abort the pending
  // navigation; poll the URL instead of racing waitForURL against it.
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
    .toBe("/signin");
  const url = new URL(page.url());
  expect(url.pathname).toBe("/signin");
  expect(url.searchParams.get("next")).toBe(`/room/${room.slug}`);

  // And it must STOP: no further ticket attempts after the terminal 401.
  let attempts = 0;
  page.on("request", (r) => {
    if (r.url().includes("/auth/ws-ticket")) attempts += 1;
  });
  await page.waitForTimeout(4000);
  expect(attempts, "must not keep retrying after a terminal 401").toBe(0);
  await ctx.close();
});

test("API unreachable is NOT signed out: failure panel, no redirect, recovers", async ({
  browser,
}) => {
  const ctx = await contextFor(browser, owner);
  const page = await ctx.newPage();

  let apiDown = true;
  await page.route("**/api/auth/me", async (route) => {
    if (apiDown) return route.fulfill({ status: 500, body: JSON.stringify({ message: "boom" }) });
    return route.continue();
  });

  await page.goto(`${boardUrl(room.slug)}`);
  await expect(page.getByText("Can't reach SketchSync")).toBeVisible({ timeout: 20_000 });
  expect(page.url(), "an unreachable API must NOT bounce to /signin").not.toContain("/signin");
  await expect(page.getByText("You have not been signed out")).toBeVisible();

  apiDown = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await waitForCanvas(page);
  expect(page.url()).toContain(`/room/${room.slug}`);
  await ctx.close();
});

test("reconnect: local drawing survives, and a fresh ticket is fetched per attempt", async ({
  browser,
}) => {
  const ctx = await contextFor(browser, owner);
  const page = await openBoard(ctx, room.slug);
  const ticketsAfterConnect = await page.evaluate(
    () => window.__sketchsync?.ticketRequests() ?? 0,
  );
  expect(ticketsAfterConnect).toBeGreaterThanOrEqual(1);

  await dropSocket(page);

  // Local drawing must still work while disconnected.
  const before = (await scene(page)).length;
  await drawRect(page, { x: 250, y: 500 }, { x: 320, y: 560 });
  const local = await waitForScene(page, (s) => s.length === before + 1);
  expect(local.length, "canvas must stay usable offline").toBe(before + 1);

  await waitForSocket(page);
  const ticketsAfterReconnect = await page.evaluate(
    () => window.__sketchsync?.ticketRequests() ?? 0,
  );
  expect(
    ticketsAfterReconnect,
    "every connect attempt must mint a fresh single-use ticket",
  ).toBeGreaterThan(ticketsAfterConnect);
  await ctx.close();
});

test("DEFERRAL PINNED: mutations made while disconnected are NOT flushed on reconnect", async ({
  browser,
}) => {
  // The connect-window queue is INITIAL CONNECT ONLY. Replaying mutations made
  // during a disconnect would need version reconciliation against a re-sync that
  // wholesale-replaces the scene and clears history — that is the offline-queue
  // deferral. This test exists so nobody "fixes" it by accident: if someone
  // makes the queue survive reconnects, this fails and they must think about
  // reconciliation first.
  // Its OWN room. Other tests in this file also draw while disconnected, and
  // whether those land is timing-dependent — sharing a room would import that
  // nondeterminism into an assertion about something NOT arriving.
  // LINK for the same reason as the shared room above: the peer just needs to be
  // in the board, and this test is about a mutation NOT arriving.
  const solo = await createRoom(owner, "deferral board", { visibility: "LINK" });
  await joinRoom(peer, solo.slug);
  const ctxA = await contextFor(browser, owner);
  const ctxB = await contextFor(browser, peer);
  const A = await openBoard(ctxA, solo.slug);
  const B = await openBoard(ctxB, solo.slug);
  const baseline = (await scene(B)).length;
  expect(baseline, "a fresh room starts empty").toBe(0);

  // Hold the socket DOWN for the whole draw. Reconnect backoff is 500ms while a
  // multi-step drag takes longer, so without this the shape can commit after the
  // socket is already back and the test races itself into a false pass.
  let blockTickets = true;
  await A.route("**/api/auth/ws-ticket", async (route) => {
    if (blockTickets) return route.abort();
    return route.continue();
  });

  await dropSocket(A);
  await drawRect(A, { x: 600, y: 500 }, { x: 660, y: 560 });
  await waitForScene(A, (s) => s.length > 0);
  // Assert the precondition rather than assuming it.
  expect(
    await A.evaluate(() => window.__sketchsync?.socketOpen() ?? false),
    "precondition: socket must still be down when the mutation commits",
  ).toBe(false);

  blockTickets = false;
  await waitForSocket(A);
  // Generous settle: we are asserting something does NOT arrive.
  await B.waitForTimeout(5000);

  expect(
    (await scene(B)).length,
    "documented deferral: an offline mutation is dropped, not replayed",
  ).toBe(baseline);
  // A's own view is corrected by the re-sync that follows reconnect.
  expect((await scene(A)).length).toBe(baseline);
  await ctxA.close();
  await ctxB.close();
  await cleanup([solo], []);
});
