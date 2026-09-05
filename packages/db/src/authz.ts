import type { Role } from "@prisma/client";
import { prismaClient } from "./client.js";

// Shared authorization surface — imported by BOTH apps/api (room routes) and
// apps/realtime (WS gateway). Role ordering: OWNER > EDITOR > VIEWER.
export const ROLE_RANK: Record<Role, number> = {
  OWNER: 3,
  EDITOR: 2,
  VIEWER: 1,
};

/** True if `role` is at least as privileged as `min`. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** The caller's role in the room, or null if they are not a member. */
export async function getMembership(
  userId: string,
  roomId: string,
): Promise<Role | null> {
  const membership = await prismaClient.roomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
    select: { role: true },
  });
  return membership?.role ?? null;
}
