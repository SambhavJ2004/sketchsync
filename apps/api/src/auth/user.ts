import type { User } from "@sketchsync/db";

/** The only user fields ever sent to clients — never the passwordHash. */
export interface SafeUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };
}
