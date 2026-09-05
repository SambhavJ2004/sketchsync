import type { ElementData } from "@sketchsync/shared";
import type { Point } from "./viewport";
import type { HandleId } from "./selectionChrome";

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Measures a text element's rendered width (px at the given font size). */
export type MeasureText = (text: string, fontSize: number) => number;

const MIN_SIZE = 2; // minimum world size when resizing (avoid degenerate shapes)

function normRect(x: number, y: number, w: number, h: number): BBox {
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  };
}

function fromPoints(points: readonly Point[]): BBox {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ── arrowhead ──────────────────────────────────────────────────────────────
// The ONLY place these constants exist. The canvas renderer and the SVG
// serializer both consume this, so an exported arrow cannot silently drift from
// the one on screen.

/** Head length is proportional to stroke width, with a floor. WORLD units. */
const ARROW_HEAD_SCALE = 3.5;
const ARROW_HEAD_MIN = 8;
/** Half-angle between the shaft and each barb. */
const ARROW_HEAD_SPREAD = Math.PI / 6;

/**
 * The two barb endpoints of an arrowhead, in WORLD coordinates.
 *
 * The head is two OPEN stroked barbs meeting at the tip — not a filled
 * triangle. That is why SVG export emits an explicit two-segment path rather
 * than `marker-end`, which would render a filled shape and not match.
 */
export function arrowHeadPoints(
  el: Extract<ElementData, { type: "arrow" }>,
): { tip: Point; left: Point; right: Point } {
  const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
  const head = Math.max(el.style.width * ARROW_HEAD_SCALE, ARROW_HEAD_MIN);
  return {
    tip: { x: el.x2, y: el.y2 },
    left: {
      x: el.x2 - head * Math.cos(angle - ARROW_HEAD_SPREAD),
      y: el.y2 - head * Math.sin(angle - ARROW_HEAD_SPREAD),
    },
    right: {
      x: el.x2 - head * Math.cos(angle + ARROW_HEAD_SPREAD),
      y: el.y2 - head * Math.sin(angle + ARROW_HEAD_SPREAD),
    },
  };
}

/** Axis-aligned bounding box of an element, in WORLD coordinates. */
export function elementBBox(el: ElementData, measure: MeasureText): BBox {
  switch (el.type) {
    case "rect":
    case "ellipse":
      return normRect(el.x, el.y, el.width, el.height);
    case "line":
    case "arrow":
      return fromPoints([
        { x: el.x1, y: el.y1 },
        { x: el.x2, y: el.y2 },
      ]);
    case "pencil":
      return fromPoints(el.points);
    case "text":
      return {
        x: el.x,
        y: el.y,
        w: Math.max(measure(el.text, el.fontSize), 1),
        h: el.fontSize,
      };
  }
}

/**
 * Bounding box INCLUDING ink: stroke half-width on every side, and for arrows
 * the barbs, which `elementBBox` excludes (it boxes the two endpoints only).
 *
 * Export needs this, not the geometric box — a shape clipped by half its stroke
 * looks like a rendering bug.
 */
export function elementInkBBox(el: ElementData, measure: MeasureText): BBox {
  const bb = elementBBox(el, measure);
  let { x, y } = bb;
  let right = bb.x + bb.w;
  let bottom = bb.y + bb.h;

  if (el.type === "arrow") {
    // Derived from the same function the renderer draws with, never guessed.
    const { left, right: r } = arrowHeadPoints(el);
    for (const p of [left, r]) {
      if (p.x < x) x = p.x;
      if (p.y < y) y = p.y;
      if (p.x > right) right = p.x;
      if (p.y > bottom) bottom = p.y;
    }
  }

  // Text is filled, not stroked, so it gets no stroke padding.
  const pad = el.type === "text" ? 0 : el.style.width / 2;
  return { x: x - pad, y: y - pad, w: right - x + pad * 2, h: bottom - y + pad * 2 };
}

/**
 * Union of the ink boxes of `elements`, in WORLD coordinates.
 *
 * Returns null for an EMPTY input rather than a zero box at the origin: "no
 * content" and "content that happens to be empty at (0,0)" are different, and a
 * caller must decide what to do about nothing to export.
 *
 * A zero-AREA element (zero-length line, single-point pencil) still yields a
 * real box, because the stroke padding gives it `style.width` of extent — which
 * is exactly what gets drawn, since round caps render a dot.
 */
export function unionBBox(
  elements: readonly { data: ElementData }[],
  measure: MeasureText,
): BBox | null {
  if (elements.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    const b = elementInkBBox(el.data, measure);
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Shortest distance from point p to segment a-b. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function pointInBBox(p: Point, bb: BBox, tol: number): boolean {
  return (
    p.x >= bb.x - tol &&
    p.x <= bb.x + bb.w + tol &&
    p.y >= bb.y - tol &&
    p.y <= bb.y + bb.h + tol
  );
}

/**
 * Is the world point within `tolWorld` of the element?
 * rect/ellipse/text: bounding box; line/arrow: distance to segment;
 * pencil: distance to any polyline segment. Line hit widens by half stroke.
 */
export function hitElement(
  el: ElementData,
  p: Point,
  tolWorld: number,
  measure: MeasureText,
): boolean {
  switch (el.type) {
    case "rect":
    case "ellipse":
    case "text":
      return pointInBBox(p, elementBBox(el, measure), tolWorld);
    case "line":
    case "arrow":
      return (
        distToSegment(p, { x: el.x1, y: el.y1 }, { x: el.x2, y: el.y2 }) <=
        tolWorld + el.style.width / 2
      );
    case "pencil": {
      const pts = el.points;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (!a || !b) continue;
        if (distToSegment(p, a, b) <= tolWorld + el.style.width / 2) return true;
      }
      return false;
    }
  }
}

/** Translate an element by (dx, dy) in world units. */
export function translateElement(
  el: ElementData,
  dx: number,
  dy: number,
): ElementData {
  switch (el.type) {
    case "rect":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "ellipse":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "text":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "line":
      return {
        ...el,
        x1: el.x1 + dx,
        y1: el.y1 + dy,
        x2: el.x2 + dx,
        y2: el.y2 + dy,
      };
    case "arrow":
      return {
        ...el,
        x1: el.x1 + dx,
        y1: el.y1 + dy,
        x2: el.x2 + dx,
        y2: el.y2 + dy,
      };
    case "pencil":
      return { ...el, points: el.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
}

function resizeBBox(bb: BBox, handle: HandleId, p: Point): BBox {
  let left = bb.x;
  let top = bb.y;
  let right = bb.x + bb.w;
  let bottom = bb.y + bb.h;
  if (handle.includes("w")) left = p.x;
  if (handle.includes("e")) right = p.x;
  if (handle.includes("n")) top = p.y;
  if (handle.includes("s")) bottom = p.y;
  if (right - left < MIN_SIZE) {
    if (handle.includes("w")) left = right - MIN_SIZE;
    else right = left + MIN_SIZE;
  }
  if (bottom - top < MIN_SIZE) {
    if (handle.includes("n")) top = bottom - MIN_SIZE;
    else bottom = top + MIN_SIZE;
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function scalePoint(p: Point, ob: BBox, nb: BBox): Point {
  return {
    x: ob.w > 0 ? nb.x + (p.x - ob.x) * (nb.w / ob.w) : nb.x,
    y: ob.h > 0 ? nb.y + (p.y - ob.y) * (nb.h / ob.h) : nb.y,
  };
}

/**
 * Resize an element by dragging `handle` to world point `p`. rect/ellipse/pencil
 * scale by bounding box; line/arrow move the grabbed endpoint; text scales its
 * fontSize by the box height ratio (corner handles).
 */
export function resizeElement(
  orig: ElementData,
  handle: HandleId,
  p: Point,
  measure: MeasureText,
): ElementData {
  if (orig.type === "line") {
    if (handle === "start") return { ...orig, x1: p.x, y1: p.y };
    if (handle === "end") return { ...orig, x2: p.x, y2: p.y };
    return orig;
  }
  if (orig.type === "arrow") {
    if (handle === "start") return { ...orig, x1: p.x, y1: p.y };
    if (handle === "end") return { ...orig, x2: p.x, y2: p.y };
    return orig;
  }

  const ob = elementBBox(orig, measure);
  const nb = resizeBBox(ob, handle, p);
  switch (orig.type) {
    case "rect":
      return { ...orig, x: nb.x, y: nb.y, width: nb.w, height: nb.h };
    case "ellipse":
      return { ...orig, x: nb.x, y: nb.y, width: nb.w, height: nb.h };
    case "pencil":
      return { ...orig, points: orig.points.map((pt) => scalePoint(pt, ob, nb)) };
    case "text": {
      const ratio = ob.h > 0 ? nb.h / ob.h : 1;
      return {
        ...orig,
        x: nb.x,
        y: nb.y,
        fontSize: Math.max(orig.fontSize * ratio, 4),
      };
    }
  }
}
