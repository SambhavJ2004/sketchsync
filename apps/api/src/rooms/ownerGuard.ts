/**
 * The rule protecting a board from losing its owner.
 *
 * A BOARD WITH NO OWNER IS UNRECOVERABLE. `Room.ownerId` would point at someone
 * who is no longer a member; nothing could grant OWNER again, because invites
 * deliberately cannot mint one and role changes are capped at EDITOR; and every
 * owner-only route would then 403 for everybody, including the routes that would
 * be needed to fix it. There is no recovery path short of direct SQL.
 *
 * So this is enforced as its own pure function rather than inline in a handler:
 * it guards two different routes (remove and demote), and it is exactly the kind
 * of rule that gets quietly dropped when one of them is rewritten.
 *
 * Kept free of Express and Prisma imports so it can be unit-tested directly.
 */

export type OwnerGuardVerb = "remove" | "change the role of";

/**
 * Decide whether an owner-only membership operation must be refused.
 *
 * Two targets are refused regardless of who is asking:
 *
 *   - **yourself** — the direct footgun the rule exists for. An owner clicking
 *     "remove" on their own row would strand the board.
 *   - **the room's `ownerId`** — because OWNER is a *rank*, and a second
 *     OWNER-ranked member (reachable today only by direct SQL, but the schema
 *     permits it) could otherwise demote the real owner. Guarding only "self"
 *     would leave that hole open.
 *
 * @returns a message explaining the refusal, or `null` when the operation may
 *          proceed.
 */
export function refuseIfOwnerTarget(
  room: { ownerId: string },
  callerId: string,
  targetUserId: string,
  verb: OwnerGuardVerb,
): string | null {
  if (targetUserId === callerId) {
    return `You cannot ${verb} yourself. A board must keep an owner.`;
  }
  if (targetUserId === room.ownerId) {
    return `You cannot ${verb} the board's owner.`;
  }
  return null;
}
