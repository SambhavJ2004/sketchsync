import type { FieldIssue } from "@/lib/api/client";

/** field name -> first error message for that field. */
export type FieldErrors = Record<string, string>;

/** Structural view of a ZodError (avoids a direct zod dependency in web). */
interface ZodErrorLike {
  issues: { path: (string | number)[]; message: string }[];
}

/** Client-side validation errors from a shared Zod schema (first per field). */
export function zodToFieldErrors(err: ZodErrorLike): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of err.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in out)) out[key] = issue.message;
  }
  return out;
}

/** The api's Zod field issues (path is dot-joined) -> field error map. */
export function issuesToFieldErrors(issues: FieldIssue[] | undefined): FieldErrors {
  const out: FieldErrors = {};
  if (!issues) return out;
  for (const i of issues) {
    const key = i.path.split(".")[0];
    if (key && !(key in out)) out[key] = i.message;
  }
  return out;
}

/** Where to land after auth: a safe same-app path, defaulting to /rooms. */
export function safeNext(next: string | null): string {
  // Only allow internal absolute paths (prevents open-redirects to other sites).
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/rooms";
}
