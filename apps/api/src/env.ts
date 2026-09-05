import { loadEnv } from "@sketchsync/config";

// Load apps/api/.env into process.env for local dev. In production the platform
// injects real env vars and no .env file exists — that's fine, we ignore it.
try {
  process.loadEnvFile();
} catch {
  // No local .env file — rely on the ambient environment.
}

// Validated, typed env. Throws immediately if anything required is missing.
export const env = loadEnv();
