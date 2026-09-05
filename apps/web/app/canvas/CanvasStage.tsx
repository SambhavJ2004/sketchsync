"use client";

import { useEffect, useRef, useState } from "react";
import { Eye } from "lucide-react";
import {
  MAX_TEXT_LENGTH,
  type ElementData,
  type Element as WireElement,
  type PresenceUser,
} from "@sketchsync/shared";
import { Viewport } from "@/lib/canvas/viewport";
import { Renderer, type RemoteCursor } from "@/lib/canvas/renderer";
import { Input } from "@/lib/canvas/input";
import { DrawSession } from "@/lib/canvas/drawSession";
import { EditSession } from "@/lib/canvas/editSession";
import { createText } from "@/lib/canvas/shapes";
import { computeChrome, type SelectionChrome } from "@/lib/canvas/selectionChrome";
import { measureTextWidth } from "@/lib/canvas/textMeasure";
import {
  useCanvasStore,
  type Outbound,
  type SceneElement,
  type Tool,
} from "@/lib/canvas/store";
import { RealtimeClient, type RealtimeStatus } from "@/lib/realtime/socket";
import { userColor } from "@/lib/realtime/userColor";
import { REALTIME_URL, api, type AuthUser, type Role } from "@/lib/api/client";
import { BoardChrome } from "@/components/BoardChrome";
import { useToast } from "@/components/Toast";
import { isTypingElement, isTypingNow } from "@/lib/canvas/keyboard";
import { useShortcutLabels } from "@/lib/shortcutLabel";
import {
  e2eCountTicket,
  e2eRegisterDrop,
  e2eRegisterDropped,
  e2eSetStatus,
  installE2EHook,
} from "@/lib/canvas/testHook";
import { Toolbar } from "./Toolbar";
import { StylePanel } from "./StylePanel";
import { PresencePanel } from "./PresencePanel";
import { ConnectionStatus } from "./ConnectionStatus";

const DEFAULT_FONT_SIZE = 24; // world units
const FONT_STACK = "ui-sans-serif, system-ui, -apple-system, sans-serif";

const CURSOR_EMIT_MS = 50; // throttle: ~20 cursor emits/sec
const CURSOR_STALE_MS = 5000; // hide a cursor with no update for this long
const CURSOR_LERP = 0.25; // glide factor toward the latest target each frame

interface Props {
  /** The room this board syncs to (server DB id, not the slug). */
  roomId: string;
  /** Display name shown in the board chrome. */
  roomName: string;
  /** URL slug for the "copy link" button. */
  slug: string;
  /** The signed-in user (id marks "you" in presence). */
  user: AuthUser;
  /** The caller's role in this room. Below EDITOR the board is read-only. */
  role: Role;
}

interface RemoteCursorState {
  cur: { x: number; y: number }; // interpolated (drawn) position, world coords
  target: { x: number; y: number }; // latest received position
  lastSeen: number;
}

interface Readout {
  zoom: number;
  worldX: number;
  worldY: number;
}

interface TextEdit {
  screenX: number;
  screenY: number;
  worldX: number;
  worldY: number;
  scale: number; // frozen while editing (nav is locked)
}

function toolCursor(tool: Tool): string {
  switch (tool) {
    case "pan":
      return "cursor-grab";
    case "text":
      return "cursor-text";
    case "select":
      return "cursor-default";
    default:
      return "cursor-crosshair";
  }
}

export function CanvasStage({ roomId, roomName, slug, user, role }: Props) {
  const staticRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef<HTMLCanvasElement>(null);
  const editingRef = useRef(false); // mirrors "a text box is open" for Input nav-lock

  const [readout, setReadout] = useState<Readout>({
    zoom: 100,
    worldX: 0,
    worldY: 0,
  });
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [textValue, setTextValue] = useState("");
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [hasConnected, setHasConnected] = useState(false);
  const myUserId = user.id;
  const { show } = useToast();
  const labels = useShortcutLabels();

  // ROLE GATE — UX only. The gateway independently refuses writes from anyone
  // below EDITOR (`canWrite` in apps/realtime/src/messages.ts) and stays the
  // authority; this only stops a VIEWER from rendering work that would be
  // rejected and lost. Mirrors ROLE_RANK in @sketchsync/db, which cannot be
  // imported here — it is Prisma-backed and server-only.
  const canEdit = role === "OWNER" || role === "EDITOR";

  const tool = useCanvasStore((s) => s.tool);
  const style = useCanvasStore((s) => s.style);
  const isEmpty = useCanvasStore((s) => s.scene.length === 0);

  useEffect(() => {
    const staticCanvas = staticRef.current;
    const activeCanvas = activeRef.current;
    if (!staticCanvas || !activeCanvas) return;
    const staticCtx = staticCanvas.getContext("2d");
    const activeCtx = activeCanvas.getContext("2d");
    if (!staticCtx || !activeCtx) return;

    // Enforcement copy. Set before any session can read it.
    useCanvasStore.getState().setCanEdit(canEdit);

    const viewport = new Viewport({ offsetX: 60, offsetY: 60, scale: 1 });
    const sceneRenderer = new Renderer(staticCtx, { gridSize: 40 });
    const overlayRenderer = new Renderer(activeCtx);

    let draft: ElementData | null = null;

    // Realtime cursors + presence (ephemeral; never in the scene/undo).
    const cursors = new Map<string, RemoteCursorState>();
    let presenceIds = new Set<string>();
    const presenceNames = new Map<string, string>();
    let socket: RealtimeClient | null = null;
    let lastCursorEmit = 0;

    let dpr = 1;
    let cssWidth = 0;
    let cssHeight = 0;
    let frame = 0;
    let cursorRaf = 0;
    let staticDirty = true;
    let activeDirty = true;

    const view = () => ({ width: cssWidth, height: cssHeight, dpr });

    const buildCursorList = (): RemoteCursor[] => {
      const list: RemoteCursor[] = [];
      for (const [userId, c] of cursors) {
        const s = viewport.worldToScreen(c.cur.x, c.cur.y);
        list.push({
          x: s.x,
          y: s.y,
          color: userColor(userId),
          name: presenceNames.get(userId) ?? "",
        });
      }
      return list;
    };

    // Draws ONLY the overlay layer (draft + selection chrome + remote cursors).
    const renderActiveLayer = (): void => {
      const st = useCanvasStore.getState();
      let selection: SelectionChrome[] | null = null;
      if (!draft && st.tool === "select" && st.selectedIds.length > 0) {
        selection = [];
        for (const id of st.selectedIds) {
          const el = st.scene.find((e) => e.id === id);
          if (!el) continue;
          const chrome = computeChrome(el.data, viewport, measureTextWidth);
          // A read-only client keeps the outline (it shows what a
          // selection-scoped export will contain) but not the resize handles —
          // an affordance that cannot do anything is worse than none.
          selection.push(canEdit ? chrome : { ...chrome, handles: [] });
        }
      }
      const cursorList = cursors.size > 0 ? buildCursorList() : null;
      overlayRenderer.renderOverlay(
        viewport,
        { draft, selection, cursors: cursorList },
        view(),
      );
    };

    const paint = (): void => {
      frame = 0;
      if (staticDirty) {
        sceneRenderer.renderScene(viewport, useCanvasStore.getState().scene, view());
        staticDirty = false;
      }
      if (activeDirty) {
        renderActiveLayer();
        activeDirty = false;
      }
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(paint);
    };
    const markStatic = (): void => {
      staticDirty = true;
      schedule();
    };
    const markActive = (): void => {
      activeDirty = true;
      schedule();
    };
    const markBoth = (): void => {
      staticDirty = true;
      activeDirty = true;
      schedule();
    };

    // While cursors exist: lerp toward targets, prune stale/departed, and repaint
    // ONLY the overlay each frame (never the scene layer).
    const animateCursors = (): void => {
      cursorRaf = 0;
      const now = performance.now();
      let alive = false;
      for (const [userId, c] of cursors) {
        if (now - c.lastSeen > CURSOR_STALE_MS || !presenceIds.has(userId)) {
          cursors.delete(userId);
          continue;
        }
        c.cur.x += (c.target.x - c.cur.x) * CURSOR_LERP;
        c.cur.y += (c.target.y - c.cur.y) * CURSOR_LERP;
        alive = true;
      }
      renderActiveLayer();
      if (alive) cursorRaf = requestAnimationFrame(animateCursors);
    };
    const ensureCursorLoop = (): void => {
      if (cursorRaf === 0) cursorRaf = requestAnimationFrame(animateCursors);
    };

    const resize = (): void => {
      dpr = window.devicePixelRatio || 1;
      const rect = activeCanvas.getBoundingClientRect();
      cssWidth = rect.width;
      cssHeight = rect.height;
      for (const c of [staticCanvas, activeCanvas]) {
        c.width = Math.round(cssWidth * dpr);
        c.height = Math.round(cssHeight * dpr);
      }
      markBoth();
    };

    let dprMedia: MediaQueryList | null = null;
    const onDprChange = (): void => {
      resize();
      armDprListener();
    };
    const armDprListener = (): void => {
      dprMedia?.removeEventListener("change", onDprChange);
      dprMedia = window.matchMedia(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`,
      );
      dprMedia.addEventListener("change", onDprChange);
    };

    resize();
    armDprListener();
    window.addEventListener("resize", resize);

    const drawSession = new DrawSession({
      getTool: () => useCanvasStore.getState().tool,
      getStyle: () => useCanvasStore.getState().style,
      onPreview: (d) => {
        draft = d;
        markActive();
      },
      onCommit: (data) => useCanvasStore.getState().addElement(data),
      onRequestText: (world, screen) => {
        editingRef.current = true;
        setTextValue("");
        setTextEdit({
          screenX: screen.x,
          screenY: screen.y,
          worldX: world.x,
          worldY: world.y,
          scale: viewport.scale,
        });
      },
    });

    const editSession = new EditSession({
      getScene: () => useCanvasStore.getState().scene,
      getSelectedIds: () => useCanvasStore.getState().selectedIds,
      getViewport: () => viewport,
      canEdit: () => useCanvasStore.getState().canEdit,
      measure: measureTextWidth,
      setSelection: (ids) => useCanvasStore.getState().select(ids),
      toggleSelection: (id) => useCanvasStore.getState().toggleSelection(id),
      clearSelection: () => useCanvasStore.getState().clearSelection(),
      previewScene: (scene) => useCanvasStore.getState().replaceScene(scene),
      commitScene: (prev, next) => useCanvasStore.getState().commitScene(prev, next),
    });

    // Route pointer intents to draw vs edit based on the tool at gesture start.
    let editing = false;
    const input = new Input(activeCanvas, viewport, {
      onChange: markBoth,
      onReadout: (info) => {
        setReadout({
          zoom: Math.round(info.scale * 100),
          worldX: Math.round(info.worldX),
          worldY: Math.round(info.worldY),
        });
        // Emit our cursor in WORLD coords, throttled, only when in a room.
        if (socket) {
          const now = performance.now();
          if (now - lastCursorEmit >= CURSOR_EMIT_MS) {
            lastCursorEmit = now;
            socket.emitCursor(info.worldX, info.worldY);
          }
        }
      },
      onDrawStart: (w, s, mods) => {
        editing = useCanvasStore.getState().tool === "select";
        if (editing) editSession.begin(w, s, mods);
        else drawSession.begin(w, s);
      },
      onDrawMove: (w, s) => {
        if (editing) editSession.move(w, s);
        else drawSession.move(w, s);
      },
      onDrawEnd: (w, s) => {
        if (editing) editSession.end(w);
        else drawSession.end(w, s);
      },
      isPanActive: () => useCanvasStore.getState().tool === "pan",
      // Same predicate as the shortcut guard, via the shared helper: the text
      // overlay flag AND ambient focus, so any future editing surface that does
      // not set editingRef still locks navigation.
      isNavLocked: () => editingRef.current || isTypingNow(),
    });

    // Repaint when the store changes (scene edits / selection / tool).
    const unsubscribe = useCanvasStore.subscribe((state, prev) => {
      if (state.scene !== prev.scene) markStatic();
      if (
        state.scene !== prev.scene ||
        state.selectedIds !== prev.selectedIds ||
        state.tool !== prev.tool
      ) {
        markActive();
      }
    });

    const TOOL_SHORTCUTS: Record<string, Tool> = {
      v: "select",
      r: "rect",
      o: "ellipse",
      l: "line",
      a: "arrow",
      p: "pencil",
      t: "text",
      h: "pan",
    };
    const onKey = (e: KeyboardEvent): void => {
      // ONE predicate, shared with Input's Space guard and the nav lock. Checks
      // both the event target and ambient focus so a key routed oddly (or a
      // focused control that is not the event target) still counts as typing.
      if (isTypingElement(e.target) || isTypingNow()) return;

      const store = useCanvasStore.getState();
      const meta = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (meta && key === "z") {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (meta && key === "y") {
        e.preventDefault();
        store.redo();
        return;
      }
      // Layer order: Cmd/Ctrl+]/[ = forward/backward, +Shift = to front/back.
      // Use e.code so Shift (which changes "]" -> "}") doesn't matter.
      if (meta && (e.code === "BracketRight" || e.code === "BracketLeft")) {
        e.preventDefault();
        const forward = e.code === "BracketRight";
        store.layerAction(
          e.shiftKey
            ? forward
              ? "front"
              : "back"
            : forward
              ? "forward"
              : "backward",
        );
        return;
      }
      if (meta || e.altKey) return;

      if (key === "delete" || key === "backspace") {
        if (store.tool === "select" && store.selectedIds.length > 0) {
          e.preventDefault();
          store.deleteSelected();
        }
        return;
      }
      if (key === "escape") {
        // Abort an in-progress draw before falling through to deselect.
        // DrawSession.cancel() existed but was never called — the draft simply
        // could not be abandoned, you had to release and undo. Only DRAW
        // gestures: an edit drag has already previewed a moved scene and
        // EditSession has no restore path, so aborting one would strand the
        // preview. Left alone deliberately, not overlooked.
        if (drawSession.isActive()) {
          drawSession.cancel();
          input.cancelGesture();
          return;
        }
        store.clearSelection();
        return;
      }
      const next = TOOL_SHORTCUTS[key];
      if (next) store.setTool(next);
    };
    window.addEventListener("keydown", onKey);

    // --- realtime sync: always connected to this board's room ---
    {
      const url = REALTIME_URL;
      const toScene = (el: WireElement): SceneElement => ({
        id: el.id,
        version: el.version,
        zIndex: el.zIndex,
        createdAt: el.createdAt,
        data: el.data,
      });
      const client = new RealtimeClient(url, roomId, {
        onSync: (els, keepIds) =>
          useCanvasStore.getState().applyRemoteSync(els.map(toScene), keepIds),
        onCreated: (el) => useCanvasStore.getState().applyRemoteCreate(toScene(el)),
        onUpdated: (el) => useCanvasStore.getState().applyRemoteUpdate(toScene(el)),
        onDeleted: (id) => useCanvasStore.getState().applyRemoteDelete(id),
        onPresence: (users) => {
          presenceIds = new Set(users.map((u) => u.userId));
          presenceNames.clear();
          for (const u of users) presenceNames.set(u.userId, u.name);
          setPresence(users);
          // Drop cursors of anyone who left, then repaint the overlay.
          for (const userId of [...cursors.keys()]) {
            if (!presenceIds.has(userId)) cursors.delete(userId);
          }
          markActive();
        },
        onCursor: (userId, x, y) => {
          const now = performance.now();
          const c = cursors.get(userId);
          if (c) {
            c.target.x = x;
            c.target.y = y;
            c.lastSeen = now;
          } else {
            cursors.set(userId, { cur: { x, y }, target: { x, y }, lastSeen: now });
          }
          ensureCursorLoop();
        },
        onStatus: (st) => {
          e2eSetStatus(st);
          setStatus(st);
          if (st === "open") {
            setHasConnected(true);
            return;
          }
          // Presence is a server broadcast; with the socket down the last one is
          // stale and the avatars would sit there implying people are still
          // here. Clear it (and their cursors) rather than lie.
          presenceIds = new Set();
          presenceNames.clear();
          cursors.clear();
          setPresence([]);
          markActive();
        },
        // Server-originated and unsolicited — there is no form to render this
        // into, which is what the toast channel exists for. Keyed so a burst
        // collapses into one message instead of a stack.
        onError: (m) => {
          console.warn("[realtime]", m);
          show(m, { key: "realtime-error" });
        },
        // A mutation the client could not transmit. Before this it produced
        // nothing in production: no error, no log, no counter the user could see.
        onDropped: (reason) => {
          show(
            reason === "overflow"
              ? "Too many unsent changes — the most recent ones were discarded."
              : "You're offline — that change was not saved.",
            { key: `dropped-${reason}` },
          );
        },
        // Ticket issuance returned 401 -> the session is gone, not a transport
        // blip. The client has already stopped retrying; send them to sign-in
        // with a return path so they land back on this board.
        onSignedOut: () => {
          window.location.href = `/signin?next=${encodeURIComponent(window.location.pathname)}`;
        },
      },
      // Fresh single-use ticket before EVERY connect attempt.
      async () => {
        e2eCountTicket();
        return (await api.wsTicket()).ticket;
      });
      socket = client;
      e2eRegisterDrop(() => client.dropSocket());
      e2eRegisterDropped(client.dropped);
      installE2EHook();
      // Local commits emit to the gateway (drawing user renders optimistically).
      useCanvasStore.getState().setOutbound((op: Outbound) => {
        if (op.kind === "create") {
          client.emitCreate({ id: op.id, data: op.data, version: op.version });
        } else if (op.kind === "update") {
          client.emitUpdate(op.id, op.data, op.zIndex, op.version);
        } else {
          client.emitDelete(op.id, op.version);
        }
      });
      client.connect();
    }

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      if (cursorRaf !== 0) cancelAnimationFrame(cursorRaf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKey);
      dprMedia?.removeEventListener("change", onDprChange);
      unsubscribe();
      input.detach();
      if (socket) {
        socket.dispose();
        useCanvasStore.getState().setOutbound(() => {});
      }
    };
  }, [roomId, user.id, canEdit, show]);

  const commitText = (): void => {
    const value = textValue.trim();
    if (textEdit && value) {
      useCanvasStore
        .getState()
        .addElement(
          createText(
            { x: textEdit.worldX, y: textEdit.worldY },
            value,
            DEFAULT_FONT_SIZE,
            useCanvasStore.getState().style,
          ),
        );
    }
    editingRef.current = false;
    setTextEdit(null);
    setTextValue("");
  };

  const cancelText = (): void => {
    editingRef.current = false;
    setTextEdit(null);
    setTextValue("");
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-slate-50">
      <canvas ref={staticRef} className="absolute inset-0 block h-full w-full" />
      <canvas
        ref={activeRef}
        className={`absolute inset-0 block h-full w-full touch-none select-none ${toolCursor(
          tool,
        )}`}
      />

      {textEdit && (
        <input
          autoFocus
          value={textValue}
          // Enforced at the source: the shared cap the server validates against,
          // so we never render or emit text the gateway would reject.
          maxLength={MAX_TEXT_LENGTH}
          onChange={(e) => setTextValue(e.target.value.slice(0, MAX_TEXT_LENGTH))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitText();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelText();
            }
          }}
          onBlur={commitText}
          placeholder="Type…"
          className="absolute z-50 m-0 border-0 bg-transparent p-0 leading-none outline-none placeholder:text-slate-400"
          style={{
            left: textEdit.screenX,
            top: textEdit.screenY,
            color: style.stroke,
            fontSize: DEFAULT_FONT_SIZE * textEdit.scale,
            fontFamily: FONT_STACK,
          }}
        />
      )}

      {/* Empty-board hint. The grid alone gives a new user nothing to act on,
          and for a VIEWER "empty" and "still loading" look identical. */}
      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <p className="text-sm text-slate-400" data-testid="empty-board-hint">
            {canEdit
              ? "This board is empty — pick a tool and start drawing."
              : "This board is empty."}
          </p>
        </div>
      )}

      <Toolbar canEdit={canEdit} />
      {canEdit ? (
        <StylePanel />
      ) : (
        <div
          data-testid="read-only-badge"
          className="absolute left-3 top-3 z-40 flex items-center gap-2 rounded-xl bg-white/90 px-3 py-2 text-xs shadow-md ring-1 ring-slate-900/10 backdrop-blur"
        >
          <Eye className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={2} />
          <span className="font-semibold text-slate-700">View only</span>
          <span className="text-slate-500">You can&apos;t edit this board.</span>
        </div>
      )}

      <ConnectionStatus status={status} hasConnected={hasConnected} />

      <div className="absolute right-3 top-3 z-40 flex flex-col items-end gap-2">
        <BoardChrome name={roomName} slug={slug} />
        <PresencePanel users={presence} myUserId={myUserId} />
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-0.5 rounded-md bg-white/80 px-3 py-2 font-mono text-xs text-slate-600 shadow-sm ring-1 ring-slate-900/5 backdrop-blur">
        <span>zoom: {readout.zoom}%</span>
        <span>
          world: {readout.worldX}, {readout.worldY}
        </span>
      </div>

      <div className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-white/80 px-3 py-2 text-xs text-slate-500 shadow-sm ring-1 ring-slate-900/5 backdrop-blur">
        {canEdit
          ? `select (v) · draw · space/middle-drag pan · scroll zoom · ${labels.key("Z")} undo`
          : "select (v) · space/middle-drag pan · scroll zoom"}
      </div>
    </div>
  );
}
