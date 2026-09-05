import { randomBytes } from "node:crypto";

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Turn an arbitrary name into a URL-safe base slug (no random suffix).
 * NFKD decomposes accented letters (é -> e + combining mark) and the
 * non-alphanumeric replace then drops the marks.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumerics -> hyphen
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, 48)
    .replace(/-+$/g, ""); // re-trim in case slice left a trailing hyphen
}

/** Short random URL-safe suffix, e.g. "x7k2", to disambiguate slugs. */
export function randomSuffix(length = 4): string {
  let out = "";
  for (const byte of randomBytes(length)) {
    out += SUFFIX_ALPHABET.charAt(byte % SUFFIX_ALPHABET.length);
  }
  return out;
}
