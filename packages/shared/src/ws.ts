import { z } from "zod";
import { Element, ElementData, ElementInput } from "./element.js";

// Real-time protocol. Defined now, wired up in Phase 3. Both directions are
// discriminated unions on `type` (distinct from an element's own `data.type`).
// Every element mutation carries a `version` so the server can resolve
// conflicts with last-write-wins.

/**
 * Fixed marker sent as the FIRST `Sec-WebSocket-Protocol` value when opening a
 * socket; the single-use ticket is the second. The server echoes back only this
 * marker, never the ticket.
 *
 * The credential rides in the subprotocol header because query strings are
 * recorded in access logs, proxy logs, and browser history. Ticket values are
 * base64url, so they are valid RFC 6455 protocol tokens.
 *
 * Lives HERE (browser-safe contracts) rather than in @sketchsync/auth, which is
 * server-only and would drag `jsonwebtoken` into the client bundle.
 */
export const WS_TICKET_PROTOCOL = "sketchsync.ticket.v1";

/** A participant currently connected to a room (for presence). */
export const PresenceUser = z.object({
  userId: z.string().uuid(),
  name: z.string(),
  avatarUrl: z.string().url().nullish(),
});
export type PresenceUser = z.infer<typeof PresenceUser>;

/** Messages sent from a client to the server. */
export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), roomId: z.string().uuid() }),
  z.object({ type: z.literal("leave"), roomId: z.string().uuid() }),
  z.object({ type: z.literal("elementCreate"), element: ElementInput }),
  z.object({
    type: z.literal("elementUpdate"),
    id: z.string().uuid(),
    data: ElementData, // full replacement, not a partial patch
    // Stacking order rides on the normal update (no new message type).
    zIndex: z.number(),
    version: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("elementDelete"),
    id: z.string().uuid(),
    version: z.number().int().positive(),
  }),
  z.object({ type: z.literal("cursor"), x: z.number(), y: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Messages sent from the server to clients. */
export const ServerMessage = z.discriminatedUnion("type", [
  // A snapshot is CHUNKED: a room can exceed any single-frame budget, so the
  // server emits ordered batches and the client commits the scene once, when
  // `done` arrives. `seq` starts at 0 and increments; seq 0 begins a new
  // sequence (so a reconnect mid-stream cleanly discards the partial one).
  z.object({
    type: z.literal("sync"),
    elements: z.array(Element),
    seq: z.number().int().nonnegative(),
    done: z.boolean(),
  }),
  z.object({ type: z.literal("elementCreated"), element: Element }),
  z.object({ type: z.literal("elementUpdated"), element: Element }),
  z.object({ type: z.literal("elementDeleted"), id: z.string().uuid() }),
  z.object({ type: z.literal("presence"), users: z.array(PresenceUser) }),
  z.object({
    type: z.literal("cursor"),
    userId: z.string().uuid(),
    x: z.number(),
    y: z.number(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
