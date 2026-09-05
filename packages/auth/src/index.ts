// @sketchsync/auth — SERVER-ONLY token primitives.
//
// The single source of truth for how a SketchSync session token is signed,
// verified, and named. Both apps/api and apps/realtime import from here; neither
// keeps its own copy. See README.md for why this is its own package.

import jwt from "jsonwebtoken";

/**
 * Name of the session cookie the API sets and the gateway reads. A shared
 * constant, not a duplicated literal — the two used to drift independently.
 */
export const AUTH_COOKIE = "sketchsync_token";

/** Token lifetime: 7 days (also used for the cookie maxAge). */
export const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

// ── WebSocket tickets ──────────────────────────────────────────────────────
// The socket cannot use the session cookie (cross-origin, and a rewrite cannot
// proxy WebSockets), so the API mints a single-use ticket and the gateway
// redeems it at upgrade. These constants are the contract between them.

/**
 * Ticket lifetime. SECONDS, deliberately: the client fetches a ticket
 * immediately before opening the socket, so the only gap between issuance and
 * redemption is one round trip plus the handshake. 15s absorbs a slow mobile
 * network or a briefly-descheduled JS thread while keeping the replay window
 * tiny. A longer TTL buys nothing — every reconnect fetches a fresh ticket —
 * and only widens the window in which a leaked ticket is usable.
 */
export const WS_TICKET_TTL_SECONDS = 15;

// NOTE: the `Sec-WebSocket-Protocol` marker lives in @sketchsync/shared, not
// here. The BROWSER needs it to open the socket, and this package must never
// reach the client bundle — it would ship `jsonwebtoken` with it.

/** The application claims carried in the token. */
export interface TokenPayload {
  userId: string;
}

export function signToken(payload: TokenPayload, secret: string): string {
  return jwt.sign(payload, secret, { expiresIn: TOKEN_TTL_SECONDS });
}

/**
 * Verify a RAW token string and return its payload, or null if it is invalid,
 * expired, or malformed.
 *
 * TRANSPORT-AGNOSTIC BY DESIGN: this takes the token itself and makes no
 * assumption about where it came from — a cookie today, a
 * `Sec-WebSocket-Protocol` ticket in the WS handshake tomorrow. Callers are
 * responsible for extracting the string from whatever carried it. Do not add a
 * `Request`/`IncomingMessage` parameter here; that would couple the primitive to
 * one transport and force the next caller to fake a request object.
 *
 * (Credentials deliberately never travel in a query string: those land in
 * access logs, proxy logs, and browser history.)
 */
export function verifyToken(token: string, secret: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, secret);
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      "userId" in decoded &&
      typeof decoded.userId === "string"
    ) {
      return { userId: decoded.userId };
    }
    return null;
  } catch {
    return null;
  }
}
