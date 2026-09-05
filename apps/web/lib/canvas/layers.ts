import type { SceneElement } from "./store";

export type LayerAction = "front" | "back" | "forward" | "backward";
export interface ZChange {
  id: string;
  zIndex: number;
}

// NOTE: renormalization is SERVER-side (see apps/realtime/src/zorder.ts). The
// client only ever inserts at the midpoint and emits ONE update for the one
// element that moved; when the gaps collapse the server renumbers the board in
// a single transaction and broadcasts the result. Doing it here meant emitting
// one mutation per element in the room — an unbounded burst.

/** Render order: ascending zIndex, then createdAt, then id (fully deterministic). */
export function compareZ(a: SceneElement, b: SceneElement): number {
  if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortScene(elements: readonly SceneElement[]): SceneElement[] {
  return [...elements].sort(compareZ);
}

/** zIndex for a new element: above the current max (or a base if the room is empty). */
export function nextZIndex(elements: readonly SceneElement[]): number {
  let max = 0;
  let any = false;
  for (const e of elements) {
    if (!any || e.zIndex > max) {
      max = e.zIndex;
      any = true;
    }
  }
  return any ? max + 1 : 1;
}

/**
 * Compute the zIndex change for a layer action on `targetId`. Returns null for
 * a no-op (already at the extreme), otherwise EXACTLY ONE change — the element
 * that moved. Never returns a whole-board rewrite; that is the server's job.
 */
export function computeLayerChanges(
  scene: readonly SceneElement[],
  targetId: string,
  action: LayerAction,
): ZChange[] | null {
  const sorted = sortScene(scene);
  const n = sorted.length;
  const i = sorted.findIndex((e) => e.id === targetId);
  if (i < 0) return null;

  if (action === "front") {
    const top = sorted[n - 1];
    if (!top || i === n - 1) return null;
    return [{ id: targetId, zIndex: top.zIndex + 1 }];
  }
  if (action === "back") {
    const bottom = sorted[0];
    if (!bottom || i === 0) return null;
    return [{ id: targetId, zIndex: bottom.zIndex - 1 }];
  }

  // forward / backward: move the target one step and place it between its new
  // neighbours (midpoint) so unrelated elements keep their values.
  const j = action === "forward" ? i + 1 : i - 1;
  if (j < 0 || j >= n) return null;

  const order = [...sorted];
  const a = order[i];
  const b = order[j];
  if (!a || !b) return null;
  order[i] = b;
  order[j] = a; // target now sits at index j

  const lower = j - 1 >= 0 ? order[j - 1] : undefined;
  const upper = j + 1 < n ? order[j + 1] : undefined;

  // Midpoint between the new neighbours, so unrelated elements keep their
  // values. If the gap has collapsed this may land on (or beside) a neighbour —
  // that's fine and expected: the server detects the collapse and renumbers.
  if (lower && upper) {
    return [{ id: targetId, zIndex: (lower.zIndex + upper.zIndex) / 2 }];
  }
  if (lower) return [{ id: targetId, zIndex: lower.zIndex + 1 }];
  if (upper) return [{ id: targetId, zIndex: upper.zIndex - 1 }];
  return null;
}
