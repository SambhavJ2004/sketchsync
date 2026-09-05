import type { SceneElement } from "./store";

// Command-based undo/redo. Each command records ONLY the elements the local
// user changed (by id), so undo/redo never touch elements edited remotely by
// someone else. (Snapshotting the whole scene would incorrectly revert remote
// edits — see Phase 3.2.) This is a linear local-only stack, not a CRDT.

export type SceneCommand =
  | { kind: "create"; element: SceneElement }
  | { kind: "delete"; removed: { element: SceneElement; index: number }[] }
  | { kind: "update"; before: SceneElement[]; after: SceneElement[] };

export interface CommandHistory {
  past: SceneCommand[];
  future: SceneCommand[];
}

export function emptyHistory(): CommandHistory {
  return { past: [], future: [] };
}

function replaceById(
  scene: SceneElement[],
  elements: SceneElement[],
): SceneElement[] {
  const map = new Map(elements.map((e) => [e.id, e]));
  return scene.map((e) => map.get(e.id) ?? e);
}

/** Apply a command forward (used by redo). */
export function applyCommand(
  scene: SceneElement[],
  cmd: SceneCommand,
): SceneElement[] {
  switch (cmd.kind) {
    case "create":
      return scene.some((e) => e.id === cmd.element.id)
        ? scene
        : [...scene, cmd.element];
    case "delete": {
      const ids = new Set(cmd.removed.map((r) => r.element.id));
      return scene.filter((e) => !ids.has(e.id));
    }
    case "update":
      return replaceById(scene, cmd.after);
  }
}

/** Apply a command's inverse (used by undo). */
export function invertCommand(
  scene: SceneElement[],
  cmd: SceneCommand,
): SceneElement[] {
  switch (cmd.kind) {
    case "create":
      return scene.filter((e) => e.id !== cmd.element.id);
    case "delete": {
      // Re-insert removed elements at their original indices to keep z-order.
      const next = [...scene];
      const present = new Set(next.map((e) => e.id));
      for (const { element, index } of [...cmd.removed].sort(
        (a, b) => a.index - b.index,
      )) {
        if (present.has(element.id)) continue;
        next.splice(Math.min(index, next.length), 0, element);
      }
      return next;
    }
    case "update":
      return replaceById(scene, cmd.before);
  }
}
