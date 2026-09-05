import type { ElementData, Style } from "@sketchsync/shared";
import type { Point } from "./viewport";

/** Tools that produce a shape by dragging from one point to another. */
export type DragShapeTool = "rect" | "ellipse" | "line" | "arrow";

/**
 * Build an ElementData from a drag (start -> end), in WORLD coordinates.
 * rect/ellipse are normalized so width/height are positive regardless of drag
 * direction; line/arrow keep their start/end so the arrowhead points correctly.
 * The style is cloned so later style changes never mutate committed shapes.
 */
export function createShapeFromDrag(
  tool: DragShapeTool,
  start: Point,
  end: Point,
  style: Style,
): ElementData {
  const s: Style = { ...style };
  switch (tool) {
    case "rect":
      return {
        type: "rect",
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
        style: s,
      };
    case "ellipse":
      return {
        type: "ellipse",
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
        style: s,
      };
    case "line":
      return { type: "line", x1: start.x, y1: start.y, x2: end.x, y2: end.y, style: s };
    case "arrow":
      return { type: "arrow", x1: start.x, y1: start.y, x2: end.x, y2: end.y, style: s };
  }
}

export function createPencil(points: readonly Point[], style: Style): ElementData {
  return {
    type: "pencil",
    points: points.map((p) => ({ x: p.x, y: p.y })),
    style: { ...style },
  };
}

export function createText(
  at: Point,
  text: string,
  fontSize: number,
  style: Style,
): ElementData {
  return { type: "text", x: at.x, y: at.y, text, fontSize, style: { ...style } };
}

/** Return a copy of the element with its style patched (all variants have style). */
export function withStyle(data: ElementData, patch: Partial<Style>): ElementData {
  const style: Style = { ...data.style, ...patch };
  switch (data.type) {
    case "rect":
      return { ...data, style };
    case "ellipse":
      return { ...data, style };
    case "line":
      return { ...data, style };
    case "arrow":
      return { ...data, style };
    case "pencil":
      return { ...data, style };
    case "text":
      return { ...data, style };
  }
}
