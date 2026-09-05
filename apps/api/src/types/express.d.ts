import type { Role, Room } from "@sketchsync/db";

// Declaration merging: extend Express's Request in a type-safe way (no
// `@ts-ignore`). All optional because they're only set after the relevant
// middleware (`requireAuth` / `requireMembership`) has run.

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      room?: Room;
      roomRole?: Role;
    }
  }
}

export {};
