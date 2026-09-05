-- Single-use, short-lived WebSocket tickets.
--
-- The socket cannot authenticate with the session cookie: in production it must
-- reach the realtime host directly and cross-origin (a Vercel rewrite does not
-- proxy WebSocket connections), and cross-site cookies are not sent — measured
-- in Phase 4.3a, not even STORED. The API mints a ticket over the same-origin
-- /api proxy and the gateway redeems it during the upgrade handshake.
--
-- Only the SHA-256 hash is persisted, so a database leak yields nothing usable.
-- Redemption is a single `DELETE ... RETURNING`, which makes consumption atomic
-- across the two processes: api and realtime are separate services and share
-- only this database, so the row itself is the synchronisation point.

CREATE TABLE "WsTicket" (
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WsTicket_pkey" PRIMARY KEY ("tokenHash")
);

-- Supports the opportunistic sweep of expired rows.
CREATE INDEX "WsTicket_expiresAt_idx" ON "WsTicket"("expiresAt");

ALTER TABLE "WsTicket" ADD CONSTRAINT "WsTicket_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
