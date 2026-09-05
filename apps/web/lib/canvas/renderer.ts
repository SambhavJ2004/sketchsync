import type { ElementData } from "@sketchsync/shared";
import type { Viewport } from "./viewport";
import { HANDLE_SIZE, type SelectionChrome } from "./selectionChrome";
import { arrowHeadPoints } from "./geometry";

/** A remote cursor to draw, already converted to SCREEN (CSS px) coords. */
export interface RemoteCursor {
  x: number;
  y: number;
  color: string;
  name: string;
}

/** What the active/overlay layer draws: draft, selection chrome, and cursors. */
export interface Overlay {
  draft: ElementData | null;
  selection: SelectionChrome[] | null;
  cursors: RemoteCursor[] | null;
}

export interface RenderView {
  /** CSS width of the canvas. */
  width: number;
  /** CSS height of the canvas. */
  height: number;
  /** devicePixelRatio the backing store is sized for. */
  dpr: number;
}

export interface RendererOptions {
  gridSize?: number;
  background?: string;
  gridColor?: string;
}

const DEFAULTS = {
  gridSize: 40,
  background: "#f8fafc",
  gridColor: "rgba(15, 23, 42, 0.07)",
};

const MIN_GRID_PX = 24;
const MAX_GRID_PX = 120;

const FONT_STACK = "ui-sans-serif, system-ui, -apple-system, sans-serif";

/**
 * Paints onto a single 2D context. Knows nothing about input or tools. Element
 * geometry is in WORLD coordinates; the viewport transform maps it to screen.
 * Two entry points support the layered approach: `renderScene` (static layer:
 * background, grid, committed elements) and `renderPreview` (active layer: the
 * single in-progress element, transparent otherwise).
 */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly gridSize: number;
  private readonly background: string;
  private readonly gridColor: string;

  constructor(ctx: CanvasRenderingContext2D, options: RendererOptions = {}) {
    this.ctx = ctx;
    this.gridSize = options.gridSize ?? DEFAULTS.gridSize;
    this.background = options.background ?? DEFAULTS.background;
    this.gridColor = options.gridColor ?? DEFAULTS.gridColor;
  }

  renderScene(
    viewport: Viewport,
    elements: readonly { data: ElementData }[],
    view: RenderView,
  ): void {
    const ctx = this.ctx;
    this.clearDevice(view);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, view.width, view.height);
    this.drawGrid(viewport, view.width, view.height);

    this.withWorld(viewport, () => {
      for (const el of elements) this.drawElement(el.data);
    });
  }

  /**
   * Elements ONLY — no background fill, no grid, no chrome. Used by PNG export,
   * which must reproduce content and nothing else: the off-white backdrop and
   * the infinite grid are workspace affordances, not part of the drawing.
   *
   * Shares `drawElement` with `renderScene`, so an exported shape is drawn by
   * exactly the code that draws it on screen.
   */
  renderElements(
    viewport: Viewport,
    elements: readonly { data: ElementData }[],
    view: RenderView,
  ): void {
    this.ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    this.withWorld(viewport, () => {
      for (const el of elements) this.drawElement(el.data);
    });
  }

  /**
   * Active/overlay layer: the in-progress draft (WORLD space) and/or the
   * selection chrome (SCREEN space, so handles stay a constant size).
   */
  renderOverlay(viewport: Viewport, overlay: Overlay, view: RenderView): void {
    const ctx = this.ctx;
    this.clearDevice(view); // transparent
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    const draft = overlay.draft;
    if (draft) this.withWorld(viewport, () => this.drawElement(draft));

    if (overlay.selection) {
      for (const chrome of overlay.selection) this.drawChrome(chrome);
    }
    if (overlay.cursors) {
      for (const cursor of overlay.cursors) this.drawCursor(cursor);
    }
  }

  private drawCursor(c: RemoteCursor): void {
    const ctx = this.ctx;
    const { x, y } = c;
    ctx.save();

    // Pointer arrow.
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 17);
    ctx.lineTo(x + 4.5, y + 12.5);
    ctx.lineTo(x + 7.5, y + 19);
    ctx.lineTo(x + 10, y + 18);
    ctx.lineTo(x + 7, y + 11.5);
    ctx.lineTo(x + 12, y + 11.5);
    ctx.closePath();
    ctx.fillStyle = c.color;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.fill();
    ctx.stroke();

    // Name label.
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    const padX = 6;
    const h = 18;
    const w = ctx.measureText(c.name).width + padX * 2;
    const lx = x + 14;
    const ly = y + 15;
    ctx.beginPath();
    ctx.roundRect(lx, ly, w, h, 4);
    ctx.fillStyle = c.color;
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(c.name, lx + padX, ly + h / 2 + 0.5);

    ctx.restore();
  }

  private drawChrome(chrome: SelectionChrome): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(chrome.box.x + 0.5, chrome.box.y + 0.5, chrome.box.w, chrome.box.h);
    ctx.setLineDash([]);
    ctx.fillStyle = "#ffffff";
    const half = HANDLE_SIZE / 2;
    for (const h of chrome.handles) {
      ctx.beginPath();
      ctx.rect(Math.round(h.x - half) + 0.5, Math.round(h.y - half) + 0.5, HANDLE_SIZE, HANDLE_SIZE);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  private clearDevice(view: RenderView): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(
      0,
      0,
      Math.ceil(view.width * view.dpr),
      Math.ceil(view.height * view.dpr),
    );
  }

  private withWorld(viewport: Viewport, draw: () => void): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(viewport.offsetX, viewport.offsetY);
    ctx.scale(viewport.scale, viewport.scale);
    draw();
    ctx.restore();
  }

  private drawGrid(viewport: Viewport, width: number, height: number): void {
    const ctx = this.ctx;
    let step = this.gridSize;
    while (step * viewport.scale < MIN_GRID_PX) step *= 2;
    while (step * viewport.scale > MAX_GRID_PX) step /= 2;

    const topLeft = viewport.screenToWorld(0, 0);
    const bottomRight = viewport.screenToWorld(width, height);
    const startX = Math.floor(topLeft.x / step) * step;
    const endX = Math.ceil(bottomRight.x / step) * step;
    const startY = Math.floor(topLeft.y / step) * step;
    const endY = Math.ceil(bottomRight.y / step) * step;

    ctx.save();
    ctx.strokeStyle = this.gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let wx = startX; wx <= endX; wx += step) {
      const x = Math.round(viewport.worldToScreen(wx, 0).x) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let wy = startY; wy <= endY; wy += step) {
      const y = Math.round(viewport.worldToScreen(0, wy).y) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawElement(el: ElementData): void {
    switch (el.type) {
      case "rect":
        this.drawRect(el);
        break;
      case "ellipse":
        this.drawEllipse(el);
        break;
      case "line":
        this.drawLine(el.x1, el.y1, el.x2, el.y2, el.style.stroke, el.style.width);
        break;
      case "arrow":
        this.drawArrow(el);
        break;
      case "pencil":
        this.drawPencil(el);
        break;
      case "text":
        this.drawText(el);
        break;
    }
  }

  private drawRect(el: Extract<ElementData, { type: "rect" }>): void {
    const ctx = this.ctx;
    if (el.style.fill) {
      ctx.fillStyle = el.style.fill;
      ctx.fillRect(el.x, el.y, el.width, el.height);
    }
    ctx.strokeStyle = el.style.stroke;
    ctx.lineWidth = el.style.width;
    ctx.lineJoin = "miter";
    ctx.strokeRect(el.x, el.y, el.width, el.height);
  }

  private drawEllipse(el: Extract<ElementData, { type: "ellipse" }>): void {
    const ctx = this.ctx;
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const rx = Math.abs(el.width / 2);
    const ry = Math.abs(el.height / 2);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (el.style.fill) {
      ctx.fillStyle = el.style.fill;
      ctx.fill();
    }
    ctx.strokeStyle = el.style.stroke;
    ctx.lineWidth = el.style.width;
    ctx.stroke();
  }

  private drawLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    stroke: string,
    width: number,
  ): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  private drawArrow(el: Extract<ElementData, { type: "arrow" }>): void {
    const ctx = this.ctx;
    this.drawLine(el.x1, el.y1, el.x2, el.y2, el.style.stroke, el.style.width);

    // Geometry lives in geometry.ts so the SVG exporter draws the identical head.
    const { tip, left, right } = arrowHeadPoints(el);
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(left.x, left.y);
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(right.x, right.y);
    ctx.strokeStyle = el.style.stroke;
    ctx.lineWidth = el.style.width;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  private drawPencil(el: Extract<ElementData, { type: "pencil" }>): void {
    const ctx = this.ctx;
    const first = el.points[0];
    if (!first) return;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < el.points.length; i++) {
      const p = el.points[i];
      if (p) ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = el.style.stroke;
    ctx.lineWidth = el.style.width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  }

  private drawText(el: Extract<ElementData, { type: "text" }>): void {
    const ctx = this.ctx;
    ctx.fillStyle = el.style.stroke; // text color = stroke color
    ctx.font = `${el.fontSize}px ${FONT_STACK}`;
    ctx.textBaseline = "top";
    ctx.fillText(el.text, el.x, el.y);
  }
}
