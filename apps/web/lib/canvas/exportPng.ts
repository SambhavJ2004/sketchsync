import type { ElementData } from "@sketchsync/shared";
import { Renderer } from "./renderer";
import { Viewport } from "./viewport";
import { unionBBox, type BBox, type MeasureText } from "./geometry";
import { SVG_MARGIN } from "./exportSvg";

/**
 * Scene -> PNG, rendered offscreen at the SCENE bounds.
 *
 * Deliberately NOT the current viewport: exporting whatever happens to be on
 * screen means the output depends on where the user last scrolled, which is not
 * a property anyone wants in a file they are about to share.
 *
 * Per decision #3, devicePixelRatio belongs to the render step ONLY. The bounds
 * math below is pure world units; `scale` is applied when sizing the backing
 * store, exactly as the live canvas applies dpr. Letting dpr leak into bounds
 * would make the exported region differ between machines.
 */

/**
 * Browsers cap canvas dimensions. Chrome/Firefox allow 16384px per side; total
 * AREA limits are lower and vary (Safari is notably stricter). We refuse rather
 * than hand back a silently blank or truncated image — a corrupt export that
 * looks fine until opened is worse than an error.
 */
export const MAX_CANVAS_SIDE = 16384;
/**
 * A quarter of 16384² (i.e. 8192×8192). Deliberately well under the per-side
 * square, because area limits are far lower than side limits on several
 * engines and exceeding them yields a blank canvas with no error.
 */
export const MAX_CANVAS_AREA = 67_108_864;

export interface PngOptions {
  /** 1 = logical size, 2 = retina. Applied ONLY to the backing store. */
  scale?: number;
  /** Undefined = transparent. */
  background?: string;
  margin?: number;
}

export interface PngResult {
  blob: Blob;
  /** Output pixel dimensions (world size x scale). */
  width: number;
  height: number;
  bounds: BBox;
}

export class ExportTooLargeError extends Error {
  constructor(
    readonly width: number,
    readonly height: number,
    reason: string,
  ) {
    super(
      `Board is too large to export at this scale (${width}x${height}px): ${reason}. ` +
        "Try a lower scale, or export a selection.",
    );
    this.name = "ExportTooLargeError";
  }
}

/** Check the requested output against browser canvas limits. */
export function checkPngSize(
  w: number,
  h: number,
): { ok: true } | { ok: false; reason: string } {
  if (w <= 0 || h <= 0) return { ok: false, reason: "empty region" };
  if (w > MAX_CANVAS_SIDE || h > MAX_CANVAS_SIDE) {
    return { ok: false, reason: `exceeds the ${MAX_CANVAS_SIDE}px per-side limit` };
  }
  if (w * h > MAX_CANVAS_AREA) {
    return { ok: false, reason: "exceeds the total canvas area limit" };
  }
  return { ok: true };
}

/**
 * Render `elements` (in render order) to a PNG blob.
 *
 * Background is TRANSPARENT by default: an exported board is far more often
 * pasted onto something else than viewed standalone, and a transparent PNG can
 * be given a background later while a baked-in white one cannot be removed.
 * The live canvas's own off-white (#f8fafc) and its grid are deliberately not
 * reproduced — they are workspace affordances, not content.
 */
export async function sceneToPng(
  elements: readonly { data: ElementData }[],
  measure: MeasureText,
  options: PngOptions = {},
): Promise<PngResult | null> {
  const content = unionBBox(elements, measure);
  if (!content) return null;

  const margin = options.margin ?? SVG_MARGIN;
  const scale = options.scale ?? 1;
  const bounds: BBox = {
    x: content.x - margin,
    y: content.y - margin,
    w: content.w + margin * 2,
    h: content.h + margin * 2,
  };

  const width = Math.max(1, Math.ceil(bounds.w * scale));
  const height = Math.max(1, Math.ceil(bounds.h * scale));
  const check = checkPngSize(width, height);
  if (!check.ok) throw new ExportTooLargeError(width, height, check.reason);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create an export canvas");

  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, width, height);
  }

  // Reuse the REAL renderer so exported shapes are drawn by the same code that
  // draws them on screen. A viewport translated to the bounds origin puts the
  // content at (0,0); `scale` plays the role dpr plays for the live canvas.
  const viewport = new Viewport({
    offsetX: -bounds.x * scale,
    offsetY: -bounds.y * scale,
    scale,
  });
  const renderer = new Renderer(ctx, { background: "transparent" });
  renderer.renderElements(viewport, elements, { width, height, dpr: 1 });

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("Could not encode PNG");
  return { blob, width, height, bounds };
}
