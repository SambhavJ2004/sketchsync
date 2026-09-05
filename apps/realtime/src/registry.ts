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
