import bcrypt from "bcrypt";

const COST_FACTOR = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST_FACTOR);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * A precomputed hash to compare against when a sign-in email doesn't exist, so
 * the "no such user" path still spends roughly the same time doing a bcrypt
 * compare as the "wrong password" path (mitigates user-enumeration by timing).
 * The plaintext is irrelevant and never a real password.
 */
export const DUMMY_HASH = bcrypt.hashSync("no-such-user-placeholder", COST_FACTOR);
