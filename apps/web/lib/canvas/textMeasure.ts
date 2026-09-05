// Shared offscreen text measurer. Encapsulated so geometry/hit-testing can get a
// text width without touching the render canvas.

const FONT_STACK = "ui-sans-serif, system-ui, -apple-system, sans-serif";

let ctx: CanvasRenderingContext2D | null = null;

function getCtx(): CanvasRenderingContext2D | null {
  if (ctx) return ctx;
  if (typeof document === "undefined") return null; // SSR
  ctx = document.createElement("canvas").getContext("2d");
  return ctx;
}

export function measureTextWidth(text: string, fontSize: number): number {
  const c = getCtx();
  if (!c) return text.length * fontSize * 0.6; // fallback estimate
  c.font = `${fontSize}px ${FONT_STACK}`;
  return c.measureText(text).width;
}
