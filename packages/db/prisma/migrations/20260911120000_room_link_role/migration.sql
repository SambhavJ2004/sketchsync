-- Per-board role for link joins.
--
-- `POST /rooms/:slug/join` hardcoded EDITOR, so opening a board to "anyone with
-- the link" meant opening it to anyone with the link EDITING it. There was no
-- way to share a board read-only without minting an invite per person — and a
-- VIEWER invite on a LINK board was close to meaningless, since the recipient
-- could ignore it, open the board URL and click Join to get EDITOR anyway.
--
-- DEFAULT 'EDITOR' is deliberate and is the no-change default: it is exactly
-- what the route did before this column existed, so every existing LINK board
-- keeps behaving as it did. Unlike the visibility migration, there is nothing
-- to reconsider here — a board that was open for editing stays open for
-- editing until its owner says otherwise.
--
-- Typed as the full "Role" enum because Prisma has only one, but the API
-- refuses OWNER (see InviteRole in @sketchsync/shared): a share link must never
-- be able to mint a second owner.

-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "linkRole" "Role" NOT NULL DEFAULT 'EDITOR';
