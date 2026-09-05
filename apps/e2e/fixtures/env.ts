import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load DATABASE_URL for the test process.
 *
 * The apps each call `process.loadEnvFile()` at startup; the e2e runner is not
 * an app, so it has no env of its own. Rather than duplicating the secret into
 * another gitignored file, reuse the one Prisma already owns.
 *
 * MUST be imported before anything that imports @sketchsync/db — the Prisma
 * client singleton reads DATABASE_URL when it is constructed at module load.
 * ESM evaluates dependencies in import order, so `import "./env.js"` placed
 * first is what guarantees that.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dbEnv = join(here, "..", "..", "..", "packages", "db", ".env");

if (!process.env.DATABASE_URL && existsSync(dbEnv)) {
  process.loadEnvFile(dbEnv);
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    `e2e: DATABASE_URL is not set and ${dbEnv} was not found. ` +
      "The suite needs database access to seed and clean up fixtures.",
  );
}
