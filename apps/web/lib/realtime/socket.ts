import {
  ServerMessage,
  WS_TICKET_PROTOCOL,
  type ClientMessage,
  type Element,
  type ElementData,
  type ElementInput,
  type PresenceUser,
} from "@sketchsync/shared";
import { ApiError } from "@/lib/api/client";

export type RealtimeStatus = "connecting" | "open" | "closed" | "signedOut";

export interface RealtimeHandlers {
  /** `keepIds` are elements drawn during the connect window that the
   *  snapshot cannot contain yet — the commit must not delete them. */
  onSync: (elements: Element[], keepIds?: Set<string>) => void;
  onCreated: (element: Element) => void;
  onUpdated: (element: Element) => void;
  onDeleted: (id: string) => void;
  onPresence?: (users: PresenceUser[]) => void;
  onCursor?: (userId: string, x: number, y: number) => void;
  onStatus?: (status: RealtimeStatus) => void;
  onError?: (message: string) => void;
  /** A mutation could not be transmitted. Never silent — see reportDrop. */
  onDropped?: (reason: "overflow" | "disconnected", type: string) => void;
  /** Queued connect-window mutations were flushed. */
  onFlush?: (count: number) => void;
  /**
   * The session itself is gone (ticket issuance returned 401). Terminal — the
   * client stops retrying and the app should route to sign-in.
   */
  onSignedOut?: () => void;
}

const MAX_BACKOFF_MS = 8000;
const BASE_BACKOFF_MS = 500;
/**
 * A failed handshake is indistinguishable from a dropped connection in the
 * browser (no status is exposed), so a bad ticket looks like a normal close.
 * Retrying that immediately is correct — a fresh ticket is fetched each time —
 * but only briefly, so a genuinely unreachable server still backs off.
 */
const FAST_RETRY_MS = 150;

/**
 * Thin WebSocket client for the realtime gateway. Sends `join` on (re)connect so
 * the server (re)syncs, validates incoming messages with the shared
 * ServerMessage schema, and dispatches to handlers. It never touches the canvas
 * or the store directly — the caller wires handlers to store actions.
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private backoff = BASE_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  // A snapshot arrives as ordered chunks. Accumulate and commit ONCE on `done`,
  // so the scene never swaps to a partial board (which would flicker and, since
  // applyRemoteSync clears undo, would also wipe history more than once).
  private syncBuffer: Element[] = [];
  private syncExpectedSeq = 0;
  private syncActive = false;

  /** Consecutive opens that failed before reaching `onopen`. */
  private handshakeFailures = 0;

  constructor(
    private readonly url: string,
    private readonly roomId: string,
    private readonly handlers: RealtimeHandlers,
    /** Mints a fresh single-use ticket. Called before EVERY connect attempt. */
    private readonly getTicket: () => Promise<string>,
  ) {}

  connect(): void {
    void this.connectWithTicket();
  }

  /**
   * Every attempt fetches a NEW ticket: the previous one was consumed by the
   * gateway on redemption and expires in seconds regardless, so there is nothing
   * to cache and a stale one would simply fail.
   *
   * This is also where the two 401s are told apart. The browser cannot read the
   * status of a failed WebSocket handshake, so "ticket rejected" and "server
   * unreachable" both surface as a plain close. But ticket ISSUANCE is an
   * ordinary fetch whose status we CAN read:
   *   - 401 from /auth/ws-ticket  -> the session is gone. Terminal: stop
   *     retrying and tell the app, which routes to sign-in.
   *   - issuance succeeded, handshake still failed -> a ticket/transport
   *     problem. Retry promptly with a fresh ticket, then back off.
   */
  private async connectWithTicket(): Promise<void> {
    if (this.disposed) return;
    this.handlers.onStatus?.("connecting");

    let ticket: string;
    try {
      ticket = await this.getTicket();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        this.disposed = true; // terminal — do not reconnect
        this.handlers.onStatus?.("signedOut");
        this.handlers.onSignedOut?.();
        return;
      }
      // Issuance failed for another reason (API down, 429, offline). Treat it
      // like any connection failure and back off.
      this.handlers.onStatus?.("closed");
      this.scheduleReconnect();
      return;
    }
    if (this.disposed) return;

    // The credential travels as a subprotocol, never a query param.
    const ws = new WebSocket(this.url, [WS_TICKET_PROTOCOL, ticket]);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = BASE_BACKOFF_MS;
      this.handshakeFailures = 0;
      this.hasEverOpened = true;
      this.resetSync();
      this.handlers.onStatus?.("open");
      // (Re)join -> the server (re)sends the authoritative sync.
      this.send({ type: "join", roomId: this.roomId });
    };
    ws.onmessage = (ev) => this.dispatch(ev.data);
    ws.onclose = (ev) => {
      // Never reached `onopen` -> the handshake itself was refused.
      const handshakeFailed = ev.target === ws && this.ws === ws && !this.opened;
      if (handshakeFailed) this.handshakeFailures += 1;
      this.opened = false;
      // Dropped mid-sequence: throw away the partial snapshot. The re-join on
      // the next open re-requests it from seq 0.
      this.resetSync();
      this.handlers.onStatus?.("closed");
      if (!this.disposed) this.scheduleReconnect(handshakeFailed);
    };
    ws.onerror = () => {
      // onclose fires right after; reconnect handled there.
    };
    ws.addEventListener("open", () => {
      this.opened = true;
    });
  }

  private opened = false;

  private scheduleReconnect(handshakeFailed = false): void {
    if (this.reconnectTimer) return;
    // A refused handshake is usually a ticket that expired or was already
    // redeemed; a fresh one is one round trip away, so retry almost immediately.
    // Only the first couple, so an unreachable server still backs off properly.
    const fast = handshakeFailed && this.handshakeFailures <= 2;
    const delay = fast ? FAST_RETRY_MS : this.backoff;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectWithTicket();
    }, delay);
    if (!fast) this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private dispatch(data: unknown): void {
    if (typeof data !== "string") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ServerMessage.safeParse(json);
    if (!parsed.success) return;
    const msg = parsed.data;
    switch (msg.type) {
      case "sync":
        this.onSyncChunk(msg.elements, msg.seq, msg.done);
        break;
      case "elementCreated":
        this.handlers.onCreated(msg.element);
        break;
      case "elementUpdated":
        this.handlers.onUpdated(msg.element);
        break;
      case "elementDeleted":
        this.handlers.onDeleted(msg.id);
        break;
      case "cursor":
        this.handlers.onCursor?.(msg.userId, msg.x, msg.y);
        break;
      case "presence":
        this.handlers.onPresence?.(msg.users);
        break;
      case "error":
        this.handlers.onError?.(msg.message);
        break;
    }
  }

  private resetSync(): void {
    this.syncBuffer = [];
    this.syncExpectedSeq = 0;
    this.syncActive = false;
  }

  /**
   * Accumulate one snapshot chunk. `seq` 0 always starts a fresh sequence (so a
   * re-join mid-stream supersedes any partial one); an out-of-order chunk means
   * we missed a frame, so the partial accumulation is discarded and we wait for
   * the server to start over rather than commit a board with holes in it.
   */
  private onSyncChunk(elements: Element[], seq: number, done: boolean): void {
    if (seq === 0) {
      this.syncBuffer = [];
      this.syncExpectedSeq = 0;
      this.syncActive = true;
    } else if (!this.syncActive || seq !== this.syncExpectedSeq) {
      this.resetSync();
      return;
    }

    this.syncBuffer.push(...elements);
    this.syncExpectedSeq = seq + 1;

    if (done) {
      const complete = this.syncBuffer;
      this.resetSync();
      // Commit once: one scene swap, one undo-stack clear. `keepIds` preserves
      // elements drawn during the connect window — the snapshot predates them
      // and the server never echoes our own creates back to us, so a plain
      // wholesale replace would delete them locally.
      this.handlers.onSync(complete, this.pendingCreateIds());
      // FLUSH HERE, not on open. `join` is provably complete by now (the server
      // sets roomId/role before sending the first chunk), and the snapshot is
      // already applied — so queued ops can neither be rejected with "join a
      // room first" nor be erased by the sync that follows them.
      this.flushQueue();
    }
  }

  // ── outbound queue for the connect window ────────────────────────────────

  /**
   * Mutations committed before the socket exists. Without this they hit a
   * `send()` that silently discarded them: the shape rendered locally, reached
   * nobody, and vanished on reload.
   *
   * INITIAL CONNECT ONLY. After the socket has once been open, a disconnect
   * keeps the old drop-then-resync behaviour: replaying stale mutations across
   * a re-sync that wholesale-replaces the scene and clears history needs
   * version reconciliation, which is the offline-queueing deferral.
   */
  private queue: { msg: ClientMessage; bytes: number; createId?: string }[] = [];
  private queuedBytes = 0;
  private hasEverOpened = false;

  /** Bounds. The server's rate limiter is per-socket and does NOT exist yet
   *  during the connect window, so the queue must bound itself. If ticket
   *  issuance keeps failing, backoff (0.5s->8s) can stretch this to minutes. */
  private static readonly MAX_QUEUED_OPS = 200;
  private static readonly MAX_QUEUED_BYTES = 1024 * 1024; // 1 MiB

  /** Observability: every op this client failed to transmit, and why. */
  readonly dropped = { overflow: 0, disconnected: 0 };

  private pendingCreateIds(): Set<string> {
    const ids = new Set<string>();
    for (const q of this.queue) if (q.createId) ids.add(q.createId);
    return ids;
  }

  private enqueue(msg: ClientMessage, createId?: string): void {
    const bytes = JSON.stringify(msg).length;
    if (
      this.queue.length >= RealtimeClient.MAX_QUEUED_OPS ||
      this.queuedBytes + bytes > RealtimeClient.MAX_QUEUED_BYTES
    ) {
      // Drop the NEWEST, never the oldest: the queue is order-dependent, and
      // evicting an older op could strand an update on an element whose create
      // was discarded. Dropping the tail always leaves a valid prefix.
      this.dropped.overflow += 1;
      this.reportDrop("overflow", msg);
      return;
    }
    this.queue.push({ msg, bytes, createId });
    this.queuedBytes += bytes;
  }

  private flushQueue(): void {
    if (this.queue.length === 0) return;
    const pending = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    // In order, ahead of any other outbound traffic.
    for (const q of pending) this.rawSend(q.msg);
    this.handlers.onFlush?.(pending.length);
  }

  private reportDrop(reason: "overflow" | "disconnected", msg: ClientMessage): void {
    // Never silent. The original bug survived precisely because a discarded
    // mutation produced no error, no log, and no counter.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[realtime] dropped ${msg.type} (${reason}); ` +
          `overflow=${this.dropped.overflow} disconnected=${this.dropped.disconnected}`,
      );
    }
    this.handlers.onDropped?.(reason, msg.type);
  }

  private rawSend(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    // Cursors are never queued: they are stale the moment they miss, and a
    // flush would dump a burst of positions nobody wants.
    if (msg.type === "cursor" || msg.type === "join" || msg.type === "leave") return;

    if (!this.hasEverOpened) {
      this.enqueue(msg, msg.type === "elementCreate" ? msg.element.id : undefined);
      return;
    }
    this.dropped.disconnected += 1;
    this.reportDrop("disconnected", msg);
  }

  emitCreate(element: ElementInput): void {
    this.send({ type: "elementCreate", element });
  }
  emitUpdate(id: string, data: ElementData, zIndex: number, version: number): void {
    this.send({ type: "elementUpdate", id, data, zIndex, version });
  }
  emitDelete(id: string, version: number): void {
    this.send({ type: "elementDelete", id, version });
  }
  emitCursor(x: number, y: number): void {
    this.send({ type: "cursor", x, y });
  }

  /** Test/diagnostic view of the connect-window queue. */
  queueDepth(): number {
    return this.queue.length;
  }

  /** Close the transport as a dropped connection would. Used by the e2e suite;
   *  reconnect logic then runs exactly as it does for a real network loss. */
  dropSocket(): void {
    this.ws?.close();
  }

  dispose(): void {
    this.disposed = true;
    this.resetSync();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
