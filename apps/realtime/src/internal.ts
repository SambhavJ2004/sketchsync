import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  EvictRequest,
  INTERNAL_SECRET_HEADER,
  WS_CLOSE_EVICTED,
  type EvictResult,
  type ServerMessage,
} from "@sketchsync/shared";
import { WebSocket } from "ws";
import type { RoomRegistry } from "./registry.js";

/**
 * `POST /internal/evict` — the one endpoint apps/api calls on this service.
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT:
 *
 * `conn.role` is captured once, at `join`. Before this endpoint, removing or
 * demoting a member changed the database and nothing else: their existing socket
 * kept its stale role and they kept drawing, with every stroke persisting, until
 * they happened to reconnect. This closes that window.
 *
 * IT IS NOT THE SECURITY BOUNDARY, and must never be treated as one. The
 * guarantee lives where it already did: `handleJoin` re-reads membership from the
 * database on every join, so a removed user cannot get back in. If this endpoint
 * is never called — the secret is unset, the service is asleep, the request times
 * out — the system is exactly as correct as it was before, just slower to react.
 * That is precisely why the caller treats it as fire-and-forget.
 *
 * Do not move an authorization decision here on the grounds that eviction is
 * "instant now". It is best-effort by construction.
 */

/** Everything the handler needs, injected so it can be unit-tested. */
export interface InternalDeps {
  registry: RoomRegistry;
  /** The configured shared secret, or undefined when eviction is disabled. */
  secret: string | undefined;
}

/**
 * Constant-time comparison of the presented secret against the configured one.
 *
 * `timingSafeEqual` throws on a length mismatch, so lengths are compared first —
 * which does leak the length of the expected secret through timing. That is
 * acceptable: the length of a secret is not the secret, and the alternative
 * (padding to a fixed width) adds machinery for no real gain here.
 *
 * Returns false when no secret is configured. WITH NO SECRET, EVICTION IS OFF —
 * the endpoint refuses everything rather than falling open. An unauthenticated
 * caller must never be able to close another user's sockets.
 */
export function isAuthorizedInternal(
  presented: string | string[] | undefined,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Apply an eviction to the live connections. Pure with respect to the network:
 * it only touches the registry, so it is directly testable with stub sockets.
 */
export function applyEviction(
  registry: RoomRegistry,
  request: EvictRequest,
): EvictResult {
  if (request.action === "removed") {
    const closed = registry.closeUserSockets(
      request.roomId,
      request.userId,
      WS_CLOSE_EVICTED,
      "removed from board",
    );
    return { closed, updated: 0 };
  }

  // Demotion: rewrite the role in place, then tell the client.
  const updated = registry.setUserRole(request.roomId, request.userId, request.role);

  // SENT AS AN `error` FRAME, NOT A NEW MESSAGE TYPE.
  //
  // "No new WS message types" is a standing invariant, and it is doing real work
  // here: the client validates every inbound frame against the ServerMessage
  // union and SILENTLY DROPS anything that fails, so a new type would be
  // invisible until the client shipped support for it. `error` already reaches
  // the user — CanvasStage renders it as a keyed toast — so this is the strongest
  // signal available without a client change.
  //
  // The client does NOT parse this text. On any `error` frame it re-asks the API
  // what its role is and switches the toolbar in place — so the wording here is
  // purely human-facing, and a reader changing it cannot break the behaviour.
  // The authoritative effect is the role rewrite above.
  const message: ServerMessage = {
    type: "error",
    // No "reload to continue": since 3c the client reconciles its role from the
    // API when this frame arrives and switches the toolbar in place, so telling
    // the user to reload would describe work the app has already done.
    message:
      request.role === "VIEWER"
        ? "Your access to this board is now view-only."
        : "Your role on this board changed.",
  };
  for (const conn of registry.connectionsFor(request.roomId, request.userId)) {
    if (conn.ws.readyState !== WebSocket.OPEN) continue;
    try {
      conn.ws.send(JSON.stringify(message));
    } catch {
      // Best-effort, like everything else on this path.
    }
  }

  return { closed: 0, updated };
}

/** Read a bounded JSON body. Bounded because this endpoint is reachable by
 *  anything that can route to the service, secret or not. */
const MAX_BODY_BYTES = 8 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * HTTP glue for the endpoint.
 *
 * EVERY REFUSAL IS THE SAME 403 WITH NO DETAIL. A caller that fails the secret
 * check learns nothing about whether the room exists, whether the user is in it,
 * or whether anything was closed — so the endpoint cannot be used to probe for
 * board or user ids. The success body carries counts, but only an authorized
 * caller ever sees it.
 */
export async function handleInternalEvict(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InternalDeps,
): Promise<void> {
  if (!isAuthorizedInternal(req.headers[INTERNAL_SECRET_HEADER], deps.secret)) {
    // Deliberately identical whether the secret is wrong, absent, or eviction is
    // switched off entirely.
    send(res, 403, { message: "Forbidden" });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    send(res, 400, { message: "Invalid body" });
    return;
  }

  const parsed = EvictRequest.safeParse(body);
  if (!parsed.success) {
    send(res, 400, { message: "Invalid body" });
    return;
  }

  const result = applyEviction(deps.registry, parsed.data);
  console.log(
    `evict: action=${parsed.data.action} room=${parsed.data.roomId} ` +
      `user=${parsed.data.userId} closed=${result.closed} updated=${result.updated}`,
  );
  send(res, 200, result);
}
