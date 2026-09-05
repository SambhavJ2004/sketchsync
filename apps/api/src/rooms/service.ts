import { Prisma, Role, prismaClient, type Room } from "@sketchsync/db";
import { randomSuffix, slugify } from "./slug.js";

const MAX_SLUG_ATTEMPTS = 5;

/**
 * Create a room and its owner membership atomically. Generates a unique slug
 * (base + random suffix) and retries on the rare slug collision (P2002).
 */
export async function createRoomWithOwner(
  ownerId: string,
  name: string,
): Promise<Room> {
  const base = slugify(name) || "room";
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = `${base}-${randomSuffix()}`;
    try {
      // Single transaction: the Room and the OWNER RoomMember are created
      // together or not at all.
      return await prismaClient.$transaction(async (tx) => {
        const room = await tx.room.create({
          data: { slug, name, ownerId },
        });
        await tx.roomMember.create({
          data: { roomId: room.id, userId: ownerId, role: Role.OWNER },
        });
        return room;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        lastError = err; // slug collided — try another suffix
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("Could not generate a unique room slug");
}
