import { loadEnv } from "@sketchsync/config";

// Load apps/realtime/.env into process.env for local dev. In production the
// platform injects real env vars and no .env file exists — that's fine.
try {
  process.loadEnvFile();
} catch {
  // No local .env file — rely on the ambient environment.
}

export const env = loadEnv();
