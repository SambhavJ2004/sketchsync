import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WS_TICKET_PROTOCOL } from "@sketchsync/shared";
import { prismaClient } from "@sketchsync/db";
import { env } from "./env.js";

// The socket authenticates with a SINGLE-USE TICKET, never the session cookie.
//
// There is deliberately no cookie fallback. In production the web app and this
// gateway are on different origins, cross-site cookies are not sent (and, as
// measured in 4.3a, not even stored), and a rewrite cannot proxy a WebSocket —
// so a cookie path would work in dev and fail in prod, which is exactly the
// class of bug this phase exists to remove.

/** Why an upgrade was refused. Maps to an HTTP status on the handshake. */
export type UpgradeRejection = "origin" | "ticket";

/**
 * Origin allowlist for the upgrade.
 *
 * MUST NOT BE REMOVED. Until now `SameSite=Lax` was implicitly preventing
 * cross-site WebSocket auth: a hostile page could open a socket, but the browser
 * withheld the cookie. Now that the credential travels in a header the client
 * supplies, that implicit protection is gone and this check is the only thing
 * standing between a malicious page and a cross-site WebSocket hijack.
 *
 * Semantics: if an `Origin` header is present it must match one of the
 * configured origins EXACTLY. Browsers ALWAYS send it on WebSocket upgrades, so
 * this fully covers the browser attack surface. A request with no `Origin` is
 * non-browser tooling (tests, CLIs), which could spoof any value anyway, so
 * rejecting it would add no security.
 *
 * `WEB_ORIGIN` may list several origins (comma-separated; parsed in
 * @sketchsync/config), which is what lets one deployment serve, say, a custom
 * domain and a preview domain. THE MATCH IS STILL `===` PER ENTRY. Do not
 * "improve" this into a prefix test, a suffix test, an endsWith, or a regex:
 * `https://app.example.com.evil.test` prefix-matches `https://app.example.com`,
 * and a suffix test on `.example.com` matches an attacker-controlled subdomain.
 * More entries is the supported way to allow more origins.
 *
 * `allowed` is injectable so the allowlist logic can be tested against several
 * configurations without reloading module-level env — the same seam
 * `allowTicket(userId, nowMs)` and `tryConsume(bucket, nowMs)` use. Production
 * callers pass one argument.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  allowed: readonly string[] = env.WEB_ORIGIN,
): boolean {
  if (origin === undefined) return true; // non-browser client
  return allowed.includes(origin); // exact match, per entry
}

/**
 * Pull the ticket out of `Sec-WebSocket-Protocol`. The client offers exactly
 * [WS_TICKET_PROTOCOL, <ticket>]; we return the ticket.
 *
 * Never a query parameter: those land in access logs, proxy logs, and browser
 * history.
 */
export function extractTicket(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  if (parts[0] !== WS_TICKET_PROTOCOL) return null;
  return parts[1] ?? null;
}

export function hashTicket(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Redeem a ticket: validate and CONSUME it in one atomic statement.
 *
 * `DELETE ... RETURNING` is what makes single-use safe across processes — two
 * racing upgrades both issue the delete, but only one gets a row back. Checking
 * then deleting would leave a window where both see it as valid.
 *
 * The expiry is evaluated by the DATABASE (`NOW()`), so a skewed gateway clock
 * cannot extend a ticket's life.
 */
export async function redeemTicket(raw: string): Promise<string | null> {
  const rows = await prismaClient.$queryRaw<{ userId: string }[]>`
    DELETE FROM "WsTicket"
    WHERE "tokenHash" = ${hashTicket(raw)} AND "expiresAt" > NOW()
    RETURNING "userId"
  `;
  return rows[0]?.userId ?? null;
}

/**
 * Authenticate an upgrade request. Returns the userId, or the reason to refuse.
 * Callers turn a rejection into an HTTP status DURING the handshake, so a client
 * never sees a successful 101 followed by an immediate close.
 */
export async function authenticateUpgrade(
  req: IncomingMessage,
): Promise<{ userId: string } | { rejected: UpgradeRejection }> {
  if (!isAllowedOrigin(req.headers.origin)) return { rejected: "origin" };

  const ticket = extractTicket(req.headers["sec-websocket-protocol"]);
  if (!ticket) return { rejected: "ticket" };

  const userId = await redeemTicket(ticket);
  if (!userId) return { rejected: "ticket" };
  return { userId };
}
