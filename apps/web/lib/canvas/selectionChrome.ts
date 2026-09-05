import type { ElementData } from "@sketchsync/shared";
import type { Viewport } from "./viewport";
import { elementBBox, type BBox, type MeasureText } from "./geometry";

export type HandleId =
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "start"
  | "end";

export interface Handle {
  id: HandleId;
  x: number; // screen px
  y: number;
}

export interface SelectionChrome {
  /** Outline box in SCREEN px. */
  box: { x: number; y: number; w: number; h: number };
  handles: Handle[];
}

export const HANDLE_SIZE = 8; // drawn size (screen px)
export const HANDLE_HIT = 9; // half-extent grab tolerance (screen px)

interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function corners(b: ScreenBox): Handle[] {
  return [
    { id: "nw", x: b.x, y: b.y },
    { id: "ne", x: b.x + b.w, y: b.y },
    { id: "se", x: b.x + b.w, y: b.y + b.h },
    { id: "sw", x: b.x, y: b.y + b.h },
  ];
}

function edges(b: ScreenBox): Handle[] {
  return [
    { id: "n", x: b.x + b.w / 2, y: b.y },
    { id: "e", x: b.x + b.w, y: b.y + b.h / 2 },
    { id: "s", x: b.x + b.w / 2, y: b.y + b.h },
    { id: "w", x: b.x, y: b.y + b.h / 2 },
  ];
}

function screenBox(bb: BBox, vp: Viewport): ScreenBox {
  const tl = vp.worldToScreen(bb.x, bb.y);
  const br = vp.worldToScreen(bb.x + bb.w, bb.y + bb.h);
  return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
}

/**
 * Selection chrome in SCREEN space (so handles stay a constant grab size at any
 * zoom). Corners+edges for rect/ellipse, corners for text/pencil, endpoints for
 * line/arrow.
 */
export function computeChrome(
  el: ElementData,
  vp: Viewport,
  measure: MeasureText,
): SelectionChrome {
  const box = screenBox(elementBBox(el, measure), vp);

  if (el.type === "line" || el.type === "arrow") {
    const s = vp.worldToScreen(el.x1, el.y1);
    const e = vp.worldToScreen(el.x2, el.y2);
    return {
      box,
      handles: [
        { id: "start", x: s.x, y: s.y },
        { id: "end", x: e.x, y: e.y },
      ],
    };
  }

  if (el.type === "text" || el.type === "pencil") {
    return { box, handles: corners(box) };
  }

  // rect / ellipse
  return { box, handles: [...corners(box), ...edges(box)] };
}

/** Which handle (if any) is under the given screen point. */
export function hitHandle(
  chrome: SelectionChrome,
  sx: number,
  sy: number,
): HandleId | null {
  for (const h of chrome.handles) {
    if (Math.abs(sx - h.x) <= HANDLE_HIT && Math.abs(sy - h.y) <= HANDLE_HIT) {
      return h.id;
    }
  }
  return null;
}
