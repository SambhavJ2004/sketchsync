import { createHash, randomBytes } from "node:crypto";
import { WS_TICKET_TTL_SECONDS } from "@sketchsync/auth";
import { prismaClient } from "@sketchsync/db";

/**
 * WebSocket ticket minting.
 *
 * CHOSEN: an opaque random value stored (hashed) in the database, NOT a signed
 * JWT carrying a `jti`.
 *
 * Single-use has to be enforced across two separate processes whose only shared
 * state is this database, so a redemption round trip is unavoidable either way.
 * Once that is true, a JWT's statelessness buys nothing — it would still need a
 * `jti` row to mark as consumed, i.e. the same write, plus signature handling
 * and a second secret-bearing token format to keep in sync. The opaque value
 * collapses that: the ROW IS THE TICKET, so `DELETE ... RETURNING` is both the
 * validity check and the consumption, atomically, with no window in which a
 * ticket is valid-but-not-yet-marked.
 *
 * Only the SHA-256 hash is persisted. The raw value exists in the response body
 * and in the client's memory, never at rest.
 */

/** 32 random bytes, base64url — a valid RFC 6455 subprotocol token. */
function newTicketValue(): string {
  return randomBytes(32).toString("base64url");
}

export function hashTicket(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Mint a ticket for `userId` and return the RAW value (shown once). */
export async function issueTicket(userId: string): Promise<{
  ticket: string;
  expiresAt: Date;
}> {
  const ticket = newTicketValue();
  const expiresAt = new Date(Date.now() + WS_TICKET_TTL_SECONDS * 1000);

  await prismaClient.wsTicket.create({
    data: { tokenHash: hashTicket(ticket), userId, expiresAt },
  });

  // Opportunistic sweep of this user's dead rows. Tickets live seconds, so
  // without it every abandoned connect attempt would leak a row forever. Cheap
  // and best-effort: a failure here must never fail issuance.
  void prismaClient.wsTicket
    .deleteMany({ where: { userId, expiresAt: { lt: new Date() } } })
    .catch(() => undefined);

  return { ticket, expiresAt };
}
