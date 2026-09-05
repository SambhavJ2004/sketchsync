import { create } from "zustand";
import type { ElementData, Style } from "@sketchsync/shared";
import { withStyle } from "./shapes";
import {
  applyCommand,
  emptyHistory,
  invertCommand,
  type CommandHistory,
} from "./history";
import {
  computeLayerChanges,
  nextZIndex,
  sortScene,
  type LayerAction,
} from "./layers";

export type Tool =
  | "select"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "pencil"
  | "text"
  | "pan";

/**
 * A committed scene element: shared ElementData + local metadata. `zIndex` +
 * `createdAt` mirror the DB columns and drive render order (see `compareZ`).
 */
export interface SceneElement {
  id: string;
  version: number;
  zIndex: number;
  createdAt: string; // ISO
  data: ElementData;
}

/** A local mutation to emit to the realtime gateway. */
export type Outbound =
  | { kind: "create"; id: string; data: ElementData; version: number }
  | { kind: "update"; id: string; data: ElementData; version: number; zIndex: number }
  | { kind: "delete"; id: string; version: number };

interface CanvasState {
  tool: Tool;
  style: Style;
  scene: SceneElement[]; // always kept sorted by (zIndex, createdAt)
  selectedIds: string[];
  history: CommandHistory;
  /** Scene snapshot taken at the start of a style-preview gesture. */
  stylePreviewBase: SceneElement[] | null;
  outbound: (op: Outbound) => void;
  /**
   * Whether this client's role permits writes (EDITOR or OWNER).
   *
   * THIS IS UX, NOT SECURITY. The gateway checks `roleAtLeast(role, EDITOR)` on
   * every elementCreate/Update/Delete and remains the only authority — see
   * `canWrite` in apps/realtime/src/messages.ts. Do NOT remove that check on the
   * grounds that the client already blocks it: this flag comes from a fetch the
   * user controls, and a hand-crafted socket frame never passes through here.
   *
   * What it buys is the thing the server cannot fix: a VIEWER used to draw, see
   * the shape render optimistically, have it silently rejected, and lose the
   * work on reload. Every mutating action below is gated so nothing enters the
   * scene, history, or the outbound sink that the server will refuse.
   */
  canEdit: boolean;

  setCanEdit: (canEdit: boolean) => void;
  setTool: (tool: Tool) => void;
  setStyle: (patch: Partial<Style>) => void;
  setOutbound: (fn: (op: Outbound) => void) => void;

  select: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;

  addElement: (data: ElementData) => string;
  deleteSelected: () => void;
  applyStyleToSelection: (patch: Partial<Style>) => void;
  /** Live style change with NO history entry and NO network emit. */
  previewStyleOnSelection: (patch: Partial<Style>) => void;
  /** Commit the accumulated preview as ONE history entry + one emit per element. */
  commitStylePreview: () => void;
  layerAction: (action: LayerAction) => void;
  replaceScene: (scene: SceneElement[]) => void; // live drag preview (no history)
  commitScene: (previous: SceneElement[], next: SceneElement[]) => void;

  undo: () => void;
  redo: () => void;

  applyRemoteSync: (elements: SceneElement[], keepIds?: Set<string>) => void;
  applyRemoteCreate: (element: SceneElement) => void;
  applyRemoteUpdate: (element: SceneElement) => void;
  applyRemoteDelete: (id: string) => void;
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  tool: "select",
  style: { stroke: "#111827", width: 2 },
  scene: [],
  selectedIds: [],
  history: emptyHistory(),
  stylePreviewBase: null,
  outbound: () => {},
  canEdit: true,

  setCanEdit: (canEdit) => set({ canEdit }),
  // A read-only client may still pick select (to inspect / export a selection)
  // and pan. Gating here covers BOTH entry points at once — the toolbar buttons
  // and the `v r o l a p t h` shortcuts.
  setTool: (tool) =>
    set((s) =>
      s.canEdit || tool === "select" || tool === "pan" ? { tool } : {},
    ),
  setStyle: (patch) => set((s) => ({ style: { ...s.style, ...patch } })),
  setOutbound: (fn) => set({ outbound: fn }),

  select: (ids) => set({ selectedIds: ids }),
  toggleSelection: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),
  clearSelection: () => set({ selectedIds: [] }),

  addElement: (data) => {
    const s = get();
    if (!s.canEdit) return ""; // read-only: never render what the server will refuse
    const id = crypto.randomUUID();
    const element: SceneElement = {
      id,
      version: 1,
      zIndex: nextZIndex(s.scene), // optimistic; server assigns authoritatively
      createdAt: new Date().toISOString(),
      data,
    };
    set((st) => ({
      scene: sortScene([...st.scene, element]),
      history: { past: [...st.history.past, { kind: "create", element }], future: [] },
    }));
    get().outbound({ kind: "create", id, data, version: 1 });
    return id;
  },

  deleteSelected: () => {
    const s = get();
    if (!s.canEdit) return;
    if (s.selectedIds.length === 0) return;
    const sel = new Set(s.selectedIds);
    const removed: { element: SceneElement; index: number }[] = [];
    s.scene.forEach((e, index) => {
      if (sel.has(e.id)) removed.push({ element: e, index });
    });
    if (removed.length === 0) return;
    set((st) => ({
      scene: st.scene.filter((e) => !sel.has(e.id)),
      selectedIds: [],
      history: { past: [...st.history.past, { kind: "delete", removed }], future: [] },
    }));
    for (const { element } of removed) {
      get().outbound({ kind: "delete", id: element.id, version: element.version });
    }
  },

  applyStyleToSelection: (patch) => {
    const s = get();
    if (!s.canEdit) return;
    if (s.selectedIds.length === 0) {
      set({ style: { ...s.style, ...patch } });
      return;
    }
    const sel = new Set(s.selectedIds);
    const before: SceneElement[] = [];
    const after: SceneElement[] = [];
    const next = s.scene.map((e) => {
      if (!sel.has(e.id)) return e;
      const updated: SceneElement = {
        ...e,
        version: e.version + 1,
        data: withStyle(e.data, patch),
      };
      before.push(e);
      after.push(updated);
      return updated;
    });
    if (after.length === 0) return;
    set((st) => ({
      scene: next,
      history: { past: [...st.history.past, { kind: "update", before, after }], future: [] },
    }));
    for (const el of after) {
      get().outbound({ kind: "update", id: el.id, data: el.data, version: el.version, zIndex: el.zIndex });
    }
  },

  /**
   * Continuous style preview, e.g. dragging in a colour picker.
   *
   * `<input type="color">` fires React onChange on every pointer move, so
   * routing it through applyStyleToSelection produced one undo entry (and one
   * network mutation) per frame. Preview updates the scene only; the version is
   * NOT bumped and nothing is emitted, so the picker stays live while history
   * and the wire see a single change on commit.
   */
  previewStyleOnSelection: (patch) => {
    const s = get();
    if (!s.canEdit) return;
    if (s.selectedIds.length === 0) {
      // No selection: this sets new-shape defaults, which never touched history
      // anyway. Nothing to debounce, but routed here for one code path.
      set({ style: { ...s.style, ...patch } });
      return;
    }
    const sel = new Set(s.selectedIds);
    set((st) => ({
      // Snapshot the pre-drag scene ONCE, on the first preview of a gesture.
      stylePreviewBase: st.stylePreviewBase ?? st.scene,
      scene: st.scene.map((e) =>
        sel.has(e.id) ? { ...e, data: withStyle(e.data, patch) } : e,
      ),
    }));
  },

  commitStylePreview: () => {
    const s = get();
    if (!s.canEdit) return;
    const base = s.stylePreviewBase;
    if (!base) return; // nothing previewed (e.g. defaults-only change)
    const baseById = new Map(base.map((e) => [e.id, e]));
    const before: SceneElement[] = [];
    const after: SceneElement[] = [];
    const next = s.scene.map((e) => {
      const b = baseById.get(e.id);
      // Only elements whose style actually moved during the gesture.
      if (!b || JSON.stringify(b.data) === JSON.stringify(e.data)) return e;
      const bumped: SceneElement = { ...e, version: e.version + 1 };
      before.push(b);
      after.push(bumped);
      return bumped;
    });
    if (after.length === 0) {
      set({ stylePreviewBase: null });
      return;
    }
    set((st) => ({
      scene: next,
      stylePreviewBase: null,
      history: { past: [...st.history.past, { kind: "update", before, after }], future: [] },
    }));
    for (const el of after) {
      get().outbound({ kind: "update", id: el.id, data: el.data, version: el.version, zIndex: el.zIndex });
    }
  },

  layerAction: (action) => {
    const s = get();
    if (!s.canEdit) return;
    if (s.selectedIds.length !== 1) return; // single-select only
    const targetId = s.selectedIds[0];
    if (!targetId) return;
    const changes = computeLayerChanges(s.scene, targetId, action);
    if (!changes || changes.length === 0) return;

    const changeMap = new Map(changes.map((c) => [c.id, c.zIndex]));
    const before: SceneElement[] = [];
    const after: SceneElement[] = [];
    const nextRaw = s.scene.map((e) => {
      const z = changeMap.get(e.id);
      if (z === undefined) return e;
      const updated: SceneElement = { ...e, version: e.version + 1, zIndex: z };
      before.push(e);
      after.push(updated);
      return updated;
    });
    set((st) => ({
      scene: sortScene(nextRaw),
      history: { past: [...st.history.past, { kind: "update", before, after }], future: [] },
    }));
    for (const el of after) {
      get().outbound({ kind: "update", id: el.id, data: el.data, version: el.version, zIndex: el.zIndex });
    }
  },

  replaceScene: (scene) => set({ scene }),

  commitScene: (previous, next) => {
    // Read-only: restore the pre-drag scene rather than keeping a preview that
    // would never be persisted. EditSession refuses to start a drag at all, so
    // this is the belt to that braces.
    if (!get().canEdit) {
      set({ scene: sortScene(previous) });
      return;
    }
    const prevMap = new Map(previous.map((e) => [e.id, e]));
    const before: SceneElement[] = [];
    const after: SceneElement[] = [];
    for (const el of next) {
      const b = prevMap.get(el.id);
      if (b && b.version !== el.version) {
        before.push(b);
        after.push(el);
      }
    }
    if (after.length === 0) {
      set({ scene: sortScene(next) });
      return;
    }
    set((s) => ({
      scene: sortScene(next),
      history: { past: [...s.history.past, { kind: "update", before, after }], future: [] },
    }));
    for (const el of after) {
      get().outbound({ kind: "update", id: el.id, data: el.data, version: el.version, zIndex: el.zIndex });
    }
  },

  undo: () =>
    set((s) => {
      const cmd = s.history.past.at(-1);
      if (!cmd) return {};
      const scene = sortScene(invertCommand(s.scene, cmd));
      const ids = new Set(scene.map((e) => e.id));
      return {
        scene,
        history: { past: s.history.past.slice(0, -1), future: [...s.history.future, cmd] },
        selectedIds: s.selectedIds.filter((id) => ids.has(id)),
      };
    }),

  redo: () =>
    set((s) => {
      const cmd = s.history.future.at(-1);
      if (!cmd) return {};
      const scene = sortScene(applyCommand(s.scene, cmd));
      const ids = new Set(scene.map((e) => e.id));
      return {
        scene,
        history: { past: [...s.history.past, cmd], future: s.history.future.slice(0, -1) },
        selectedIds: s.selectedIds.filter((id) => ids.has(id)),
      };
    }),

  applyRemoteSync: (elements, keepIds) =>
    set((s) => {
      const incoming = new Set(elements.map((e) => e.id));
      // A snapshot is authoritative EXCEPT for elements drawn during the connect
      // window: those were queued client-side, so the server has not seen them
      // yet and cannot include them. Since the server never echoes a sender its
      // own create, a plain wholesale replace would delete them permanently.
      const preserved =
        keepIds && keepIds.size > 0
          ? s.scene.filter((e) => keepIds.has(e.id) && !incoming.has(e.id))
          : [];
      const next = sortScene([...elements, ...preserved]);
      const ids = new Set(next.map((e) => e.id));
      return {
        scene: next,
        history: emptyHistory(),
        selectedIds: s.selectedIds.filter((id) => ids.has(id)),
      };
    }),

  applyRemoteCreate: (element) =>
    set((s) => {
      const existing = s.scene.find((e) => e.id === element.id);
      if (!existing) return { scene: sortScene([...s.scene, element]) };
      if (element.version < existing.version) return {};
      return { scene: sortScene(s.scene.map((e) => (e.id === element.id ? element : e))) };
    }),

  applyRemoteUpdate: (element) =>
    set((s) => {
      const existing = s.scene.find((e) => e.id === element.id);
      if (!existing) return { scene: sortScene([...s.scene, element]) };
      if (element.version < existing.version) return {}; // stale echo — drop
      return { scene: sortScene(s.scene.map((e) => (e.id === element.id ? element : e))) };
    }),

  applyRemoteDelete: (id) =>
    set((s) => ({
      scene: s.scene.filter((e) => e.id !== id),
      selectedIds: s.selectedIds.filter((x) => x !== id),
    })),
}));
