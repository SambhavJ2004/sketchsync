import { useCanvasStore } from "./store";
import type { RealtimeStatus } from "@/lib/realtime/socket";

/**
 * READ-ONLY inspection hook for the end-to-end suite.
 *
 * The canvas is a `<canvas>`; nothing about the scene reaches the DOM, and the
 * Zustand store is module-scoped inside the bundle, so a test has no other way
 * to assert "did this element actually arrive in the other client". Pixel
 * sampling proves something rendered, but cannot express version numbers, undo
 * depth, or z-order.
 *
 * Deliberately exposes NO setters. A hook that can mutate state lets a test
 * drive the app into a configuration a user could never produce, which is how a
 * suite quietly stops testing the real thing. Everything here is a getter.
 *
 * Gated on NEXT_PUBLIC_E2E so it is absent from a normal build — the constant
 * folds to `false` and the whole module is dead code.
 */
export const E2E_ENABLED = process.env.NEXT_PUBLIC_E2E === "1";

export interface E2EHandle {
  /** Committed scene, sorted (zIndex, createdAt) — the client's view of truth. */
  scene: () => {
    id: string;
    version: number;
    zIndex: number;
    type: string;
    pointCount: number;
    text: string | null;
    stroke: string;
  }[];
  /** Undo/redo depth — proves a renormalization did not wipe history. */
  history: () => { past: number; future: number };
  /** Latest socket status reported by RealtimeClient. */
  status: () => RealtimeStatus | "none";
  /** Whether the socket is live RIGHT NOW (for the open-gap test). */
  socketOpen: () => boolean;
  /** Count of ticket fetches, to assert one per connect attempt. */
  ticketRequests: () => number;
  /** Mutations the client could not transmit, by reason. */
  dropped: () => { overflow: number; disconnected: number };
  /**
   * Simulate transport loss by closing the live socket.
   *
   * The ONE non-getter here, and deliberately so: Chromium's CDP offline
   * emulation does not tear down an already-established WebSocket, so there is
   * no other way for a test to exercise reconnect. This closes the transport
   * exactly as a dropped connection would; it does not touch application state,
   * so the code under test still decides what happens next.
   */
  dropSocket: () => void;
}

interface E2EState {
  status: RealtimeStatus | "none";
  ticketRequests: number;
}

const state: E2EState = { status: "none", ticketRequests: 0 };
let dropFn: (() => void) | null = null;

export function e2eRegisterDrop(fn: () => void): void {
  if (E2E_ENABLED) dropFn = fn;
}

export function e2eSetStatus(s: RealtimeStatus): void {
  if (E2E_ENABLED) state.status = s;
}
export function e2eCountTicket(): void {
  if (E2E_ENABLED) state.ticketRequests += 1;
}

/** Attach the handle to `window`. No-op unless NEXT_PUBLIC_E2E=1. */
let droppedRef: { overflow: number; disconnected: number } | null = null;
export function e2eRegisterDropped(d: { overflow: number; disconnected: number }): void {
  if (E2E_ENABLED) droppedRef = d;
}

export function installE2EHook(): void {
  if (!E2E_ENABLED || typeof window === "undefined") return;
  const handle: E2EHandle = {
    scene: () =>
      useCanvasStore.getState().scene.map((e) => ({
        id: e.id,
        version: e.version,
        zIndex: e.zIndex,
        type: e.data.type,
        pointCount: e.data.type === "pencil" ? e.data.points.length : 0,
        text: e.data.type === "text" ? e.data.text : null,
        stroke: e.data.style.stroke,
      })),
    history: () => {
      const h = useCanvasStore.getState().history;
      return { past: h.past.length, future: h.future.length };
    },
    status: () => state.status,
    socketOpen: () => state.status === "open",
    ticketRequests: () => state.ticketRequests,
    dropped: () => droppedRef ?? { overflow: 0, disconnected: 0 },
    dropSocket: () => dropFn?.(),
  };
  (window as unknown as { __sketchsync?: E2EHandle }).__sketchsync = handle;
}
