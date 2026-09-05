import type { Point, Viewport } from "./viewport";
import type { SceneElement } from "./store";
import type { MeasureText } from "./geometry";
import { resizeElement, translateElement } from "./geometry";
import { hitTest } from "./hitTest";
import { computeChrome, hitHandle, type HandleId } from "./selectionChrome";

const HIT_TOL_PX = 6; // click tolerance for thin shapes (screen px)
const MOVE_THRESHOLD_PX = 3; // drag distance before it counts as move/resize

export interface PointerMods {
  shift: boolean;
}

export interface EditCallbacks {
  getScene: () => SceneElement[];
  getSelectedIds: () => string[];
  getViewport: () => Viewport;
  /** False for a VIEWER: selection still works, move/resize never starts. */
  canEdit: () => boolean;
  measure: MeasureText;
  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  previewScene: (scene: SceneElement[]) => void;
  commitScene: (previous: SceneElement[], next: SceneElement[]) => void;
}

interface MoveDrag {
  mode: "move";
  before: SceneElement[];
  ids: string[];
  startWorld: Point;
  startScreen: Point;
  moved: boolean;
}
interface ResizeDrag {
  mode: "resize";
  before: SceneElement[];
  id: string;
  original: SceneElement;
  handle: HandleId;
  startScreen: Point;
  moved: boolean;
}
type Drag = MoveDrag | ResizeDrag;

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Handles the select tool: hit-test handles (resize) then bodies (move/select),
 * with live preview and a single history entry on release. Pure geometry lives
 * in geometry.ts / hitTest.ts; this only orchestrates.
 */
export class EditSession {
  private drag: Drag | null = null;

  constructor(private readonly cb: EditCallbacks) {}

  begin(world: Point, screen: Point, mods: PointerMods): void {
    const vp = this.cb.getViewport();
    const scene = this.cb.getScene();
    const selectedIds = this.cb.getSelectedIds();
    const canEdit = this.cb.canEdit();

    // 1) A resize handle of a selected element? (Never for a read-only client —
    //    handles are not drawn for them either, so there is nothing to grab.)
    if (canEdit) {
      for (const id of selectedIds) {
        const el = scene.find((e) => e.id === id);
        if (!el) continue;
        const chrome = computeChrome(el.data, vp, this.cb.measure);
        const handle = hitHandle(chrome, screen.x, screen.y);
        if (handle) {
          this.drag = {
            mode: "resize",
            before: scene,
            id,
            original: el,
            handle,
            startScreen: screen,
            moved: false,
          };
          return;
        }
      }
    }

    // 2) An element body?
    const tolWorld = HIT_TOL_PX / vp.scale;
    const hitId = hitTest(scene, world, tolWorld, this.cb.measure);
    if (hitId) {
      if (mods.shift) {
        this.cb.toggleSelection(hitId);
        this.drag = null;
        return;
      }
      let ids = selectedIds;
      if (!ids.includes(hitId)) {
        this.cb.setSelection([hitId]);
        ids = [hitId];
      }
      if (!canEdit) {
        // Selection is allowed (it drives selection-scoped export); moving is not.
        this.drag = null;
        return;
      }
      this.drag = {
        mode: "move",
        before: this.cb.getScene(),
        ids,
        startWorld: world,
        startScreen: screen,
        moved: false,
      };
      return;
    }

    // 3) Empty space -> deselect (unless shift-adding).
    if (!mods.shift) this.cb.clearSelection();
    this.drag = null;
  }

  move(world: Point, screen: Point): void {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && dist(screen, d.startScreen) <= MOVE_THRESHOLD_PX) return;
    d.moved = true;
    this.cb.previewScene(this.buildNext(d, world, false));
  }

  end(world: Point): void {
    const d = this.drag;
    this.drag = null;
    if (!d || !d.moved) return; // pure click: selection already applied, no history
    this.cb.commitScene(d.before, this.buildNext(d, world, true));
  }

  /** Apply the move/resize to `before`; `bump` increments version (on commit). */
  private buildNext(d: Drag, world: Point, bump: boolean): SceneElement[] {
    if (d.mode === "move") {
      const dx = world.x - d.startWorld.x;
      const dy = world.y - d.startWorld.y;
      const sel = new Set(d.ids);
      return d.before.map((el) =>
        sel.has(el.id)
          ? {
              ...el,
              version: bump ? el.version + 1 : el.version,
              data: translateElement(el.data, dx, dy),
            }
          : el,
      );
    }
    // resize
    return d.before.map((el) =>
      el.id === d.id
        ? {
            ...el,
            version: bump ? el.version + 1 : el.version,
            data: resizeElement(d.original.data, d.handle, world, this.cb.measure),
          }
        : el,
    );
  }
}
