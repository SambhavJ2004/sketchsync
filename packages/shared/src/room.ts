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
