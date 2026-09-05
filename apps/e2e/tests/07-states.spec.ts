import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import {
  WEB_ORIGIN,
  addMember,
  cleanup,
  createRoom,
  createUser,
  seedElements,
  type SeededRoom,
  type SeededUser,
} from "../fixtures/seed.js";
import {
  contextFor,
  drawDrag,
  drawRect,
  dropSocket,
  openBoard,
  scene,
  selectTool,
  waitForScene,
  waitForSocket,
} from "../fixtures/board.js";

/**
 * Phase 4.7: the states a user is actually in when something is wrong —
 * read-only access, a dead socket, a dropped write, a failed list load.
 *
 * Every one of these was previously invisible: the VIEWER lost work silently,
 * the socket dropped silently, and a failed /rooms load rendered as an empty
 * account.
 */

let owner: SeededUser;
let viewer: SeededUser;
let room: SeededRoom;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  owner = await createUser("st-owner");
  viewer = await createUser("st-viewer");
  room = await createRoom(owner, "States board");
  // VIEWER cannot be produced through HTTP — the only join route is the open
  // share link, which always grants EDITOR.
  await addMember(viewer, room, "VIEWER");
  await seedElements(room, owner, [{ kind: "rect", x: 400, y: 400, w: 60, h: 50 }]);
});

test.afterAll(async () => {
  await cleanup([room], [owner, viewer]);
});

test("VIEWER: told why, drawing tools disabled, and a drag commits nothing", async ({
  browser,
}) => {
  const ctx = await contextFor(browser, viewer);
  const page = await openBoard(ctx, room.slug);
  const seeded = await waitForScene(page, (s) => s.length >= 1);
  expect(seeded.length, "the seeded rect must have synced").toBe(1);

  // Told why, persistently — not a toast that disappears.
  await expect(page.getByTestId("read-only-badge")).toBeVisible();
  await expect(page.getByText("View only")).toBeVisible();

  // Drawing tools are visibly withheld rather than missing.
  await expect(page.getByTestId("tool-rect")).toBeDisabled();
  await expect(page.getByTestId("tool-pencil")).toBeDisabled();
  await expect(page.getByTestId("tool-select")).toBeEnabled();
  await expect(page.getByTestId("tool-pan")).toBeEnabled();

  // The keyboard is the other entry point, and it bypasses the disabled button.
  await selectTool(page, "r");
  await expect(page.getByTestId("tool-select")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("tool-rect")).toHaveAttribute("aria-pressed", "false");

  // The actual regression: a drag must not enter the scene. Before this, it
  // rendered, was refused by the gateway, and vanished on reload.
  await drawDrag(page, { x: 700, y: 300 }, { x: 780, y: 380 });
  await page.waitForTimeout(500);
  expect(
    (await scene(page)).length,
    "a read-only client must never render work the server will refuse",
  ).toBe(1);

  // Nor may a move commit: select the seeded rect and drag it.
  const before = (await scene(page))[0]!;
  await page.mouse.click(490, 485);
  await drawDrag(page, { x: 490, y: 485 }, { x: 590, y: 585 });
  await page.waitForTimeout(500);
  const after = (await scene(page))[0]!;
  expect(after.version, "a read-only move must not bump a version").toBe(before.version);
  await ctx.close();
});

test.describe("disconnected board", () => {
  let page: Page;
  let ctx: BrowserContext;
  let blocked = true;

  test.afterAll(async () => {
    await ctx.close();
  });

  test.beforeAll(async ({ browser }) => {
    ctx = await contextFor(browser, owner);
    page = await openBoard(ctx, room.slug);
    // Hold the socket DOWN for the whole block: reconnect backoff is 500ms, so
    // without this the socket can be back before the assertion runs.
    await page.route("**/api/auth/ws-ticket", async (route: Route) => {
      if (blocked) return route.abort();
      return route.continue();
    });
  });

  test("a dropped socket is visible, and says what it costs", async () => {
    await expect(page.getByTestId("connection-status")).toHaveCount(0);
    blocked = true;
    await dropSocket(page);

    const indicator = page.getByTestId("connection-status");
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveAttribute("data-status", "closed");
    await expect(indicator).toContainText("Reconnecting");
    await expect(indicator).toContainText("will not be saved");
  });

  test("a mutation made while disconnected raises a toast", async () => {
    expect(
      await page.evaluate(() => window.__sketchsync?.socketOpen() ?? true),
      "precondition: the socket must still be down",
    ).toBe(false);

    const before = (await scene(page)).length;
    await drawRect(page, { x: 250, y: 500 }, { x: 320, y: 560 });
    await waitForScene(page, (s) => s.length === before + 1);

    const toast = page.getByTestId("toast");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("not saved");
    const dropped = await page.evaluate(
      () => window.__sketchsync?.dropped() ?? { overflow: 0, disconnected: 0 },
    );
    expect(
      dropped.disconnected,
      "the drop counter must agree with what the user was told",
    ).toBeGreaterThan(0);
  });

  test("the indicator clears once the socket is back", async () => {
    blocked = false;
    await waitForSocket(page);
    await expect(page.getByTestId("connection-status")).toHaveCount(0);
  });
});

test("Escape closes the export panel WITHOUT clearing the selection", async ({
  browser,
}) => {
  const ctx = await contextFor(browser, owner);
  const page = await openBoard(ctx, room.slug);
  await waitForScene(page, (s) => s.length >= 1);

  // Select the seeded rect. World (400,400) -> screen (460,460) at the default
  // viewport (offset 60, scale 1); the 60x50 rect's middle is (490,485).
  await selectTool(page, "v");
  await page.mouse.click(490, 485);
  await expect(page.getByText("Selected")).toBeVisible();

  await page.getByTestId("export-trigger").click();
  await expect(page.getByTestId("export-panel")).toBeVisible();
  // Selection scope is offered, which is exactly what Escape used to destroy.
  await expect(page.getByTestId("scope-selection")).toBeVisible();

  // While open, canvas shortcuts must not reach the board.
  await page.keyboard.press("r");
  await expect(page.getByTestId("tool-rect")).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("export-panel")).toHaveCount(0);
  await expect(
    page.getByText("Selected"),
    "dismissing the panel must not clear the selection it was scoped to",
  ).toBeVisible();

  // Focus returns to the trigger rather than the top of the document.
  expect(
    await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? null,
    ),
  ).toBe("export-trigger");

  // A second Escape, with no panel open, still clears the selection.
  await page.keyboard.press("Escape");
  await expect(page.getByText("Selected")).toHaveCount(0);
  await ctx.close();
});

test("a failed /rooms load renders as a failure, not as an empty account", async ({
  browser,
}) => {
  const ctx = await contextFor(browser, owner);
  const page = await ctx.newPage();

  let down = true;
  await page.route("**/api/rooms", async (route: Route) => {
    if (down && route.request().method() === "GET") {
      return route.fulfill({
        status: 500,
        body: JSON.stringify({ message: "boom" }),
      });
    }
    return route.continue();
  });

  await page.goto(`${WEB_ORIGIN}/rooms`);
  await expect(page.getByTestId("rooms-load-error")).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByTestId("rooms-empty"),
    "a broken API must never be reported as 'No boards yet'",
  ).toHaveCount(0);
  await expect(page.getByText("Your boards are still there")).toBeVisible();

  // ...and it recovers in place.
  down = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("rooms-load-error")).toHaveCount(0);
  await expect(page.getByText("States board")).toBeVisible();
  await ctx.close();
});
