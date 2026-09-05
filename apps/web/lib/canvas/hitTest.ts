import type { ElementData } from "@sketchsync/shared";
import type { Point } from "./viewport";
import { hitElement, type MeasureText } from "./geometry";

export interface Hittable {
  id: string;
  data: ElementData;
}

/**
 * Return the id of the TOPMOST element under `world` (within `tolWorld`), or
 * null. Topmost = last in draw order, so we iterate from the end.
 */
export function hitTest(
  elements: readonly Hittable[],
  world: Point,
  tolWorld: number,
  measure: MeasureText,
): string | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el && hitElement(el.data, world, tolWorld, measure)) return el.id;
  }
  return null;
}
