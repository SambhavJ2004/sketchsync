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
  contextFor,
  boardUrl,
  drawRect,
  openBoard,
  scene,
  waitForCanvas,
  waitForScene,
  waitForSocket,
} from "../fixtures/board.js";

/**
 * THE GAP TEST.
 *
 * The canvas attaches pointer listeners synchronously when the effect runs, but
 * the socket now needs a ticket fetch (~134ms) plus a handshake (~103ms) before
 * it exists. `RealtimeClient.send()` silently no-ops while `this.ws` is null.
 *
 * So the question this asks is: can a user commit a shape into a live-looking
 * canvas before the socket exists, and have it vanish from everyone else's view?
 */

let owner: SeededUser;
let peer: SeededUser;
let room: SeededRoom;

test.beforeEach(async () => {
  owner = await createUser("gap-owner");
  peer = await createUser("gap-peer");
  room = await createRoom(owner, "gap board");
  await joinRoom(peer, room.slug);
});

test.afterEach(async () => {
  await cleanup([room], [owner, peer]);
});

test("a shape drawn before the socket opens still reaches the other client", async ({
  browser,
}) => {
  const ctxB = await contextFor(browser, peer);
  const pageB = await openBoard(ctxB, room.slug); // B is fully live first

  const ctxA = await contextFor(browser, owner);
  const pageA = await ctxA.newPage();

  // Hold the ticket request open so the gap is DETERMINISTIC and wide enough to
  // drive. Without this the window is ~114ms on a warm local machine — shorter
  // than Playwright's own navigation overhead — so the test would pass while
  // never once exercising the condition it exists to check. A slow mobile
  // network produces exactly this delay for real.
  await pageA.route("**/api/auth/ws-ticket", async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });

  await pageA.goto(boardUrl(room.slug));

  // Wait ONLY for the canvas to be interactive — deliberately NOT for the
  // socket. This is exactly what a fast user does.
  await waitForCanvas(pageA);
  const socketOpenAtDraw = await pageA.evaluate(
    () => window.__sketchsync?.socketOpen() ?? false,
  );
  expect(
    socketOpenAtDraw,
    "precondition: the socket must still be closed, or this test proves nothing",
  ).toBe(false);

  await drawRect(pageA, { x: 300, y: 300 }, { x: 420, y: 400 });

  // It is in A's own scene regardless — the client renders optimistically.
  const localA = await waitForScene(pageA, (s) => s.length >= 1, 5_000);
  expect(localA.length, "A must render its own shape optimistically").toBe(1);

  // Let the socket finish coming up, then give propagation ample time.
  await waitForSocket(pageA);
  const remote = await waitForScene(pageB, (s) => s.length >= 1, 15_000);

  console.log(
    `[gap] socket open at draw time: ${socketOpenAtDraw}; ` +
      `A local=${localA.length}, B received=${remote.length}`,
  );

  expect(
    remote.length,
    "a shape committed before the socket opened was silently dropped — " +
      "it exists in A's scene but never reached B",
  ).toBe(1);
});

test("the same shape drawn AFTER the socket opens propagates (control)", async ({
  browser,
}) => {
  const ctxB = await contextFor(browser, peer);
  const pageB = await openBoard(ctxB, room.slug);
  const ctxA = await contextFor(browser, owner);
  const pageA = await openBoard(ctxA, room.slug); // waits for socket

  await drawRect(pageA, { x: 300, y: 300 }, { x: 420, y: 400 });
  await waitForScene(pageA, (s) => s.length >= 1);
  const remote = await waitForScene(pageB, (s) => s.length >= 1);
  expect(remote.length).toBe(1);
  expect((await scene(pageA)).length).toBe(1);
});

test("measures how long the canvas accepts input before the socket is live", async ({
  browser,
}) => {
  const ctxA = await contextFor(browser, owner);
  const pageA = await ctxA.newPage();
  await pageA.goto(boardUrl(room.slug));

  const t0 = Date.now();
  await waitForCanvas(pageA);
  const canvasMs = Date.now() - t0;
  await waitForSocket(pageA);
  const socketMs = Date.now() - t0;

  console.log(
    `[gap] canvas interactive at ${canvasMs}ms, socket open at ${socketMs}ms, ` +
      `window = ${socketMs - canvasMs}ms`,
  );
  // Reporting only — the assertion that matters is the first test.
  expect(socketMs).toBeGreaterThan(0);
});
