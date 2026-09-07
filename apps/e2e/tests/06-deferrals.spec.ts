import { expect, test } from "@playwright/test";
import {
  WEB_ORIGIN,
  cleanup,
  createRoom,
  createUser,
  joinRoom,
  seedElements,
  type SeededRoom,
  type SeededUser,
} from "../fixtures/seed.js";
import {
  contextFor,
  history,
  openBoard,
  scene,
  selectTool,
  waitForScene,
} from "../fixtures/board.js";

/** The three Phase 4.6 deferrals, one test each. */

let owner: SeededUser;
let editor: SeededUser;
let room: SeededRoom;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  owner = await createUser("def-owner");
  editor = await createUser("def-editor");
  // LINK, not the PRIVATE default: this file needs a second user in the board
  // but is not testing how they got there. Leaving it PRIVATE would make every
  // test here fail on invite plumbing that has nothing to do with what they
  // assert. Access acquisition itself is covered against PRIVATE boards.
  room = await createRoom(owner, "Deferrals board", { visibility: "LINK" });
  await joinRoom(editor, room.slug);
});

test.afterAll(async () => {
  await cleanup([room], [owner, editor]);
});

test("colour drag produces exactly ONE undo entry, and one undo reverts it", async ({
  browser,
}) => {
  // Its OWN room with a SEEDED rect: drawing through the canvas here would mix
  // draw-and-propagate timing into a test about undo-entry counting. Seeded
  // state is already persisted, so the shape cannot be swept by a re-sync.
  const solo = await createRoom(owner, "Colour board");
  await seedElements(solo, owner, [{ kind: "rect", x: 400, y: 400, w: 60, h: 50 }]);
  const ctx = await contextFor(browser, owner);
  const page = await openBoard(ctx, solo.slug);
  const seeded = await waitForScene(page, (s) => s.length >= 1);
  expect(seeded.length, "seeded rect must be present").toBe(1);

  // Select it. World (400,400) maps to screen (460,460) at the default viewport
  // (offset 60, scale 1); the rect is 60x50, so its middle is (490,485) —
  // clear of the style panel and the toolbar.
  await selectTool(page, "v");
  await page.mouse.click(490, 485);
  await expect(page.getByText("Selected")).toBeVisible();

  const before = await history(page);
  const originalStroke = (await scene(page))[0]!;
  expect(originalStroke).toBeTruthy();

  // Simulate a picker drag: several rapid onChange events, as <input
  // type="color"> fires while the pointer moves.
  const picker = page.getByTestId("stroke-color");
  for (const c of ["#ff0000", "#ee0000", "#dd0000", "#cc0000", "#bb0000"]) {
    await picker.evaluate((el, colour) => {
      const input = el as HTMLInputElement;
      // React keeps its own value tracker; assigning `.value` directly leaves it
      // unchanged, so React treats the event as a no-op and onChange never
      // fires. Going through the prototype setter updates the tracker too,
      // which is what a real user interaction does.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, colour);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, c);
    await page.waitForTimeout(30); // faster than the 350ms idle window
  }

  // The preview must have reached the scene — if it did not, the shape was
  // never selected and the rest of this test would pass vacuously.
  const previewed = (await scene(page))[0]!;
  expect(
    previewed.stroke,
    "precondition: the selected element's colour must be live-previewing",
  ).toBe("#bb0000");

  // Before the idle window elapses: live preview, but nothing committed.
  const mid = await history(page);
  expect(mid.past, "a drag in progress must not push history yet").toBe(before.past);

  // Let the debounce fire.
  await page.waitForTimeout(700);
  const after = await history(page);
  expect(
    after.past - before.past,
    "a whole colour drag must be exactly one undo entry",
  ).toBe(1);

  // And one undo fully reverts it.
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await scene(page))[0]!.version)
    .toBe(originalStroke.version);
  expect((await history(page)).past).toBe(before.past);
  await ctx.close();
  await cleanup([solo], []);
});

test("rename persists across reload, and a non-owner is refused", async ({ browser }) => {
  const NEW_NAME = "Renamed by owner";

  // Owner renames from the rooms list.
  const ownerCtx = await contextFor(browser, owner);
  const ownerPage = await ownerCtx.newPage();
  await ownerPage.goto(`${WEB_ORIGIN}/rooms`);
  await ownerPage.getByTestId(`rename-${room.slug}`).click();
  const input = ownerPage.getByTestId("rename-input");
  await expect(input).toBeVisible();
  await input.fill(NEW_NAME);
  await ownerPage.getByTestId("rename-save").click();
  await expect(ownerPage.getByText(NEW_NAME)).toBeVisible();

  // Persists across a full reload (i.e. it is server state, not local).
  await ownerPage.reload();
  await expect(ownerPage.getByText(NEW_NAME)).toBeVisible();

  // ...and in the board chrome on next load.
  const boardPage = await openBoard(ownerCtx, room.slug);
  await expect(boardPage.getByText(NEW_NAME)).toBeVisible();
  await boardPage.close();

  // A non-OWNER (joined as EDITOR) gets no rename control...
  const edCtx = await contextFor(browser, editor);
  const edPage = await edCtx.newPage();
  await edPage.goto(`${WEB_ORIGIN}/rooms`);
  await expect(edPage.getByText(NEW_NAME)).toBeVisible();
  await expect(edPage.getByTestId(`rename-${room.slug}`)).toHaveCount(0);

  // ...and the API refuses even if they call it directly.
  const status = await edPage.evaluate(async (slug) => {
    const r = await fetch(`/api/rooms/${slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Editor should not manage this" }),
      credentials: "include",
    });
    return r.status;
  }, room.slug);
  expect(status, "editors must not be able to rename someone else's board").toBe(403);

  // Name is unchanged on the server.
  await edPage.reload();
  await expect(edPage.getByText(NEW_NAME)).toBeVisible();
  await ownerCtx.close();
  await edCtx.close();
});

test("signed-in user hitting /signin lands on /rooms with no auth form ever painted", async ({
  browser,
}) => {
  const ctx = await contextFor(browser, owner);
  const page = await ctx.newPage();

  // Poll aggressively from first paint: if the form is ever mounted, catch it.
  let sawForm = false;
  const watcher = setInterval(() => {
    void page
      .evaluate(() => document.querySelector('input[type="password"]') !== null)
      .then((seen) => {
        if (seen) sawForm = true;
      })
      .catch(() => undefined);
  }, 20);

  await page.goto(`${WEB_ORIGIN}/signin`);
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toBe("/rooms");
  clearInterval(watcher);

  expect(sawForm, "the sign-in form must never be painted for a signed-in user").toBe(false);
  await expect(page.getByText("Your boards")).toBeVisible();

  // ?next= is honoured rather than always going to /rooms.
  const page2 = await ctx.newPage();
  await page2.goto(`${WEB_ORIGIN}/signin?next=${encodeURIComponent(`/room/${room.slug}`)}`);
  await expect
    .poll(() => new URL(page2.url()).pathname, { timeout: 20_000 })
    .toBe(`/room/${room.slug}`);

  await ctx.close();
});
