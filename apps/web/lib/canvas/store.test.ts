import { beforeEach, describe, expect, it } from "vitest";
import { useCanvasStore, type SceneElement } from "./store";
import { computeLayerChanges } from "./layers";

// ACCEPTANCE CRITERION for server-side renormalization: a routine z-nudge by
// anyone must not destroy a local user's undo history. `applyRemoteSync` clears
// history by design; `applyRemote{Create,Update,Delete}` must not touch it.

const style = { stroke: "#111827", width: 2 };

function el(id: string, zIndex: number, x = 0): SceneElement {
  return {
    id,
    version: 1,
    zIndex,
    createdAt: new Date(1_700_000_000_000 + zIndex * 1000).toISOString(),
    data: { type: "rect", x, y: 0, width: 10, height: 10, style },
  };
}

function seed(n: number): SceneElement[] {
  return Array.from({ length: n }, (_, i) => el(`el-${i}`, i + 1, i));
}

beforeEach(() => {
  useCanvasStore.setState({
    scene: [],
    selectedIds: [],
    history: { past: [], future: [] },
    outbound: () => {},
    tool: "select",
    canEdit: true,
    stylePreviewBase: null,
  });
});

describe("undo survives a server renormalization", () => {
  it("remote updates do not touch the undo stack", () => {
    const s = useCanvasStore.getState();
    s.applyRemoteSync(seed(5));

    // A local edit the user would expect to be able to undo.
    const before = useCanvasStore.getState().scene;
    const moved = before.map((e) =>
      e.id === "el-2" ? { ...e, version: e.version + 1, data: { ...e.data, x: 999 } } : e,
    );
    useCanvasStore.getState().commitScene(before, moved);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);

    // Server renormalizes the whole board -> N remote elementUpdates.
    for (const e of useCanvasStore.getState().scene) {
      useCanvasStore.getState().applyRemoteUpdate({
        ...e,
        version: e.version + 1,
        zIndex: e.zIndex * 10, // renumbered
      });
    }

    // History is intact...
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    // ...and undo still reverts the local edit.
    useCanvasStore.getState().undo();
    const undone = useCanvasStore.getState().scene.find((e) => e.id === "el-2");
    expect(undone?.data).toMatchObject({ x: 2 });
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    expect(useCanvasStore.getState().history.future).toHaveLength(1);
  });

  it("a full sync DOES clear the undo stack (why renorm must not re-sync)", () => {
    const s = useCanvasStore.getState();
    s.applyRemoteSync(seed(3));
    const before = useCanvasStore.getState().scene;
    useCanvasStore
      .getState()
      .commitScene(before, before.map((e) => ({ ...e, version: e.version + 1 })));
    expect(useCanvasStore.getState().history.past).toHaveLength(1);

    useCanvasStore.getState().applyRemoteSync(seed(3));
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    expect(useCanvasStore.getState().history.future).toHaveLength(0);
  });

  it("renormalized order is applied and re-sorted locally", () => {
    useCanvasStore.getState().applyRemoteSync(seed(4));
    // Server sends a reversed renumbering.
    const scene = useCanvasStore.getState().scene;
    scene.forEach((e, i) => {
      useCanvasStore.getState().applyRemoteUpdate({
        ...e,
        version: e.version + 1,
        zIndex: scene.length - i,
      });
    });
    const ids = useCanvasStore.getState().scene.map((e) => e.id);
    expect(ids).toEqual(["el-3", "el-2", "el-1", "el-0"]);
  });
});

describe("a layer action emits exactly ONE mutation", () => {
  it("computeLayerChanges never returns a whole-board rewrite", () => {
    const scene = seed(200);
    for (const action of ["forward", "backward", "front", "back"] as const) {
      const changes = computeLayerChanges(scene, "el-100", action);
      expect(changes).not.toBeNull();
      expect(changes).toHaveLength(1);
      expect(changes?.[0]?.id).toBe("el-100");
    }
  });

  it("still returns a single change once the gap has collapsed", () => {
    // Two neighbours a hair apart: previously this triggered a client-side
    // renormalization emitting one update per element in the room.
    const scene = [el("a", 1), el("b", 1 + 1e-12), el("c", 2)];
    const changes = computeLayerChanges(scene, "c", "backward");
    expect(changes).toHaveLength(1);
  });

  it("emits one outbound op per layer action", () => {
    const ops: unknown[] = [];
    useCanvasStore.getState().applyRemoteSync(seed(200));
    useCanvasStore.getState().setOutbound((op) => ops.push(op));
    useCanvasStore.getState().select(["el-100"]);
    useCanvasStore.getState().layerAction("backward");
    expect(ops).toHaveLength(1);
  });
});

// A VIEWER used to draw, render optimistically, be refused by the gateway, and
// lose the work on reload. The store is the choke point that makes that
// impossible: nothing may enter the scene, history, OR the outbound sink.
// The server check is still authoritative — this is UX, not security.
describe("read-only role (canEdit=false) commits nothing", () => {
  function readOnly(): unknown[] {
    const ops: unknown[] = [];
    useCanvasStore.getState().applyRemoteSync(seed(3));
    useCanvasStore.getState().setOutbound((op) => ops.push(op));
    useCanvasStore.getState().setCanEdit(false);
    return ops;
  }

  it("addElement is a no-op: no scene entry, no history, no emit", () => {
    const ops = readOnly();
    const before = useCanvasStore.getState().scene.length;
    const id = useCanvasStore
      .getState()
      .addElement({ type: "rect", x: 0, y: 0, width: 10, height: 10, style });
    expect(id).toBe("");
    expect(useCanvasStore.getState().scene).toHaveLength(before);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    expect(ops).toHaveLength(0);
  });

  it("delete, style, layer and commitScene all emit nothing", () => {
    const ops = readOnly();
    const scene = useCanvasStore.getState().scene;
    useCanvasStore.getState().select([scene[1]!.id]);

    useCanvasStore.getState().deleteSelected();
    useCanvasStore.getState().applyStyleToSelection({ stroke: "#ff0000" });
    useCanvasStore.getState().previewStyleOnSelection({ stroke: "#00ff00" });
    useCanvasStore.getState().commitStylePreview();
    useCanvasStore.getState().layerAction("backward");
    useCanvasStore
      .getState()
      .commitScene(scene, scene.map((e) => ({ ...e, version: e.version + 1 })));

    expect(ops).toHaveLength(0);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    // The scene is untouched — including versions, which commitScene restores.
    expect(useCanvasStore.getState().scene).toEqual(scene);
  });

  it("only select and pan tools are reachable", () => {
    readOnly();
    for (const t of ["rect", "ellipse", "line", "arrow", "pencil", "text"] as const) {
      useCanvasStore.getState().setTool(t);
      expect(useCanvasStore.getState().tool).toBe("select");
    }
    useCanvasStore.getState().setTool("pan");
    expect(useCanvasStore.getState().tool).toBe("pan");
  });

  it("remote deltas still apply — read-only is not disconnected", () => {
    readOnly();
    const extra = el("remote-1", 99);
    useCanvasStore.getState().applyRemoteCreate(extra);
    expect(useCanvasStore.getState().scene.map((e) => e.id)).toContain("remote-1");
  });
});

describe("style preview debounce — one colour change, one undo entry", () => {
  function seedSelected(): string {
    useCanvasStore.getState().applyRemoteSync(seed(3));
    const id = useCanvasStore.getState().scene[1]!.id;
    useCanvasStore.getState().select([id]);
    return id;
  }

  it("preview writes NO history and NO outbound", () => {
    const ops: unknown[] = [];
    const id = seedSelected();
    useCanvasStore.getState().setOutbound((op) => ops.push(op));

    for (const c of ["#111111", "#222222", "#333333", "#444444"]) {
      useCanvasStore.getState().previewStyleOnSelection({ stroke: c });
    }
    // Live preview reached the scene...
    const el = useCanvasStore.getState().scene.find((e) => e.id === id)!;
    expect(el.data.style.stroke).toBe("#444444");
    // ...but nothing was committed.
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    expect(ops).toHaveLength(0);
  });

  it("commit turns a whole drag into exactly ONE history entry and one emit", () => {
    const ops: unknown[] = [];
    const id = seedSelected();
    useCanvasStore.getState().setOutbound((op) => ops.push(op));

    for (const c of ["#111111", "#222222", "#333333", "#444444"]) {
      useCanvasStore.getState().previewStyleOnSelection({ stroke: c });
    }
    useCanvasStore.getState().commitStylePreview();

    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(ops).toHaveLength(1);
    expect(useCanvasStore.getState().scene.find((e) => e.id === id)!.data.style.stroke).toBe(
      "#444444",
    );
  });

  it("a single undo reverts the entire drag to the pre-drag colour", () => {
    const id = seedSelected();
    const original = useCanvasStore.getState().scene.find((e) => e.id === id)!.data.style.stroke;

    for (const c of ["#111111", "#222222", "#333333"]) {
      useCanvasStore.getState().previewStyleOnSelection({ stroke: c });
    }
    useCanvasStore.getState().commitStylePreview();
    useCanvasStore.getState().undo();

    expect(
      useCanvasStore.getState().scene.find((e) => e.id === id)!.data.style.stroke,
    ).toBe(original);
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
  });

  it("commit with no preview is a no-op", () => {
    seedSelected();
    useCanvasStore.getState().commitStylePreview();
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
  });

  it("a preview that ends on the ORIGINAL colour commits nothing", () => {
    const id = seedSelected();
    const original = useCanvasStore.getState().scene.find((e) => e.id === id)!.data.style.stroke;
    useCanvasStore.getState().previewStyleOnSelection({ stroke: "#abcdef" });
    useCanvasStore.getState().previewStyleOnSelection({ stroke: original });
    useCanvasStore.getState().commitStylePreview();
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
  });

  it("with no selection it sets defaults and touches no history", () => {
    useCanvasStore.getState().applyRemoteSync(seed(2));
    useCanvasStore.getState().select([]);
    useCanvasStore.getState().previewStyleOnSelection({ stroke: "#0000ff" });
    expect(useCanvasStore.getState().style.stroke).toBe("#0000ff");
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
  });

  it("bumps version exactly once across the whole drag", () => {
    const id = seedSelected();
    const v0 = useCanvasStore.getState().scene.find((e) => e.id === id)!.version;
    for (const c of ["#111111", "#222222", "#333333", "#444444", "#555555"]) {
      useCanvasStore.getState().previewStyleOnSelection({ stroke: c });
    }
    useCanvasStore.getState().commitStylePreview();
    expect(useCanvasStore.getState().scene.find((e) => e.id === id)!.version).toBe(v0 + 1);
  });
});
