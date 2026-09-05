import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { zLockKey } from "./messages.js";

// Element creation takes the per-room advisory lock inside a plpgsql function
// (migration 20260806130000); server-side renormalization takes it from TS via
// `zLockKey`. If those two key strings ever diverge, the two operations would
// serialize against DIFFERENT locks and could interleave — a create could read
// the max mid-rewrite. Nothing else would fail loudly, so pin it here.

const MIGRATIONS = join(
  import.meta.dirname,
  "../../../packages/db/prisma/migrations",
);

function lockMigrationSql(): string {
  const dir = readdirSync(MIGRATIONS).find((d) => d.endsWith("_element_zindex_lock"));
  if (!dir) throw new Error("element_zindex_lock migration not found");
  return readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8");
}

describe("advisory lock key", () => {
  it("uses a room-scoped key", () => {
    const room = "11111111-1111-4111-8111-111111111111";
    expect(zLockKey(room)).toBe(`sketchsync:zindex:${room}`);
  });

  it("is distinct per room", () => {
    expect(zLockKey("a")).not.toBe(zLockKey("b"));
  });

  it("matches the prefix the plpgsql insert function locks on", () => {
    const sql = lockMigrationSql();
    // The function builds: 'sketchsync:zindex:' || p_room::text
    const prefix = zLockKey("").replace(/:$/, ":");
    expect(sql).toContain(`'${prefix}' || p_room::text`);
    expect(sql).toContain("pg_advisory_xact_lock");
  });

  it("the migration still hashes the key the same way TS expects", () => {
    // Both sides must hash the FULL key string, not the bare uuid.
    expect(lockMigrationSql()).toContain(
      "hashtext('sketchsync:zindex:' || p_room::text)::bigint",
    );
  });
});
