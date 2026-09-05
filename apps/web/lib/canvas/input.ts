import type { Point, Viewport } from "./viewport";
import { isTypingNow } from "./keyboard";

export interface ReadoutInfo {
  scale: number;
  worldX: number;
  worldY: number;
}

export interface InputOptions {
  /** Request a repaint (pan/zoom changed the viewport). */
  onChange: () => void;
  /** Live readout of zoom + world coords under the cursor (dev aid). */
  onReadout?: (info: ReadoutInfo) => void;
  /** Drawing intents in WORLD + SCREEN (CSS px) coords. Fired for the draw
   *  gesture only (left button, not a pan). The consumer decides what to do. */
  onDrawStart?: (world: Point, screen: Point, mods: PointerMods) => void;
  onDrawMove?: (world: Point, screen: Point, mods: PointerMods) => void;
  onDrawEnd?: (world: Point, screen: Point, mods: PointerMods) => void;
  /** True when the current tool is a pan tool (so a left-drag pans). */
  isPanActive?: () => boolean;
  /** True while a text box is open — pan/zoom are fully disabled so the input
   *  owns the screen and its captured zoom stays valid. */
  isNavLocked?: () => boolean;
}

export interface PointerMods {
  shift: boolean;
}

const ZOOM_INTENSITY = 0.0015;
const WHEEL_LINE_HEIGHT = 16;

/**
 * Translates raw pointer/keyboard/wheel events on the canvas into intents:
 * pan/zoom are applied to the viewport directly; drawing is emitted as
 * world-space start/move/end callbacks. Knows nothing about elements or how
 * they're rendered.
 *
 *   - pan:  Space + drag, middle-mouse drag, or left-drag when the pan tool is active
 *   - zoom: wheel / trackpad pinch, anchored at the cursor
 *   - draw: left-drag otherwise -> onDrawStart/Move/End (world coords)
 */
export class Input {
  private readonly canvas: HTMLCanvasElement;
  private readonly viewport: Viewport;
  private readonly opts: InputOptions;

  private spaceHeld = false;
  private panning = false;
  private drawing = false;
  private activePointerId: number | null = null;
  private lastClientX = 0;
  private lastClientY = 0;

  constructor(
    canvas: HTMLCanvasElement,
    viewport: Viewport,
    opts: InputOptions,
  ) {
    this.canvas = canvas;
    this.viewport = viewport;
    this.opts = opts;

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  detach(): void {
    const canvas = this.canvas;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerUp);
    canvas.removeEventListener("wheel", this.onWheel);
    canvas.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

  /** Re-apply the idle cursor (call when the active tool changes). */
  refreshCursor(): void {
    this.updateCursor();
  }

  private toCanvas(clientX: number, clientY: number): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  private emitReadout(clientX: number, clientY: number): void {
    if (!this.opts.onReadout) return;
    const { x, y } = this.toCanvas(clientX, clientY);
    const world = this.viewport.screenToWorld(x, y);
    this.opts.onReadout({
      scale: this.viewport.scale,
      worldX: world.x,
      worldY: world.y,
    });
  }

  private updateCursor(): void {
    // Inline style layers over the tool's base cursor (a CSS class). Empty
    // string clears it so the base class shows through.
    this.canvas.style.cursor = this.panning
      ? "grabbing"
      : this.spaceHeld
        ? "grab"
        : "";
  }

  /**
   * Abort the current gesture without committing it.
   *
   * Clearing `drawing` is what makes this safe: the pointerup handler only calls
   * onDrawEnd when that flag is set, so the shape is never committed. Deliberately
   * does NOT cancel a pan (a pan has nothing to commit) or an edit drag (that one
   * has already previewed a moved scene, so aborting it would need a restore path
   * EditSession does not have — see the note in CanvasStage).
   */
  cancelGesture(): void {
    if (!this.drawing) return;
    this.drawing = false;
    if (
      this.activePointerId !== null &&
      this.canvas.hasPointerCapture(this.activePointerId)
    ) {
      this.canvas.releasePointerCapture(this.activePointerId);
    }
    this.activePointerId = null;
    this.updateCursor();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isTypingNow()) return; // don't hijack Space while typing text
    if (e.code === "Space" && !this.spaceHeld) {
      this.spaceHeld = true;
      e.preventDefault();
      this.updateCursor();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "Space") {
      this.spaceHeld = false;
      this.updateCursor();
    }
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    // While editing text, let the input own the screen (a click commits it).
    if (this.opts.isNavLocked?.() === true) return;

    const isMiddle = e.button === 1;
    const isLeft = e.button === 0;
    if (!isMiddle && !isLeft) return;

    const wantsPan =
      isMiddle || (isLeft && (this.spaceHeld || this.opts.isPanActive?.() === true));

    e.preventDefault();
    this.activePointerId = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);

    if (wantsPan) {
      this.panning = true;
      this.lastClientX = e.clientX;
      this.lastClientY = e.clientY;
      this.updateCursor();
      return;
    }

    // Drawing gesture (left button only).
    if (!isLeft) return;
    this.drawing = true;
    const screen = this.toCanvas(e.clientX, e.clientY);
    const world = this.viewport.screenToWorld(screen.x, screen.y);
    this.opts.onDrawStart?.(world, screen, { shift: e.shiftKey });
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId === this.activePointerId) {
      if (this.panning) {
        this.viewport.panBy(e.clientX - this.lastClientX, e.clientY - this.lastClientY);
        this.lastClientX = e.clientX;
        this.lastClientY = e.clientY;
        this.opts.onChange();
      } else if (this.drawing) {
        const screen = this.toCanvas(e.clientX, e.clientY);
        const world = this.viewport.screenToWorld(screen.x, screen.y);
        this.opts.onDrawMove?.(world, screen, { shift: e.shiftKey });
      }
    }
    this.emitReadout(e.clientX, e.clientY);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.activePointerId) return;
    if (this.drawing) {
      const screen = this.toCanvas(e.clientX, e.clientY);
      const world = this.viewport.screenToWorld(screen.x, screen.y);
      this.opts.onDrawEnd?.(world, screen, { shift: e.shiftKey });
    }
    this.panning = false;
    this.drawing = false;
    this.activePointerId = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    this.updateCursor();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (this.opts.isNavLocked?.() === true) return; // no zoom while editing text
    const { x, y } = this.toCanvas(e.clientX, e.clientY);
    const deltaY =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? e.deltaY * WHEEL_LINE_HEIGHT
        : e.deltaY;
    const factor = Math.exp(-deltaY * ZOOM_INTENSITY);
    this.viewport.zoomTo(factor, x, y);
    this.opts.onChange();
    this.emitReadout(e.clientX, e.clientY);
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };
}
