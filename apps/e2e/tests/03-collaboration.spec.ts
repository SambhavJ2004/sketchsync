import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { MAX_TEXT_LENGTH } from "@sketchsync/shared";
import {
  cleanup,
  createRoom,
  createUser,
  joinRoom,
  seedElements,
  rects,
  type SeededRoom,
  type SeededUser,
} from "../fixtures/seed.js";
import {
  contextFor,
  drawDrag,
  drawRect,
  openBoard,
  scene,
  selectTool,
  waitForScene,
  history,
} from "../fixtures/board.js";

/**
 * Collaboration + regression coverage.
 *
 * RUNTIME: contexts and pages are created ONCE in beforeAll and reused. A board
 * load costs ~4-6s (Next dev + ticket + sync), so per-test loads dominated the
 * first draft of this suite. Sharing them keeps the whole file to a handful of
 * loads instead of two per test. Tests therefore must not leave global UI state
 * behind — each selects its own tool and works on its own coordinates.
 */

let owner: SeededUser;
let peer: SeededUser;
let room: SeededRoom;
let ctxA: BrowserContext;
let ctxB: BrowserContext;
let A: Page;
let B: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  owner = await createUser("collab-a");
  peer = await createUser("collab-b");
  // LINK, not the PRIVATE default: this file needs a second user in the board
  // but is not testing how they got there. Leaving it PRIVATE would make every
  // test here fail on invite plumbing that has nothing to do with what they
  // assert. Access acquisition itself is covered against PRIVATE boards.
  room = await createRoom(owner, "collab board", { visibility: "LINK" });
  await joinRoom(peer, room.slug);
  ctxA = await contextFor(browser, owner);
  ctxB = await contextFor(browser, peer);
  A = await openBoard(ctxA, room.slug);
  B = await openBoard(ctxB, room.slug);
});

test.afterAll(async () => {
  await ctxA?.close();
  await ctxB?.close();
  await cleanup([room], [owner, peer]);
});

test("every drawing tool propagates to the other context", async () => {
  const before = (await scene(A)).length;

  await drawRect(A, { x: 200, y: 200 }, { x: 280, y: 260 });
  await selectTool(A, "o");
  await drawDrag(A, { x: 320, y: 200 }, { x: 400, y: 260 });
  await selectTool(A, "l");
  await drawDrag(A, { x: 440, y: 200 }, { x: 520, y: 260 });
  await selectTool(A, "a");
  await drawDrag(A, { x: 560, y: 200 }, { x: 640, y: 260 });
  await selectTool(A, "p");
  await drawDrag(A, { x: 200, y: 320 }, { x: 300, y: 380 }, 12);

  const expected = before + 5;
  const local = await waitForScene(A, (s) => s.length >= expected);
  const remote = await waitForScene(B, (s) => s.length >= expected);
  expect(local.length).toBe(expected);
  expect(remote.length).toBe(expected);

  const types = new Set(remote.map((e) => e.type));
  for (const t of ["rect", "ellipse", "line", "arrow", "pencil"]) {
    expect(types, `${t} must have propagated`).toContain(t);
  }
});

test("move, resize and delete propagate", async () => {
  const start = await scene(A);
  const target = start.find((e) => e.type === "rect");
  expect(target, "need a rect from the previous test").toBeTruthy();
  const v0 = target!.version;

  // Move it: select tool, drag from inside the shape.
  await selectTool(A, "v");
  await drawDrag(A, { x: 240, y: 230 }, { x: 260, y: 250 });
  const moved = await waitForScene(
    B,
    (s) => (s.find((e) => e.id === target!.id)?.version ?? 0) > v0,
  );
  expect(moved.find((e) => e.id === target!.id)!.version).toBeGreaterThan(v0);

  // Delete it.
  const n = (await scene(A)).length;
  await A.keyboard.press("Delete");
  const afterA = await waitForScene(A, (s) => s.length === n - 1);
  const afterB = await waitForScene(B, (s) => s.length === n - 1);
  expect(afterA.length).toBe(n - 1);
  expect(afterB.length).toBe(n - 1);
  expect(afterB.find((e) => e.id === target!.id)).toBeUndefined();
});

test("undo and redo work locally", async () => {
  await selectTool(A, "r");
  const n = (await scene(A)).length;
  await drawDrag(A, { x: 700, y: 400 }, { x: 760, y: 450 });
  await waitForScene(A, (s) => s.length === n + 1);
  const h = await history(A);
  expect(h.past).toBeGreaterThan(0);

  await A.keyboard.press("Control+z");
  const undone = await waitForScene(A, (s) => s.length === n);
  expect(undone.length).toBe(n);

  await A.keyboard.press("Control+Shift+z");
  const redone = await waitForScene(A, (s) => s.length === n + 1);
  expect(redone.length).toBe(n + 1);
});

test("layer nudge changes z-order identically in both contexts", async () => {
  await selectTool(A, "v");
  const before = await scene(A);
  expect(before.length).toBeGreaterThan(2);
  // Click the last-drawn element (topmost) to select it.
  await A.mouse.click(730, 425);
  await A.keyboard.press("Control+BracketLeft");

  // Order must converge and match between the two contexts.
  const orderOf = (s: { id: string }[]): string => s.map((e) => e.id).join(",");
  const target = orderOf(await waitForScene(A, (s) => s.length === before.length));
  await waitForScene(B, (s) => orderOf(s) === target, 20_000);
  expect(orderOf(await scene(B)), "z-order must match A").toBe(target);
});

test("text ceiling: input stops at MAX_TEXT_LENGTH", async () => {
  await selectTool(A, "t");
  await A.mouse.click(900, 500);
  const input = A.locator('input[placeholder="Type…"]');
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("maxlength", String(MAX_TEXT_LENGTH));

  // Paste well over the cap; the field must clamp.
  await input.fill("x".repeat(MAX_TEXT_LENGTH + 500));
  const value = await input.inputValue();
  expect(value.length).toBe(MAX_TEXT_LENGTH);
  await A.keyboard.press("Escape");
});

test("seeded 150-element board renders and matches in both contexts", async ({
  browser,
}) => {
  const u = await createUser("big");
  const r = await createRoom(u, "big board");
  await seedElements(r, u, rects(150));
  const c = await contextFor(browser, u);
  const p = await openBoard(c, r.slug);
  const s = await waitForScene(p, (x) => x.length >= 150, 30_000);
  expect(s.length).toBe(150);
  // zIndex must be strictly ascending and distinct — the advisory-lock invariant.
  const zs = s.map((e) => e.zIndex);
  expect(new Set(zs).size, "no duplicate zIndex").toBe(zs.length);
  for (let i = 1; i < zs.length; i++) expect(zs[i]!).toBeGreaterThan(zs[i - 1]!);
  await c.close();
  await cleanup([r], [u]);
});
