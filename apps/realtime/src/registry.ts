import { WebSocket } from "ws";
import type { Role } from "@sketchsync/db";
import type { PresenceUser, ServerMessage } from "@sketchsync/shared";
import type { RateLimitState } from "./rateLimit.js";

/** Per-socket connection state. */
export interface Conn {
  ws: WebSocket;
  userId: string;
  name: string; // filled on join from the user record
  avatarUrl: string | null;
  roomId: string | null;
  role: Role | null;
  /** Token buckets + violation counter for this socket; released on close. */
  rate: RateLimitState;
  /**
   * Whether we've already told this socket it sent malformed JSON. Replying to
   * every unparseable frame is attacker-driven outbound work (measured: 419
   * replies before the violation counter closed the socket), and after the
   * first one it tells a legitimate client nothing new.
   */
  parseErrorSent: boolean;
}

/** In-memory rooms: roomId -> set of connected sockets. */
export class RoomRegistry {
  private readonly rooms = new Map<string, Set<Conn>>();

  /** Move a socket into a room (leaving any previous room first). */
  join(roomId: string, conn: Conn): void {
    this.leave(conn);
    let set = this.rooms.get(roomId);
    if (!set) {
      set = new Set<Conn>();
      this.rooms.set(roomId, set);
    }
    set.add(conn);
    conn.roomId = roomId;
  }

  /** Remove a socket from its room; drop the room when it becomes empty. */
  leave(conn: Conn): void {
    if (!conn.roomId) return;
    const set = this.rooms.get(conn.roomId);
    if (set) {
      set.delete(conn);
      if (set.size === 0) this.rooms.delete(conn.roomId);
    }
    conn.roomId = null;
    conn.role = null;
  }

  /** Distinct users currently in the room (deduped by userId across tabs). */
  getPresence(roomId: string): PresenceUser[] {
    const set = this.rooms.get(roomId);
    if (!set) return [];
    const byUser = new Map<string, PresenceUser>();
    for (const conn of set) {
      if (!byUser.has(conn.userId)) {
        byUser.set(conn.userId, {
          userId: conn.userId,
          name: conn.name,
          avatarUrl: conn.avatarUrl,
        });
      }
    }
    return [...byUser.values()];
  }

  /**
   * Close every socket a user holds IN ONE ROOM.
   *
   * Scoped to the room on purpose: a user removed from board A must keep their
   * sockets on boards B and C. Multi-tab is handled naturally — each tab is its
   * own Conn, and all of that user's tabs on this board close.
   *
   * `leave()` is not called here; the socket's own `close` handler runs
   * `handleLeave`, which removes it from the room and re-broadcasts presence.
   * Doing it twice would emit a redundant presence frame.
   *
   * @returns how many sockets were closed.
   */
  closeUserSockets(
    roomId: string,
    userId: string,
    code: number,
    reason: string,
  ): number {
    const set = this.rooms.get(roomId);
    if (!set) return 0;
    // Snapshot first: closing mutates the set through the close handler.
    const targets = [...set].filter((conn) => conn.userId === userId);
    let closed = 0;
    for (const conn of targets) {
      try {
        conn.ws.close(code, reason);
        closed += 1;
      } catch {
        // A socket already tearing down is not a failure — the outcome we
        // wanted (it stops receiving) is the outcome we have.
      }
    }
    return closed;
  }

  /**
   * Rewrite a user's role on their LIVE connections in one room.
   *
   * This is what makes a demotion take effect without a reconnect: `canWrite`
   * in messages.ts reads `conn.role` on every mutation, so updating it in place
   * means the very next write is refused by the check that has always guarded
   * writes. No second enforcement path to keep in sync.
   *
   * @returns how many connections were updated.
   */
  setUserRole(roomId: string, userId: string, role: Role): number {
    const set = this.rooms.get(roomId);
    if (!set) return 0;
    let updated = 0;
    for (const conn of set) {
      if (conn.userId !== userId) continue;
      conn.role = role;
      updated += 1;
    }
    return updated;
  }

  /** Every live socket a user holds in one room. */
  connectionsFor(roomId: string, userId: string): Conn[] {
    const set = this.rooms.get(roomId);
    if (!set) return [];
    return [...set].filter((conn) => conn.userId === userId);
  }

  /** Send a message to everyone in the room except `exclude`. */
  broadcast(roomId: string, message: ServerMessage, exclude?: Conn): void {
    const set = this.rooms.get(roomId);
    if (!set) return;
    const payload = JSON.stringify(message);
    for (const conn of set) {
      if (conn === exclude) continue;
      if (conn.ws.readyState !== WebSocket.OPEN) continue;
      try {
        conn.ws.send(payload);
      } catch {
        // Ignore a failed send to one socket; never let it affect others.
      }
    }
  }
}
