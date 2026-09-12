import { Router } from "express";
import {
  CreateInviteInput,
  CreateRoomInput,
  UpdateMemberRoleInput,
  UpdateRoomInput,
} from "@sketchsync/shared";
import { Role, prismaClient, type Room } from "@sketchsync/db";
import { requireAuth } from "../middleware/requireAuth.js";
import { formatZodError } from "../lib/validation.js";
import { env } from "../env.js";
import { createRoomWithOwner } from "./service.js";
import { requireMembership } from "./membership.js";
import { acceptInvite, issueInvite, toInviteView } from "./invites.js";
// The no-owner-left-behind rule. Extracted and pure so it is unit-tested
// directly rather than only through the two routes that call it.
import { refuseIfOwnerTarget } from "./ownerGuard.js";
// The one api -> realtime call. Fire-and-forget and NOT the security
// boundary — membership is still re-checked on join. See evict.ts.
import { notifyEviction } from "./evict.js";

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
    visibility: room.visibility,
    linkRole: room.linkRole,
    role,
  };
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

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

  // Visibility is not settable at creation: a new board is PRIVATE (the schema
  // default) and opening it up is a separate, deliberate PATCH.
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
      room: {
        select: {
          id: true,
          slug: true,
          name: true,
          ownerId: true,
          visibility: true,
          linkRole: true,
        },
      },
    },
    orderBy: { room: { createdAt: "desc" } },
  });

  res.status(200).json(
    memberships.map((m) => ({
      id: m.room.id,
      slug: m.room.slug,
      name: m.room.name,
      ownerId: m.room.ownerId,
      visibility: m.room.visibility,
      linkRole: m.room.linkRole,
      role: m.role,
    })),
  );
});

// POST /rooms/:slug/join — join a LINK board. PRIVATE boards refuse.
//
// This route used to be the entire access model, and it always granted EDITOR:
// possession of a slug was possession of edit rights. It is now gated on the
// room opting in to that behaviour.
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

  // THE PHASE 3 GATE. A private board cannot be joined by asking; it needs an
  // invite. Answered as 403 with the visibility, matching requireMembership, so
  // the client renders "you don't have access" rather than a join prompt.
  if (room.visibility !== "LINK") {
    res.status(403).json({
      message: "This board is private. You need an invite to join.",
      visibility: room.visibility,
    });
    return;
  }

  // Upsert makes this idempotent and race-safe: existing members keep their
  // current role; new members are added as EDITOR. Either way -> 200.
  // Grants the board's OWN linkRole, not a hardcoded EDITOR. Before this column
  // existed, "anyone with the link" always meant "anyone with the link can
  // EDIT" — there was no way to share a board read-only, and a VIEWER invite on
  // a LINK board was close to meaningless because the recipient could ignore it,
  // open the board URL and click Join to get EDITOR anyway.
  //
  // `update: {}` keeps never-demote true here too: an existing EDITOR who
  // re-joins a board whose link has since been set to view-only keeps EDITOR.
  const membership = await prismaClient.roomMember.upsert({
    where: { roomId_userId: { roomId: room.id, userId } },
    update: {},
    create: { roomId: room.id, userId, role: room.linkRole },
    select: { role: true },
  });

  res.status(200).json(membershipView(room, membership.role));
});

// PATCH /rooms/:slug — rename and/or change visibility. OWNER ONLY.
//
// Editors arrive through an invite or a share link and are effectively guests;
// read/draw access does not imply the right to relabel someone else's board, and
// certainly not to open it to the internet.
//
// NOTE: neither change propagates to clients already in the board — the WS
// protocol has no room-metadata message and adding one would break the
// no-new-message-types rule. For a rename that is a stale title. For visibility
// it is more subtle: flipping LINK -> PRIVATE does not evict anyone who is
// already a member, because it governs who may JOIN, not who already has. That
// is the intended meaning, not a gap.
roomRouter.patch("/:slug", requireMembership(Role.OWNER), async (req, res) => {
  const room = req.room;
  const role = req.roomRole;
  if (!room || !role) {
    res.status(500).json({ message: "Membership context missing" });
    return;
  }

  const parsed = UpdateRoomInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(formatZodError(parsed.error));
    return;
  }

  const updated = await prismaClient.room.update({
    where: { id: room.id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.visibility !== undefined
        ? { visibility: parsed.data.visibility }
        : {}),
      ...(parsed.data.linkRole !== undefined
        ? { linkRole: parsed.data.linkRole }
        : {}),
    },
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

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

// GET /rooms/:slug/members — any member may see who else is in the board.
//
// Deliberately readable by VIEWERs: you can already see everyone's cursor and
// presence avatar in the canvas, so the membership list discloses nothing new,
// and hiding it would make the collaborator list inconsistent with the board.
roomRouter.get("/:slug/members", requireMembership(), async (req, res) => {
  const room = req.room;
  if (!room) {
    res.status(500).json({ message: "Membership context missing" });
    return;
  }

  const members = await prismaClient.roomMember.findMany({
    where: { roomId: room.id },
    select: {
      role: true,
      user: { select: { id: true, name: true, email: true, avatarUrl: true } },
    },
    orderBy: { user: { name: "asc" } },
  });

  res.status(200).json(
    members.map((m) => ({
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      avatarUrl: m.user.avatarUrl,
      role: m.role,
      isOwner: m.user.id === room.ownerId,
    })),
  );
});

// PATCH /rooms/:slug/members/:userId — change a member's role. OWNER ONLY.
roomRouter.patch(
  "/:slug/members/:userId",
  requireMembership(Role.OWNER),
  async (req, res) => {
    const room = req.room;
    const callerId = req.userId;
    const targetUserId = req.params.userId;
    if (!room || !callerId) {
      res.status(500).json({ message: "Membership context missing" });
      return;
    }
    if (!targetUserId) {
      res.status(400).json({ message: "Missing user id" });
      return;
    }

    const parsed = UpdateMemberRoleInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(formatZodError(parsed.error));
      return;
    }

    const refusal = refuseIfOwnerTarget(room, callerId, targetUserId, "change the role of");
    if (refusal) {
      res.status(403).json({ message: refusal });
      return;
    }

    const existing = await prismaClient.roomMember.findUnique({
      where: { roomId_userId: { roomId: room.id, userId: targetUserId } },
      select: { id: true },
    });
    if (!existing) {
      res.status(404).json({ message: "That user is not a member of this board" });
      return;
    }

    const updated = await prismaClient.roomMember.update({
      where: { roomId_userId: { roomId: room.id, userId: targetUserId } },
      data: { role: parsed.data.role },
      select: { role: true },
    });

    // Take effect on any LIVE socket too, not just on their next connect.
    // Best-effort: if the gateway is unreachable this returns 200 anyway and the
    // change still applies when they reconnect, because `join` re-reads the role.
    notifyEviction({
      action: "roleChanged",
      roomId: room.id,
      userId: targetUserId,
      role: parsed.data.role,
    });

    res.status(200).json({ userId: targetUserId, role: updated.role });
  },
);

// DELETE /rooms/:slug/members/:userId — remove a member. OWNER ONLY.
roomRouter.delete(
  "/:slug/members/:userId",
  requireMembership(Role.OWNER),
  async (req, res) => {
    const room = req.room;
    const callerId = req.userId;
    const targetUserId = req.params.userId;
    if (!room || !callerId) {
      res.status(500).json({ message: "Membership context missing" });
      return;
    }
    if (!targetUserId) {
      res.status(400).json({ message: "Missing user id" });
      return;
    }

    const refusal = refuseIfOwnerTarget(room, callerId, targetUserId, "remove");
    if (refusal) {
      res.status(403).json({ message: refusal });
      return;
    }

    const deleted = await prismaClient.roomMember.deleteMany({
      where: { roomId: room.id, userId: targetUserId },
    });
    if (deleted.count === 0) {
      res.status(404).json({ message: "That user is not a member of this board" });
      return;
    }

    // Close their live sockets on this board. Best-effort — their next `join`
    // would be refused regardless, which is where the real guarantee lives.
    notifyEviction({
      action: "removed",
      roomId: room.id,
      userId: targetUserId,
    });

    res.status(200).json({ ok: true, userId: targetUserId });
  },
);

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

// POST /rooms/:slug/invites — mint an invite. OWNER ONLY.
//
// Returns the RAW TOKEN EXACTLY ONCE. It is not recoverable afterwards: only its
// SHA-256 is stored, so re-showing it is impossible by construction rather than
// by policy.
roomRouter.post("/:slug/invites", requireMembership(Role.OWNER), async (req, res) => {
  const room = req.room;
  const userId = req.userId;
  if (!room || !userId) {
    res.status(500).json({ message: "Membership context missing" });
    return;
  }

  const parsed = CreateInviteInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(formatZodError(parsed.error));
    return;
  }

  const { invite, token } = await issueInvite({
    roomId: room.id,
    createdBy: userId,
    // Zod has already narrowed this to EDITOR | VIEWER; OWNER invites are not
    // mintable (see InviteRole in @sketchsync/shared).
    role: parsed.data.role as Role,
    expiresInHours: parsed.data.expiresInHours,
    maxUses: parsed.data.maxUses,
  });

  // WEB_ORIGIN is a list; the first entry is the canonical public origin, and
  // the rest are additional allowed origins (preview domains and the like). An
  // invite link has to name exactly one host, so it uses the canonical one.
  const acceptUrl = `${env.WEB_ORIGIN[0]}/invite/${token}`;

  res.status(201).json({
    ...toInviteView(invite),
    token,
    acceptUrl,
  });
});

// GET /rooms/:slug/invites — list invites. OWNER ONLY. METADATA ONLY.
//
// `toInviteView` cannot leak a token: the raw value was never stored and the
// hash is not part of the view type.
roomRouter.get("/:slug/invites", requireMembership(Role.OWNER), async (req, res) => {
  const room = req.room;
  if (!room) {
    res.status(500).json({ message: "Membership context missing" });
    return;
  }

  const invites = await prismaClient.invite.findMany({
    where: { roomId: room.id },
    orderBy: { createdAt: "desc" },
  });

  res.status(200).json(invites.map(toInviteView));
});

// DELETE /rooms/:slug/invites/:id — revoke. OWNER ONLY.
//
// Sets `revokedAt` rather than deleting the row: the atomic redemption gate
// tests `revokedAt IS NULL`, and keeping the row preserves the audit trail —
// "this link was revoked" is a more useful answer than "no such link".
roomRouter.delete(
  "/:slug/invites/:id",
  requireMembership(Role.OWNER),
  async (req, res) => {
    const room = req.room;
    const inviteId = req.params.id;
    if (!room) {
      res.status(500).json({ message: "Membership context missing" });
      return;
    }
    if (!inviteId) {
      res.status(400).json({ message: "Missing invite id" });
      return;
    }

    // Scoped by roomId as well as id, so an owner of board A cannot revoke an
    // invite belonging to board B by guessing its id.
    const revoked = await prismaClient.invite.updateMany({
      where: { id: inviteId, roomId: room.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (revoked.count === 0) {
      // Either no such invite in this room, or it was already revoked. Both are
      // "nothing further to do" from the caller's point of view, but 404 would
      // be misleading for an already-revoked invite, so distinguish them.
      const exists = await prismaClient.invite.findFirst({
        where: { id: inviteId, roomId: room.id },
        select: { id: true },
      });
      if (!exists) {
        res.status(404).json({ message: "Invite not found" });
        return;
      }
      res.status(200).json({ ok: true, alreadyRevoked: true });
      return;
    }

    res.status(200).json({ ok: true, alreadyRevoked: false });
  },
);

// ---------------------------------------------------------------------------
// Invite acceptance (mounted at /invites, not under a room)
// ---------------------------------------------------------------------------
// Separate router because the caller is by definition NOT yet a member, so none
// of the room middleware applies — the token itself is the authorization.

export const inviteRouter: Router = Router();
inviteRouter.use(requireAuth);

/** Redemption failures, mapped to a status and a message a user can act on. */
const REDEEM_FAILURES = {
  not_found: { status: 404, message: "This invite link is not valid." },
  revoked: { status: 410, message: "This invite link has been revoked." },
  expired: { status: 410, message: "This invite link has expired." },
  exhausted: { status: 410, message: "This invite link has already been used." },
} as const;

// POST /invites/:token/accept — redeem an invite and join the room.
inviteRouter.post("/:token/accept", async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  const token = req.params.token;
  if (!token) {
    res.status(400).json({ message: "Missing invite token" });
    return;
  }

  const result = await acceptInvite(token, userId);
  if (!result.ok) {
    const { status, message } = REDEEM_FAILURES[result.reason];
    res.status(status).json({ message });
    return;
  }

  const room = await prismaClient.room.findUnique({ where: { id: result.roomId } });
  if (!room) {
    // The room was deleted between redemption and this read. Any use spent is
    // gone; that is the safe direction (see acceptInvite).
    res.status(404).json({ message: "That board no longer exists." });
    return;
  }

  // `outcome` lets the client say what actually happened. Without it,
  // "you already had access, nothing changed" is indistinguishable from
  // "you just joined" — which is exactly how a VIEWER invite that silently did
  // nothing went unnoticed.
  res.status(200).json({
    ...membershipView(room, result.role),
    outcome: result.kind,
    previousRole: result.previousRole ?? null,
    usedAUse: result.usedAUse,
  });
});
