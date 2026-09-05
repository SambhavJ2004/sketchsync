import { describe, expect, it } from "vitest";
import type { ElementData } from "@sketchsync/shared";
import { arrowHeadPoints, elementInkBBox, unionBBox } from "./geometry";
import { sceneToSvg, SVG_MARGIN } from "./exportSvg";
import { checkPngSize, MAX_CANVAS_SIDE } from "./exportPng";

const style = { stroke: "#111827", width: 2 };
/** Deterministic stand-in for canvas measureText (jsdom-free). */
const measure = (t: string, size: number): number => t.length * size * 0.6;
const wrap = (data: ElementData): { data: ElementData } => ({ data });

describe("arrowHeadPoints — pinned against the pre-extraction renderer", () => {
  // These expectations are computed from the ORIGINAL inline constants
  // (3.5, 8, PI/6) so the refactor is provably visual-no-op.
  const arrow = (
    x1: number, y1: number, x2: number, y2: number, width: number,
  ): Extract<ElementData, { type: "arrow" }> => ({
    type: "arrow", x1, y1, x2, y2, style: { stroke: "#111827", width },
  });

  function expected(el: Extract<ElementData, { type: "arrow" }>) {
    const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
    const head = Math.max(el.style.width * 3.5, 8);
    const spread = Math.PI / 6;
    return {
      left: {
        x: el.x2 - head * Math.cos(angle - spread),
        y: el.y2 - head * Math.sin(angle - spread),
      },
      right: {
        x: el.x2 - head * Math.cos(angle + spread),
        y: el.y2 - head * Math.sin(angle + spread),
      },
    };
  }

  it("matches the original formula for a horizontal arrow", () => {
    const a = arrow(0, 0, 100, 0, 2);
    const got = arrowHeadPoints(a);
    const want = expected(a);
    expect(got.tip).toEqual({ x: 100, y: 0 });
    expect(got.left.x).toBeCloseTo(want.left.x, 10);
    expect(got.left.y).toBeCloseTo(want.left.y, 10);
    expect(got.right.x).toBeCloseTo(want.right.x, 10);
    expect(got.right.y).toBeCloseTo(want.right.y, 10);
  });

  it("matches across angles and widths", () => {
    for (const [x2, y2] of [[100, 100], [-50, 30], [0, -80], [-70, -70]] as const) {
      for (const w of [1, 2, 4, 8]) {
        const a = arrow(0, 0, x2, y2, w);
        const got = arrowHeadPoints(a);
        const want = expected(a);
        expect(got.left.x).toBeCloseTo(want.left.x, 10);
        expect(got.left.y).toBeCloseTo(want.left.y, 10);
        expect(got.right.x).toBeCloseTo(want.right.x, 10);
        expect(got.right.y).toBeCloseTo(want.right.y, 10);
      }
    }
  });

  it("honours the 8-unit floor for thin strokes", () => {
    // width 1 -> 3.5 < 8, so the head must be 8 long, not 3.5.
    const a = arrow(0, 0, 100, 0, 1);
    const { tip, left } = arrowHeadPoints(a);
    expect(Math.hypot(tip.x - left.x, tip.y - left.y)).toBeCloseTo(8, 10);
  });

  it("scales with width above the floor", () => {
    const a = arrow(0, 0, 100, 0, 8); // 8*3.5 = 28 > 8
    const { tip, left } = arrowHeadPoints(a);
    expect(Math.hypot(tip.x - left.x, tip.y - left.y)).toBeCloseTo(28, 10);
  });
});

describe("ink bounds", () => {
  it("pads a rect by half the stroke width", () => {
    const b = elementInkBBox(
      { type: "rect", x: 10, y: 10, width: 100, height: 50, style },
      measure,
    );
    expect(b).toEqual({ x: 9, y: 9, w: 102, h: 52 });
  });

  it("includes the arrowhead, which elementBBox excludes", () => {
    // Arrow pointing left: the barbs extend to the RIGHT of the tip.
    const el: ElementData = { type: "arrow", x1: 100, y1: 0, x2: 0, y2: 0, style };
    const b = elementInkBBox(el, measure);
    const { left, right } = arrowHeadPoints(el);
    const maxBarbX = Math.max(left.x, right.x);
    expect(b.x + b.w).toBeGreaterThanOrEqual(maxBarbX);
    // Barbs are off-axis, so the box must be taller than the zero-height shaft.
    expect(b.h).toBeGreaterThan(style.width);
  });

  it("gives text no stroke padding (it is filled, not stroked)", () => {
    const b = elementInkBBox(
      { type: "text", x: 5, y: 7, text: "hi", fontSize: 20, style },
      measure,
    );
    expect(b.x).toBe(5);
    expect(b.y).toBe(7);
    expect(b.h).toBe(20);
  });
});

describe("unionBBox edge cases", () => {
  it("returns NULL for an empty scene, not a zero box at the origin", () => {
    // "nothing to export" must be distinguishable from "empty content at 0,0".
    expect(unionBBox([], measure)).toBeNull();
  });

  it("gives a zero-length line real extent from its stroke", () => {
    const b = unionBBox(
      [wrap({ type: "line", x1: 50, y1: 50, x2: 50, y2: 50, style })],
      measure,
    );
    // Round caps render a dot of diameter `width`.
    expect(b).toEqual({ x: 49, y: 49, w: 2, h: 2 });
  });

  it("gives a single-point pencil real extent", () => {
    const b = unionBBox(
      [wrap({ type: "pencil", points: [{ x: 0, y: 0 }, { x: 0, y: 0 }], style })],
      measure,
    );
    expect(b).toEqual({ x: -1, y: -1, w: 2, h: 2 });
  });

  it("unions disjoint elements", () => {
    const b = unionBBox(
      [
        wrap({ type: "rect", x: 0, y: 0, width: 10, height: 10, style }),
        wrap({ type: "rect", x: 100, y: 200, width: 10, height: 10, style }),
      ],
      measure,
    );
    expect(b!.x).toBe(-1);
    expect(b!.y).toBe(-1);
    expect(b!.x + b!.w).toBe(111);
    expect(b!.y + b!.h).toBe(211);
  });
});

describe("SVG export", () => {
  const rect: ElementData = { type: "rect", x: 0, y: 0, width: 100, height: 50, style };

  it("returns null when there is nothing to export", () => {
    expect(sceneToSvg([], measure)).toBeNull();
  });

  it("viewBox is in WORLD units and matches the padded bounds", () => {
    // If the viewport transform were ever baked into coordinates this breaks —
    // which is the whole point of asserting it.
    const out = sceneToSvg([wrap(rect)], measure)!;
    const content = unionBBox([wrap(rect)], measure)!;
    const m = SVG_MARGIN;
    expect(out.bounds).toEqual({
      x: content.x - m, y: content.y - m,
      w: content.w + m * 2, h: content.h + m * 2,
    });
    expect(out.svg).toContain(
      `viewBox="${out.bounds.x} ${out.bounds.y} ${out.bounds.w} ${out.bounds.h}"`,
    );
  });

  it("emits coordinates verbatim — no zoom baked in", () => {
    const out = sceneToSvg([wrap(rect)], measure)!;
    expect(out.svg).toContain('x="0"');
    expect(out.svg).toContain('width="100"');
    expect(out.svg).toContain('height="50"');
  });

  it("passes stroke-width through unchanged from style.width", () => {
    for (const w of [1, 2, 4, 8]) {
      const out = sceneToSvg(
        [wrap({ ...rect, style: { ...style, width: w } })],
        measure,
      )!;
      expect(out.svg).toContain(`stroke-width="${w}"`);
    }
  });

  it("draws the arrowhead as an explicit path, never marker-end", () => {
    const el: ElementData = { type: "arrow", x1: 0, y1: 0, x2: 100, y2: 0, style };
    const out = sceneToSvg([wrap(el)], measure)!;
    expect(out.svg).toContain("<path");
    expect(out.svg).not.toContain("marker-end");
    expect(out.svg).toContain('stroke-linecap="round"');
    // The barb coordinates must be the shared geometry's, not re-derived.
    const { left } = arrowHeadPoints(el);
    expect(out.svg).toContain(left.x.toFixed(3).replace(/\.?0+$/, ""));
  });

  it("emits pencil as a polyline with round join and cap", () => {
    const el: ElementData = {
      type: "pencil",
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }],
      style,
    };
    const out = sceneToSvg([wrap(el)], measure)!;
    expect(out.svg).toContain("<polyline");
    expect(out.svg).toContain('points="0,0 10,10 20,0"');
    expect(out.svg).toContain('stroke-linejoin="round"');
    expect(out.svg).toContain('stroke-linecap="round"');
  });

  it("emits text with a top-equivalent baseline and the canvas font stack", () => {
    const el: ElementData = { type: "text", x: 4, y: 6, text: "Hi <there>", fontSize: 24, style };
    const out = sceneToSvg([wrap(el)], measure)!;
    expect(out.svg).toContain('dominant-baseline="text-before-edge"');
    expect(out.svg).toContain("ui-sans-serif, system-ui, -apple-system, sans-serif");
    expect(out.svg).toContain("Hi &lt;there&gt;"); // escaped
  });

  it("preserves input order (callers pass render order)", () => {
    const a: ElementData = { type: "rect", x: 0, y: 0, width: 5, height: 5, style };
    const b: ElementData = { type: "ellipse", x: 0, y: 0, width: 5, height: 5, style };
    const out = sceneToSvg([wrap(a), wrap(b)], measure)!;
    expect(out.svg.indexOf("<rect")).toBeLessThan(out.svg.indexOf("<ellipse"));
  });

  it("has no background unless asked, and one when asked", () => {
    expect(sceneToSvg([wrap(rect)], measure)!.svg).not.toContain('fill="#ffffff"');
    const withBg = sceneToSvg([wrap(rect)], measure, { background: "#ffffff" })!;
    expect(withBg.svg).toContain('fill="#ffffff"');
  });

  it("normalizes a negative-size rect (SVG rejects negative width)", () => {
    const out = sceneToSvg(
      [wrap({ type: "rect", x: 100, y: 100, width: -40, height: -20, style })],
      measure,
    )!;
    expect(out.svg).toContain('x="60"');
    expect(out.svg).toContain('width="40"');
    expect(out.svg).not.toContain('width="-40"');
  });
});

describe("PNG size guard", () => {
  it("accepts ordinary sizes", () => {
    expect(checkPngSize(800, 600).ok).toBe(true);
  });

  it("rejects an empty region", () => {
    expect(checkPngSize(0, 100).ok).toBe(false);
  });

  it("rejects beyond the per-side limit", () => {
    const r = checkPngSize(MAX_CANVAS_SIDE + 1, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("per-side");
  });

  it("rejects on total area even when each side is legal", () => {
    const r = checkPngSize(MAX_CANVAS_SIDE, MAX_CANVAS_SIDE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("area");
  });
});
