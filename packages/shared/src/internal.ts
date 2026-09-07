import { z } from "zod";
import { InviteRole } from "./room.js";

/**
 * SERVICE-TO-SERVICE CONTRACT: apps/api -> apps/realtime.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS DELIBERATELY BREAKS A PROPERTY THE DESIGN PREVIOUSLY HAD.
 *
 * Until now `api` and `realtime` never talked to each other. They shared a
 * database and a JWT secret, and their only synchronisation point was a Postgres
 * row (the WsTicket table). That was a genuinely nice property: either service
 * could be restarted, redeployed or scaled without the other noticing, and there
 * was no direction of dependency to reason about.
 *
 * It is given up here for one reason. `conn.role` is snapshotted when a socket
 * joins, so removing or demoting a member had NO EFFECT until they reconnected —
 * they kept drawing, and every stroke persisted. Closing that window needs the
 * process holding the sockets to be told, and only `realtime` holds them.
 *
 * The coupling is kept as small as it can be:
 *   - ONE endpoint, one direction. `realtime` never calls `api`.
 *   - FIRE-AND-FORGET. The caller does not await a result it acts on, uses a
 *     short timeout, and swallows every failure. A sleeping or redeployed
 *     `realtime` must never make a member removal fail.
 *   - NOT THE SECURITY BOUNDARY. Membership is re-checked on `join`, so a
 *     removed user cannot reconnect. Eviction only closes the window between
 *     "removed in the database" and "their existing socket notices". If this
 *     endpoint never fires, the system is exactly as correct as it was before —
 *     just slower to react.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Header carrying the shared secret. Not `Authorization`, so it can never be
 * confused with a user credential by a proxy, a log scrubber or a reader.
 */
export const INTERNAL_SECRET_HEADER = "x-sketchsync-internal";

/**
 * WebSocket close code sent to an evicted socket.
 *
 * 4000-4999 is the application-private range (RFC 6455). 4403 is chosen to read
 * like HTTP 403 at a glance, because that is what it means: you are no longer
 * permitted here.
 */
export const WS_CLOSE_EVICTED = 4403;

/**
 * What happened to the member, as told to the gateway.
 *
 * `removed` closes their sockets in that room. `roleChanged` updates the role on
 * the live connection instead, so the very next mutation is refused by the same
 * `canWrite` check that has always guarded writes — no separate enforcement path
 * to keep in sync.
 *
 * Role is `InviteRole` (EDITOR | VIEWER) rather than the full Role: OWNER is not
 * reachable through a role change, for the same reason it is not mintable by an
 * invite — a board has one owner and no transfer route.
 */
export const EvictRequest = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("removed"),
    roomId: z.string().uuid(),
    userId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("roleChanged"),
    roomId: z.string().uuid(),
    userId: z.string().uuid(),
    role: InviteRole,
  }),
]);
export type EvictRequest = z.infer<typeof EvictRequest>;

/** What the gateway did. Returned for observability only — the caller does not
 *  branch on it, because it is fire-and-forget. */
export interface EvictResult {
  /** Sockets closed (action: "removed"). */
  closed: number;
  /** Live connections whose role was rewritten (action: "roleChanged"). */
  updated: number;
}
