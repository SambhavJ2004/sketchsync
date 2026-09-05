import { MAX_PENCIL_POINTS, type ElementData, type Style } from "@sketchsync/shared";
import type { Point } from "./viewport";
import type { Tool } from "./store";
import { createPencil, createShapeFromDrag, type DragShapeTool } from "./shapes";

// Screen-space thresholds (CSS px) so behavior is consistent at any zoom.
const MIN_SAMPLE_PX = 2; // pencil point spacing
const MIN_COMMIT_PX = 3; // ignore click-sized (accidental) shapes

interface ShapeDrag {
  kind: "shape";
  tool: DragShapeTool;
  start: Point;
  startScreen: Point;
}
interface PencilDrag {
  kind: "pencil";
  points: Point[];
  lastScreen: Point;
}
type Drag = ShapeDrag | PencilDrag;

export interface DrawSessionCallbacks {
  getTool: () => Tool;
  getStyle: () => Style;
  /** Update the in-progress element on the preview layer (null clears it). */
  onPreview: (draft: ElementData | null) => void;
  /** Commit a finished element to the scene. */
  onCommit: (data: ElementData) => void;
  /** Text tool: open the text editor at this point (no drag). */
  onRequestText: (world: Point, screen: Point) => void;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Append a sampled point unless the stroke has hit the shared abuse ceiling.
 * At the ceiling the stroke FREEZES: it stops growing but stays a complete,
 * committable shape. Enforcing here (the source) — rather than only at the
 * receiver — is what keeps the client from rendering and emitting a stroke the
 * server would reject, which would persist locally and vanish on the next sync.
 */
function appendPoint(points: Point[], p: Point): boolean {
  if (points.length >= MAX_PENCIL_POINTS) return false;
  points.push(p);
  return true;
}

/**
 * The drawing state machine. Consumes pointer intents (world + screen points)
 * from Input and produces preview/commit callbacks. It knows about tools and
 * geometry, but nothing about DOM events or how pixels are drawn.
 */
export class DrawSession {
  private drag: Drag | null = null;

  constructor(private readonly cb: DrawSessionCallbacks) {}

  begin(world: Point, screen: Point): void {
    const tool = this.cb.getTool();
    switch (tool) {
      case "rect":
      case "ellipse":
      case "line":
      case "arrow":
        this.drag = { kind: "shape", tool, start: world, startScreen: screen };
        break;
      case "pencil":
        this.drag = { kind: "pencil", points: [world], lastScreen: screen };
        break;
      case "text":
        this.cb.onRequestText(world, screen);
        break;
      case "select":
      case "pan":
        break; // no drawing
    }
  }

  move(world: Point, screen: Point): void {
    const d = this.drag;
    if (!d) return;
    const style = this.cb.getStyle();
    if (d.kind === "shape") {
      this.cb.onPreview(createShapeFromDrag(d.tool, d.start, world, style));
    } else {
      // Sample sparsely (screen-space) so we don't store hundreds of points.
      if (dist(screen, d.lastScreen) >= MIN_SAMPLE_PX) {
        if (appendPoint(d.points, world)) d.lastScreen = screen;
      }
      this.cb.onPreview(createPencil(d.points, style));
    }
  }

  end(world: Point, screen: Point): void {
    const d = this.drag;
    this.drag = null;
    if (!d) {
      return;
    }
    const style = this.cb.getStyle();
    if (d.kind === "shape") {
      if (dist(d.startScreen, screen) >= MIN_COMMIT_PX) {
        this.cb.onCommit(createShapeFromDrag(d.tool, d.start, world, style));
      }
    } else {
      // Always include the final point — unless that would breach the ceiling.
      if (dist(screen, d.lastScreen) > 0) appendPoint(d.points, world);
      if (d.points.length >= 2) {
        this.cb.onCommit(createPencil(d.points, style));
      }
    }
    this.cb.onPreview(null);
  }

  /** True while a shape/stroke is being dragged out (used by Escape-to-abort). */
  isActive(): boolean {
    return this.drag !== null;
  }

  /** Abandon the in-progress draft without committing it. Wired to Escape. */
  cancel(): void {
    this.drag = null;
    this.cb.onPreview(null);
  }
}
