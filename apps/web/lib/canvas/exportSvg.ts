import type { ElementData } from "@sketchsync/shared";
import { arrowHeadPoints, unionBBox, type BBox, type MeasureText } from "./geometry";

/**
 * Scene -> standalone SVG.
 *
 * THE VIEWBOX IS IN WORLD UNITS and element coordinates are emitted verbatim.
 * The viewport transform is deliberately NOT baked in: because world units are
 * preserved, `stroke-width` can be copied straight from `style.width` and
 * decision #4 (stroke width is a world quantity) reproduces for free. Baking in
 * a zoom factor would silently break that — every stroke would be scaled twice
 * or not at all — which is why a test asserts the viewBox.
 *
 * Screen-space chrome (selection handles, remote cursors) is never emitted: it
 * is UI, not content.
 */

/** Matches the canvas font stack exactly (renderer.ts FONT_STACK). */
const FONT_STACK = "ui-sans-serif, system-ui, -apple-system, sans-serif";

/** Padding around the content box, in world units. */
export const SVG_MARGIN = 8;

export interface SvgOptions {
  /** Solid background; omitted entirely when undefined (transparent). */
  background?: string;
  margin?: number;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Trim float noise: 3dp is well below a pixel at any sane zoom. */
function n(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, "");
}

function strokeAttrs(style: ElementData["style"]): string {
  return `stroke="${esc(style.stroke)}" stroke-width="${n(style.width)}"`;
}

function elementSvg(el: ElementData): string {
  switch (el.type) {
    case "rect": {
      // Normalize: a drag can produce negative width/height, which SVG rejects.
      const x = el.width < 0 ? el.x + el.width : el.x;
      const y = el.height < 0 ? el.y + el.height : el.y;
      const w = Math.abs(el.width);
      const h = Math.abs(el.height);
      const fill = el.style.fill ? esc(el.style.fill) : "none";
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}" ${strokeAttrs(el.style)} stroke-linejoin="miter"/>`;
    }
    case "ellipse": {
      const cx = el.x + el.width / 2;
      const cy = el.y + el.height / 2;
      const rx = Math.abs(el.width / 2);
      const ry = Math.abs(el.height / 2);
      const fill = el.style.fill ? esc(el.style.fill) : "none";
      return `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" fill="${fill}" ${strokeAttrs(el.style)}/>`;
    }
    case "line":
      return `<line x1="${n(el.x1)}" y1="${n(el.y1)}" x2="${n(el.x2)}" y2="${n(el.y2)}" ${strokeAttrs(el.style)} stroke-linecap="round"/>`;
    case "arrow": {
      const { tip, left, right } = arrowHeadPoints(el);
      // Shaft + two OPEN barbs as one path. Deliberately not `marker-end`: the
      // canvas draws stroked barbs, and a marker would render a filled triangle.
      const d =
        `M${n(el.x1)} ${n(el.y1)} L${n(el.x2)} ${n(el.y2)} ` +
        `M${n(tip.x)} ${n(tip.y)} L${n(left.x)} ${n(left.y)} ` +
        `M${n(tip.x)} ${n(tip.y)} L${n(right.x)} ${n(right.y)}`;
      return `<path d="${d}" fill="none" ${strokeAttrs(el.style)} stroke-linecap="round"/>`;
    }
    case "pencil": {
      const pts = el.points.map((p) => `${n(p.x)},${n(p.y)}`).join(" ");
      return `<polyline points="${pts}" fill="none" ${strokeAttrs(el.style)} stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    case "text":
      // dominant-baseline="text-before-edge" matches the canvas's
      // textBaseline="top". Colour is style.stroke — text has no separate fill.
      return `<text x="${n(el.x)}" y="${n(el.y)}" font-family="${esc(FONT_STACK)}" font-size="${n(el.fontSize)}" fill="${esc(el.style.stroke)}" dominant-baseline="text-before-edge" xml:space="preserve">${esc(el.text)}</text>`;
  }
}

export interface SvgResult {
  svg: string;
  bounds: BBox;
}

/**
 * Serialize `elements` (already in render order — zIndex, createdAt) to SVG.
 * Returns null when there is nothing to export.
 */
export function sceneToSvg(
  elements: readonly { data: ElementData }[],
  measure: MeasureText,
  options: SvgOptions = {},
): SvgResult | null {
  const content = unionBBox(elements, measure);
  if (!content) return null;

  const margin = options.margin ?? SVG_MARGIN;
  const bounds: BBox = {
    x: content.x - margin,
    y: content.y - margin,
    w: content.w + margin * 2,
    h: content.h + margin * 2,
  };

  const bg = options.background
    ? `<rect x="${n(bounds.x)}" y="${n(bounds.y)}" width="${n(bounds.w)}" height="${n(bounds.h)}" fill="${esc(options.background)}"/>`
    : "";

  // width/height in world units so the file has a sensible intrinsic size; the
  // viewBox is what actually defines the coordinate system.
  const body = elements.map((e) => elementSvg(e.data)).join("\n  ");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${n(bounds.w)}" height="${n(bounds.h)}" ` +
    `viewBox="${n(bounds.x)} ${n(bounds.y)} ${n(bounds.w)} ${n(bounds.h)}">\n` +
    (bg ? `  ${bg}\n` : "") +
    `  ${body}\n` +
    `</svg>\n`;

  return { svg, bounds };
}
