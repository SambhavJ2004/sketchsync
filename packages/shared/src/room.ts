import { z } from "zod";

/**
 * Board name bounds, shared by create AND rename so the two cannot drift.
 *
 * 1..80: a board name is a label in a list, not prose. 80 fits the rooms-list
 * row and the board chrome without truncating, while still allowing something
 * descriptive. Trimmed first, so "   " is rejected as empty rather than stored
 * as whitespace.
 */
export const ROOM_NAME_MIN = 1;
export const ROOM_NAME_MAX = 80;

export const RoomName = z
  .string()
  .trim()
  .min(ROOM_NAME_MIN, "Name is required")
  .max(ROOM_NAME_MAX, `Name must be ${ROOM_NAME_MAX} characters or fewer`);

export const CreateRoomInput = z.object({
  name: RoomName,
});
export type CreateRoomInput = z.infer<typeof CreateRoomInput>;

/** PATCH /rooms/:slug — OWNER only (see apps/api/src/rooms/routes.ts). */
export const RenameRoomInput = z.object({
  name: RoomName,
});
export type RenameRoomInput = z.infer<typeof RenameRoomInput>;

// ---------------------------------------------------------------------------
// Roles and visibility
// ---------------------------------------------------------------------------
// These mirror the Prisma enums `Role` and `RoomVisibility`. The duplication is
// deliberate and unavoidable: this package is imported by the BROWSER, and the
// generated Prisma enums live in @sketchsync/db, which is Prisma-backed and
// server-only. Same reasoning as the ROLE_RANK duplication called out in
// CLAUDE.md. A unit test pins these values against the Prisma enums so they
// cannot silently drift.

export const MemberRole = z.enum(["OWNER", "EDITOR", "VIEWER"]);
export type MemberRole = z.infer<typeof MemberRole>;

export const RoomVisibility = z.enum(["PRIVATE", "LINK"]);
export type RoomVisibility = z.infer<typeof RoomVisibility>;

/**
 * Roles an INVITE may grant. Deliberately excludes OWNER.
 *
 * A board has exactly one owner column (`Room.ownerId`) and the API forbids an
 * owner removing or demoting themselves, because a board with no owner is
 * unrecoverable. Minting OWNER invites would create a second way to reach a
 * multi-owner state that the rest of the model does not describe — so it is
 * refused at the edge rather than half-supported. Transferring ownership, if it
 * is ever wanted, should be its own explicit route.
 */
export const InviteRole = z.enum(["EDITOR", "VIEWER"]);
export type InviteRole = z.infer<typeof InviteRole>;

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/** 30 days. Long enough for "send it and forget it", short enough that a leaked
 *  link does not stay live indefinitely. */
export const INVITE_MAX_EXPIRY_HOURS = 24 * 30;
/** Upper bound on a multi-use link. Not a capacity limit — a guard against a
 *  typo turning a team link into an unbounded one. */
export const INVITE_MAX_USES = 1000;

/**
 * POST /rooms/:slug/invites.
 *
 * Expiry is expressed as a DURATION, not an absolute timestamp: the server owns
 * the clock, so a client cannot mint a far-future invite by sending a skewed or
 * hand-edited date, and there is no timezone ambiguity to get wrong.
 */
export const CreateInviteInput = z.object({
  role: InviteRole.default("EDITOR"),
  expiresInHours: z
    .number()
    .int()
    .positive()
    .max(INVITE_MAX_EXPIRY_HOURS, `Expiry must be ${INVITE_MAX_EXPIRY_HOURS} hours or fewer`)
    .default(24),
  maxUses: z
    .number()
    .int()
    .positive()
    .max(INVITE_MAX_USES, `Max uses must be ${INVITE_MAX_USES} or fewer`)
    .default(1),
});
export type CreateInviteInput = z.infer<typeof CreateInviteInput>;

// ---------------------------------------------------------------------------
// Room update / membership management
// ---------------------------------------------------------------------------

/**
 * PATCH /rooms/:slug — OWNER only. Supersedes RenameRoomInput, which is kept so
 * existing callers and their tests keep compiling.
 *
 * Both fields optional, but at least one required: a PATCH with an empty body is
 * a client bug, and silently returning 200 for it hides that.
 */
export const UpdateRoomInput = z
  .object({
    name: RoomName.optional(),
    visibility: RoomVisibility.optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.visibility !== undefined,
    { message: "Provide at least one of: name, visibility" },
  );
export type UpdateRoomInput = z.infer<typeof UpdateRoomInput>;

/**
 * PATCH /rooms/:slug/members/:userId — OWNER only.
 *
 * EDITOR/VIEWER only, for the same reason invites are: promoting someone to
 * OWNER is a transfer, not a role change, and is not modelled.
 */
export const UpdateMemberRoleInput = z.object({
  role: InviteRole,
});
export type UpdateMemberRoleInput = z.infer<typeof UpdateMemberRoleInput>;
