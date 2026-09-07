import type { RequestHandler } from "express";
// Authz helpers now live in @sketchsync/db so BOTH apps/api and apps/realtime
// import the same implementation (no copy-paste).
import { getMembership, roleAtLeast, Role, prismaClient } from "@sketchsync/db";

/**
 * Express middleware factory. Resolves `:slug` to a room, verifies the caller is
 * a member with at least `minRole`, and attaches `req.room` + `req.roomRole`.
 *   - 404 if the room doesn't exist
 *   - 403 if the caller isn't a member (or is below `minRole`), with the room's
 *     `visibility` on the body so the client can tell "join this" from "you
 *     cannot join this"
 *
 * Params are typed as a loose dictionary rather than `{ slug: string }` so this
 * can also guard routes carrying extra params — `/:slug/members/:userId`,
 * `/:slug/invites/:id`. Pinning it to exactly `{ slug }` made those call sites
 * fail to typecheck. Only `slug` is read here; the rest belong to the handler.
 */
export function requireMembership(
  minRole: Role = Role.VIEWER,
): RequestHandler<Record<string, string>> {
  return async (req, res, next) => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }

    const slug = req.params.slug;
    if (!slug) {
      res.status(400).json({ message: "Missing room slug" });
      return;
    }

    const room = await prismaClient.room.findUnique({ where: { slug } });
    if (!room) {
      res.status(404).json({ message: "Room not found" });
      return;
    }

    const role = await getMembership(userId, room.id);
    if (!role || !roleAtLeast(role, minRole)) {
      // `visibility` rides on the 403 so the client can tell the two refusals
      // apart. Before private boards existed, every 403 meant "you could join
      // this if you wanted", and the UI rendered all of them as a join prompt.
      // Now PRIVATE means "you cannot join without an invite" and LINK means
      // "you may join" — different screens, and the client cannot distinguish
      // them from the status code alone.
      //
      // This does reveal that a room with this slug exists. That is already
      // observable (404 vs 403 draws the same line) and slugs carry a random
      // suffix, so it discloses nothing a guesser did not already supply.
      res.status(403).json({
        message: "You are not a member of this room",
        visibility: room.visibility,
      });
      return;
    }

    req.room = room;
    req.roomRole = role;
    next();
  };
}
