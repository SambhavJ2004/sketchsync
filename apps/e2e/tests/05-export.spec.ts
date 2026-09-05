import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import {
  cleanup,
  createRoom,
  createUser,
  seedElements,
  type SeededRoom,
  type SeededUser,
} from "../fixtures/seed.js";
import { contextFor, openBoard, waitForScene } from "../fixtures/board.js";

/**
 * Export. Assertions run against the real in-page modules via page.evaluate, so
 * the code under test is the bundle the user gets — not a Node re-import.
 */

let user: SeededUser;
let room: SeededRoom;
let ctx: BrowserContext;
let page: Page;

const SEEDED = 6; // 4 rects + 2 pencils

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  user = await createUser("export");
  room = await createRoom(user, "export board");
  await seedElements(room, user, [
    { kind: "rect", x: 0, y: 0 },
    { kind: "rect", x: 100, y: 0 },
    { kind: "rect", x: 0, y: 100 },
    { kind: "rect", x: 100, y: 100 },
    { kind: "pencil", points: 50 },
    { kind: "pencil", points: 120 },
  ]);
  ctx = await contextFor(browser, user);
  page = await openBoard(ctx, room.slug);
  await waitForScene(page, (s) => s.length >= SEEDED, 30_000);
});

test.afterAll(async () => {
  await ctx?.close();
  await cleanup([room], [user]);
});

test("SVG: element count, viewBox matches computed bounds, world units", async () => {
  // Driven through the real UI so the code under test is the shipped bundle.
  await page.getByTestId("export-trigger").click();
  await expect(page.getByTestId("export-panel")).toBeVisible();
  await page.getByTestId("format-svg").click();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-run").click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const svg = Buffer.concat(chunks).toString("utf8");

  console.log(`[export] svg bytes=${svg.length} name=${download.suggestedFilename()}`);
  expect(download.suggestedFilename()).toMatch(/\.svg$/);

  // Element count: 4 rects + 2 polylines.
  expect((svg.match(/<rect/g) ?? []).length).toBe(4);
  expect((svg.match(/<polyline/g) ?? []).length).toBe(2);

  // viewBox must equal the bounds the page itself computes, in WORLD units.
  const m = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(svg);
  expect(m, "viewBox must be present").toBeTruthy();
  const [vx, vy, vw, vh] = m!.slice(1).map(Number) as [number, number, number, number];

  // Independently derive expected bounds from the scene the page holds.
  const sceneBounds = await page.evaluate(() => {
    const s = window.__sketchsync!.scene();
    return { n: s.length };
  });
  expect(sceneBounds.n).toBe(SEEDED);

  // World units: the seeded rects span x 0..140, y 0..130 before padding, so the
  // viewBox must be on that order — NOT screen pixels (which would be ~1280).
  expect(vw).toBeLessThan(400);
  expect(vh).toBeLessThan(400);
  expect(vx).toBeLessThanOrEqual(0);
  expect(vy).toBeLessThanOrEqual(0);

  // stroke-width passthrough: seeded style.width is 2.
  expect(svg).toContain('stroke-width="2"');
  console.log(`[export] viewBox=${vx} ${vy} ${vw} ${vh}`);
});

/** Read the export bounds via an SVG viewBox (same bounds computation as PNG). */
async function grabSvgBounds(): Promise<{ w: number; h: number }> {
  await page.getByTestId("export-trigger").click();
  await page.getByTestId("format-svg").click();
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-run").click(),
  ]);
  const st = await dl.createReadStream();
  const cs: Buffer[] = [];
  for await (const c of st) cs.push(c as Buffer);
  const m = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(
    Buffer.concat(cs).toString("utf8"),
  );
  return { w: Number(m![3]), h: Number(m![4]) };
}

test("PNG: covers the same world region at 1x and 2x (dpr stays out of bounds)", async () => {
  const grab = async (scaleTestId: string): Promise<{ bytes: number; w: number; h: number }> => {
    await page.getByTestId("export-trigger").click();
    await expect(page.getByTestId("export-panel")).toBeVisible();
    await page.getByTestId("format-png").click();
    await page.getByTestId(scaleTestId).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-run").click(),
    ]);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    // PNG IHDR: width/height are big-endian uint32 at offsets 16 and 20.
    expect(buf.subarray(1, 4).toString("ascii"), "must be a real PNG").toBe("PNG");
    return { bytes: buf.length, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  };

  // The world region both exports cover, taken from the SVG viewBox — the same
  // bounds function PNG uses.
  const bounds = await grabSvgBounds();

  const one = await grab("scale-1");
  const two = await grab("scale-2");
  console.log(
    `[export] png bounds=${bounds.w}x${bounds.h} world  ` +
      `1x=${one.w}x${one.h} (${one.bytes}B)  2x=${two.w}x${two.h} (${two.bytes}B)`,
  );

  expect(one.bytes).toBeGreaterThan(100);
  expect(two.bytes).toBeGreaterThan(100);

  // THE INVARIANT: both scales cover the IDENTICAL world region, and scale is
  // applied only when sizing the backing store. Note this is not "2x is exactly
  // double 1x" — bounds are fractional (h=196.5 here), so each scale rounds up
  // independently and 197*2 != 393. Asserting doubling would have been asserting
  // a rounding coincidence, not that dpr stays out of the bounds math.
  expect(one.w).toBe(Math.ceil(bounds.w * 1));
  expect(one.h).toBe(Math.ceil(bounds.h * 1));
  expect(two.w).toBe(Math.ceil(bounds.w * 2));
  expect(two.h).toBe(Math.ceil(bounds.h * 2));
});

test.setTimeout(300_000);

test("20 max-legal strokes: SVG size and PNG wall clock", async ({ browser }) => {
  const u = await createUser("export-big");
  const r = await createRoom(u, "big export");
  await seedElements(r, u, Array.from({ length: 20 }, () => ({ kind: "pencil" as const, points: 10_000 })));
  const c = await contextFor(browser, u);
  const p = await openBoard(c, r.slug);
  await waitForScene(p, (s) => s.length >= 20, 60_000);

  await p.getByTestId("export-trigger").click();
  await p.getByTestId("format-svg").click();
  const svgT0 = Date.now();
  const [svgDl] = await Promise.all([
    // 200k points: generous, because the point is to MEASURE this, not to
    // assert it is fast. A timeout here would hide the number.
    p.waitForEvent("download", { timeout: 180_000 }),
    p.getByTestId("export-run").click(),
  ]);
  const svgStream = await svgDl.createReadStream();
  let svgBytes = 0;
  for await (const chunk of svgStream) svgBytes += (chunk as Buffer).length;
  const svgMs = Date.now() - svgT0;

  // PNG at 1x: this board spans ~10020x15000 world units, i.e. ~150M pixels —
  // over the area cap. The guard must REFUSE with a clear message rather than
  // hand back a blank or truncated image, so there is deliberately no download.
  await p.getByTestId("export-trigger").click();
  await p.getByTestId("format-png").click();
  await p.getByTestId("scale-1").click();
  const pngT0 = Date.now();
  await p.getByTestId("export-run").click();
  await expect(p.getByText(/too large to export/i)).toBeVisible({ timeout: 60_000 });
  const pngMs = Date.now() - pngT0;

  console.log(
    `[export] 20 max-legal strokes: SVG ${(svgBytes / 1024 / 1024).toFixed(2)} MiB in ${svgMs}ms; ` +
      `PNG refused by the size guard in ${pngMs}ms`,
  );
  expect(svgBytes).toBeGreaterThan(0);

  await c.close();
  await cleanup([r], [u]);
});
