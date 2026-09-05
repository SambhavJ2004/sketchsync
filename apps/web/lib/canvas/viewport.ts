export interface Point {
  x: number;
  y: number;
}

export interface ViewportState {
  /** Screen-x (CSS px) where world x=0 lands. */
  offsetX: number;
  /** Screen-y (CSS px) where world y=0 lands. */
  offsetY: number;
  /** Screen pixels per world unit. */
  scale: number;
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Owns the pan/zoom transform between WORLD space (the infinite canvas) and
 * SCREEN space (CSS pixels, origin at the canvas top-left). Pure logic — no DOM,
 * no canvas — so it can be unit-tested in isolation.
 *
 *   screen = world * scale + offset
 *   world  = (screen - offset) / scale
 */
export class Viewport {
  offsetX: number;
  offsetY: number;
  scale: number;

  constructor(state: Partial<ViewportState> = {}) {
    this.offsetX = state.offsetX ?? 0;
    this.offsetY = state.offsetY ?? 0;
    this.scale = clamp(state.scale ?? 1, MIN_SCALE, MAX_SCALE);
  }

  screenToWorld(screenX: number, screenY: number): Point {
    return {
      x: (screenX - this.offsetX) / this.scale,
      y: (screenY - this.offsetY) / this.scale,
    };
  }

  worldToScreen(worldX: number, worldY: number): Point {
    return {
      x: worldX * this.scale + this.offsetX,
      y: worldY * this.scale + this.offsetY,
    };
  }

  /** Move the scene by a screen-space delta (CSS px). */
  panBy(dxScreen: number, dyScreen: number): void {
    this.offsetX += dxScreen;
    this.offsetY += dyScreen;
  }

  /**
   * Multiply the current scale by `factor`, keeping the world point currently
   * under (anchorScreenX, anchorScreenY) fixed at that same screen position.
   * Scale is clamped to [MIN_SCALE, MAX_SCALE]; when clamping bites, the anchor
   * still stays put because we recompute the offset from the *applied* scale.
   */
  zoomTo(factor: number, anchorScreenX: number, anchorScreenY: number): void {
    const nextScale = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    if (nextScale === this.scale) return;

    // World point under the anchor before zooming.
    const world = this.screenToWorld(anchorScreenX, anchorScreenY);

    this.scale = nextScale;
    // Re-place the offset so that world maps back onto the anchor:
    //   anchor = world * nextScale + offset  =>  offset = anchor - world * nextScale
    this.offsetX = anchorScreenX - world.x * nextScale;
    this.offsetY = anchorScreenY - world.y * nextScale;
  }

  getState(): ViewportState {
    return { offsetX: this.offsetX, offsetY: this.offsetY, scale: this.scale };
  }
}
