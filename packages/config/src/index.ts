import { z } from "zod";

// Runtime environment contract. Secrets (DATABASE_URL, JWT_SECRET) are required
// with NO default values. Non-secret operational settings (NODE_ENV, WEB_ORIGIN)
// have safe local-dev defaults. Ports are coerced from strings.

/**
 * Comma-separated list of allowed browser origins, parsed into an array.
 *
 * EXACT MATCHING PER ENTRY IS THE POINT. This feeds the WebSocket upgrade
 * allowlist in apps/realtime, which — since the socket credential became a
 * client-supplied ticket — is the only thing standing between a malicious page
 * and a cross-site WebSocket hijack. Widening an entry to a prefix, a suffix, or
 * a wildcard removes that protection: `https://app.example.com.evil.test`
 * prefix-matches `https://app.example.com`. Each entry is compared with `===`
 * and nothing else.
 *
 * Whitespace around commas is trimmed, and empty segments are dropped, because
 * those are artefacts of writing a list — not of matching. Entries are otherwise
 * used verbatim: no trailing-slash normalisation, no lowercasing, no default
 * port stripping. A browser sends a canonical, serialised origin, so anything
 * that does not match one of these byte-for-byte should be refused.
 */
const OriginList = z
  .string()
  .default("http://localhost:3000")
  .transform((raw, ctx) => {
    const origins = raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (origins.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must contain at least one origin",
      });
      return z.NEVER;
    }

    for (const origin of origins) {
      if (!z.string().url().safeParse(origin).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${origin}" is not a valid URL`,
        });
        return z.NEVER;
      }
    }

    return origins as readonly string[];
  });

const EnvSchema = z.object({
  /**
   * Runtime database connection. In production this is Neon's POOLED host, so
   * many short-lived connections do not exhaust the server's limit.
   */
  DATABASE_URL: z.string().url(),
  /**
   * DIRECT, non-pooled connection, used by Prisma for migrations only
   * (`directUrl` in schema.prisma). OPTIONAL on purpose: the local Docker
   * Postgres has no pooler, so there is nothing to bypass and the app must boot
   * without it. Required in production, where DATABASE_URL points at a pooler
   * that cannot run DDL or hold the advisory locks `migrate deploy` takes.
   *
   * Note this is optional for the APP. The Prisma CLI is stricter: with
   * `directUrl` present in the schema, `migrate deploy` fails outright when the
   * variable is unset, so anywhere migrations run must define it.
   */
  DIRECT_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(16),
  API_PORT: z.coerce.number().int().positive(),
  REALTIME_PORT: z.coerce.number().int().positive(),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  /**
   * Browser origins allowed to call the API with credentials (CORS) and to open
   * a WebSocket (the upgrade allowlist). One value, or several separated by
   * commas — a single value with no comma parses to a one-element array and
   * behaves exactly as it did before.
   */
  WEB_ORIGIN: OriginList,

  /**
   * Shared secret guarding `POST /internal/evict` on the realtime gateway.
   *
   * Must be BYTE-IDENTICAL on api and realtime: api sends it, realtime compares
   * it. Not a user credential and never seen by a browser — it authenticates one
   * service to the other, nothing more.
   *
   * OPTIONAL, with a production check below. Locally, leaving it unset simply
   * disables eviction: the gateway refuses every internal call and the API skips
   * making them. That degrades to exactly the pre-eviction behaviour (a demoted
   * user keeps their socket until they reconnect), which is a correct system —
   * just a slower-reacting one — so it is not worth blocking `pnpm dev` over.
   */
  INTERNAL_SECRET: z.string().min(16).optional(),

  /**
   * Where api reaches realtime for that call. API-side only.
   *
   * An INTERNAL address: the compose service name (`http://realtime:3002`) or
   * the Render service URL. Not the browser-facing socket URL, and not
   * NEXT_PUBLIC_ anything — no client ever sees this.
   */
  REALTIME_INTERNAL_URL: z.string().url().default("http://localhost:3002"),
});

/**
 * Production requires the internal secret; local development does not.
 *
 * Enforced here rather than by making the field non-optional, because the two
 * environments genuinely differ: a deployed gateway is reachable and must not
 * accept unauthenticated internal calls, while a local one is on localhost and
 * eviction is an optional convenience. Failing the boot of a deployed service is
 * the right outcome — silently running production without the secret would mean
 * eviction quietly never works, which is precisely the failure this phase set
 * out to remove.
 */
const EnvSchemaChecked = EnvSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV === "production" && !env.INTERNAL_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["INTERNAL_SECRET"],
      message:
        "is required in production (shared secret for POST /internal/evict; " +
        "must match on api and realtime)",
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/**
 * Read and validate `process.env`. Throws (fail-fast) if anything is missing or
 * invalid, so misconfiguration surfaces at boot rather than at first use.
 * The result is memoized after the first successful load.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = EnvSchemaChecked.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
