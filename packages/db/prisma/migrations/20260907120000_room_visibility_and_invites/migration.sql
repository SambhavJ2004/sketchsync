-- Private boards and invites (Phase 3, step 1).
--
-- Before this, a board's slug WAS an edit credential: `POST /rooms/:slug/join`
-- always granted EDITOR, every 403 rendered as "Join this board?", and VIEWER
-- could only be produced by direct SQL. This adds the two things needed to
-- express access properly — a visibility setting on the room, and a real invite
-- credential.

-- CreateEnum
CREATE TYPE "RoomVisibility" AS ENUM ('PRIVATE', 'LINK');

-- AlterTable
-- New rooms default to PRIVATE. That default is the point of the phase.
ALTER TABLE "Room" ADD COLUMN     "visibility" "RoomVisibility" NOT NULL DEFAULT 'PRIVATE';

-- BACKFILL — every existing room becomes PRIVATE.
--
-- THIS IS ONLY SAFE BECAUSE THE DATABASE WAS EMPTY WHEN THIS MIGRATION WAS
-- WRITTEN. Production was wiped before Phase 3 began, so there were zero Room
-- rows: no live share link can break, because none exists.
--
-- The general rule points the other way, and it is worth stating so nobody
-- copies this line into a later migration by pattern-matching. Rooms created
-- before this change were made under the old rule, where anyone holding the
-- slug could join and edit, and their owners may have shared that link. Against
-- a populated database, flipping them to PRIVATE would silently revoke access
-- people were relying on — so the correct backfill there would be
-- `... = 'LINK'`, preserving existing behaviour and making it explicit.
--
-- With no rows to preserve, that reasoning has no subject, and defaulting the
-- table to LINK would encode exactly the opposite of what this phase exists to
-- do: it would ship a "private boards" migration whose every row says public.
-- The statement is kept rather than dropped so the intent is recorded and the
-- outcome does not depend on the column default alone.
UPDATE "Room" SET "visibility" = 'PRIVATE';

-- CreateTable
CREATE TABLE "Invite" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    -- SHA-256 of the token, hex. The raw value is returned to the creator once
    -- and never stored, so a database leak yields no usable invite.
    "tokenHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'EDITOR',
    "createdBy" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    -- Use budget. Redemption is gated on usedCount < maxUses, and that
    -- comparison is evaluated inside the atomic UPDATE that consumes a use.
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    -- Non-null once revoked. Kept rather than deleted: "this link was revoked"
    -- and "no such link" are different facts and the audit trail is worth more
    -- than the row.
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Unique: the hash is how an invite is looked up during redemption, and two
-- invites sharing one token would make redemption ambiguous.
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
-- Serves the owner-facing invite list for a room.
CREATE INDEX "Invite_roomId_idx" ON "Invite"("roomId");

-- CreateIndex
-- Supports sweeping expired invites, mirroring WsTicket's expiry index.
CREATE INDEX "Invite_expiresAt_idx" ON "Invite"("expiresAt");

-- AddForeignKey
-- Cascade: deleting a room should take its invites with it, or a dangling
-- invite would redeem into nothing.
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT, matching Room.ownerId and Element.createdBy: an invite records who
-- issued it, and that attribution should not silently become an orphan id.
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
