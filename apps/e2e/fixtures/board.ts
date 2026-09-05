import type { Browser, BrowserContext, Page } from "@playwright/test";
import { WEB_ORIGIN, type SeededUser } from "./seed.js";

/** Shape of the read-only hook installed by apps/web/lib/canvas/testHook.ts. */
export interface E2EScene {
  id: string;
  version: number;
  zIndex: number;
  type: string;
  pointCount: number;
  text: string | null;
  stroke: string;
}

declare global {
  interface Window {
    __sketchsync?: {
      scene: () => E2EScene[];
      history: () => { past: number; future: number };
      status: () => string;
      socketOpen: () => boolean;
      ticketRequests: () => number;
      dropped: () => { overflow: number; disconnected: number };
      dropSocket: () => void;
    };
  }
}

/**
 * A fresh browser CONTEXT per participant — not a second tab. Tabs share a
 * cookie jar, so two tabs are one session and cannot represent two users.
 */
export async function contextFor(
  browser: Browser,
  user: SeededUser,
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true, // export tests read the downloaded bytes
  });
  const [name, value] = user.cookieValue.split("=");
  await ctx.addCookies([
    {
      name: name ?? "",
      value: value ?? "",
      url: WEB_ORIGIN, // web origin, path / — matches how the app stores it
    },
  ]);
  return ctx;
}

/** Force a transport drop (CDP offline does not close an established WS). */
export async function dropSocket(page: Page): Promise<void> {
  await page.evaluate(() => window.__sketchsync?.dropSocket());
  await page.waitForFunction(() => window.__sketchsync?.socketOpen() === false, undefined, {
    timeout: 20_000,
  });
}

export const boardUrl = (slug: string): string => `${WEB_ORIGIN}/room/${slug}`;

/** Wait until the canvas is mounted and the hook is installed. */
export async function waitForCanvas(page: Page): Promise<void> {
  await page.waitForSelector("canvas", { state: "attached", timeout: 30_000 });
  await page.waitForFunction(() => window.__sketchsync !== undefined, undefined, {
    timeout: 30_000,
  });
}

/** Wait until the realtime socket reports open. */
export async function waitForSocket(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__sketchsync?.socketOpen() === true, undefined, {
    timeout: 30_000,
  });
}

/** Open a board and wait for it to be fully live (canvas + socket + sync). */
export async function openBoard(ctx: BrowserContext, slug: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(boardUrl(slug));
  await waitForCanvas(page);
  await waitForSocket(page);
  return page;
}

export const scene = (page: Page): Promise<E2EScene[]> =>
  page.evaluate(() => window.__sketchsync?.scene() ?? []);

export const history = (page: Page): Promise<{ past: number; future: number }> =>
  page.evaluate(() => window.__sketchsync?.history() ?? { past: 0, future: 0 });

/** Poll until the page's scene satisfies `pred` (propagation is async). */
export async function waitForScene(
  page: Page,
  pred: (s: E2EScene[]) => boolean,
  timeoutMs = 20_000,
): Promise<E2EScene[]> {
  const deadline = Date.now() + timeoutMs;
  let last: E2EScene[] = [];
  while (Date.now() < deadline) {
    last = await scene(page);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

// ── input helpers ──────────────────────────────────────────────────────────
// The canvas listens for pointer events, so tests must drive real mouse input
// rather than call store actions — that is the whole point of an E2E suite.

export async function selectTool(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
}

/** Drag a shape with the currently-selected tool. */
export async function drawDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

/** Draw a rect via the toolbar shortcut, returning after commit. */
export async function drawRect(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await selectTool(page, "r");
  await drawDrag(page, from, to);
}
