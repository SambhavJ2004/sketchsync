import type { RequestHandler } from "express";
// Authz helpers now live in @sketchsync/db so BOTH apps/api and apps/realtime
// import the same implementation (no copy-paste).
import { getMembership, roleAtLeast, Role, prismaClient } from "@sketchsync/db";

/**
 * Express middleware factory. Resolves `:slug` to a room, verifies the caller is
 * a member with at least `minRole`, and attaches `req.room` + `req.roomRole`.
 *   - 404 if the room doesn't exist
 *   - 403 if the caller isn't a member (or is below `minRole`)
 */
export function requireMembership(
  minRole: Role = Role.VIEWER,
): RequestHandler<{ slug: string }> {
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
      res.status(403).json({ message: "You are not a member of this room" });
      return;
    }

    req.room = room;
    req.roomRole = role;
    next();
  };
}
