import { Router } from "express";
import { CreateRoomInput, RenameRoomInput } from "@sketchsync/shared";
import { Role, prismaClient, type Room } from "@sketchsync/db";
import { requireAuth } from "../middleware/requireAuth.js";
import { formatZodError } from "../lib/validation.js";
import { createRoomWithOwner } from "./service.js";
import { requireMembership } from "./membership.js";

export const roomRouter: Router = Router();

// Every room route requires authentication.
roomRouter.use(requireAuth);

/** Shape returned for a room + the caller's role in it. */
function membershipView(room: Room, role: Role) {
  return {
    id: room.id,
    slug: room.slug,
    name: room.name,
    ownerId: room.ownerId,
    role,
  };
}

// POST /rooms — create a room; caller becomes OWNER.
roomRouter.post("/", async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  const parsed = CreateRoomInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(formatZodError(parsed.error));
    return;
  }

  const room = await createRoomWithOwner(userId, parsed.data.name);
  res.status(201).json(membershipView(room, Role.OWNER));
});

// GET /rooms — rooms the caller is a member of, with their role in each.
roomRouter.get("/", async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  const memberships = await prismaClient.roomMember.findMany({
    where: { userId },
    select: {
      role: true,
      room: { select: { id: true, slug: true, name: true, ownerId: true } },
    },
    orderBy: { room: { createdAt: "desc" } },
  });

  res.status(200).json(
    memberships.map((m) => ({
      id: m.room.id,
      slug: m.room.slug,
      name: m.room.name,
      ownerId: m.room.ownerId,
      role: m.role,
    })),
  );
});

// POST /rooms/:slug/join — open-collaboration join as EDITOR (idempotent).
roomRouter.post("/:slug/join", async (req, res) => {
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

  // Upsert makes this idempotent and race-safe: existing members keep their
  // current role; new members are added as EDITOR. Either way -> 200.
  const membership = await prismaClient.roomMember.upsert({
    where: { roomId_userId: { roomId: room.id, userId } },
    update: {},
    create: { roomId: room.id, userId, role: Role.EDITOR },
    select: { role: true },
  });

  res.status(200).json(membershipView(room, membership.role));
});

// PATCH /rooms/:slug — rename. OWNER ONLY.
//
// Editors join through a share link and are effectively guests; letting a guest
// rename someone else's board is a surprise the owner cannot undo without
// noticing. Read/draw access does not imply the right to relabel the thing.
//
// NOTE: a rename does NOT propagate to clients already in the board — the WS
// protocol has no room-metadata message and adding one would violate the
// no-new-message-types rule. The divergence is a stale title in the board
// chrome only; it self-corrects on reload or on navigating back via /rooms.
roomRouter.patch("/:slug", requireMembership(Role.OWNER), async (req, res) => {
  const room = req.room;
  const role = req.roomRole;
  if (!room || !role) {
    res.status(500).json({ message: "Membership context missing" });
    return;
  }

  const parsed = RenameRoomInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(formatZodError(parsed.error));
    return;
  }

  const updated = await prismaClient.room.update({
    where: { id: room.id },
    data: { name: parsed.data.name },
  });
  res.status(200).json(membershipView(updated, role));
});

// GET /rooms/:slug — room metadata + caller's role (must be a member).
roomRouter.get("/:slug", requireMembership(), async (req, res) => {
  const room = req.room;
  const role = req.roomRole;
  if (!room || !role) {
    res.status(500).json({ message: "Membership context missing" });
    return;
  }

  const memberCount = await prismaClient.roomMember.count({
    where: { roomId: room.id },
  });

  res.status(200).json({ ...membershipView(room, role), memberCount });
});
