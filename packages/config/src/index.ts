import { z } from "zod";

/**
 * Runtime environment contract. Secrets (DATABASE_URL, JWT_SECRET) are required
 * with NO default values. Non-secret operational settings (NODE_ENV, WEB_ORIGIN)
 * have safe local-dev defaults. Ports are coerced from strings.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
  API_PORT: z.coerce.number().int().positive(),
  REALTIME_PORT: z.coerce.number().int().positive(),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  // Browser origin allowed to call the API with credentials (CORS).
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
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

  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
