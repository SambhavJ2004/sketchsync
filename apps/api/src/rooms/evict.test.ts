import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The api -> realtime notification is BEST-EFFORT. These tests pin the property
 * that matters operationally: an unreachable, sleeping, misconfigured or angry
 * gateway must never turn a successful member removal into a failure.
 *
 * env is loaded the same way invites.test.ts does — src/env.ts calls loadEnv()
 * at module load, so the import has to come after.
 */
const here = dirname(fileURLToPath(import.meta.url));
const apiEnv = join(here, "..", "..", ".env");
if (!process.env.DATABASE_URL && existsSync(apiEnv)) {
  process.loadEnvFile(apiEnv);
}

const { sendEviction } = await import("./evict.js");
const { env } = await import("../env.js");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("eviction notify is best-effort", () => {
  it("RESOLVES FALSE when the gateway is unreachable — never throws", () => {
    // The acceptance criterion. `DELETE /rooms/:slug/members/:userId` calls this
    // and then responds 200; if this rejected, the route would 500 and the owner
    // would be told the removal failed when the database says otherwise.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:3002"),
    );
    return expect(sendEviction({
      action: "removed",
      roomId: "11111111-1111-1111-1111-111111111111",
      userId: "22222222-2222-2222-2222-222222222222",
    })).resolves.toBe(false);
  });

  it("resolves false on a TIMEOUT rather than propagating the abort", async () => {
    const abort = new Error("The operation was aborted due to timeout");
    abort.name = "TimeoutError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abort);

    await expect(
      sendEviction({
        action: "roleChanged",
        roomId: "11111111-1111-1111-1111-111111111111",
        userId: "22222222-2222-2222-2222-222222222222",
        role: "VIEWER",
      }),
    ).resolves.toBe(false);
  });

  it("resolves false on a 403 — a secret mismatch must not fail the removal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }),
    );

    await expect(
      sendEviction({
        action: "removed",
        roomId: "11111111-1111-1111-1111-111111111111",
        userId: "22222222-2222-2222-2222-222222222222",
      }),
    ).resolves.toBe(false);
  });

  it("resolves false on a 500 from the gateway", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("boom", { status: 500 }),
    );

    await expect(
      sendEviction({
        action: "removed",
        roomId: "11111111-1111-1111-1111-111111111111",
        userId: "22222222-2222-2222-2222-222222222222",
      }),
    ).resolves.toBe(false);
  });

  it("reports true when the gateway accepts it", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ closed: 1, updated: 0 }), { status: 200 }),
      );

    await expect(
      sendEviction({
        action: "removed",
        roomId: "11111111-1111-1111-1111-111111111111",
        userId: "22222222-2222-2222-2222-222222222222",
      }),
    ).resolves.toBe(env.INTERNAL_SECRET ? true : false);

    if (env.INTERNAL_SECRET) {
      // Sends the secret in the agreed header, and a timeout signal so a
      // sleeping service cannot stall the owner's request.
      const [, init] = spy.mock.calls[0] as [unknown, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["x-sketchsync-internal"]).toBe(env.INTERNAL_SECRET);
      expect(init.signal).toBeDefined();
    }
  });
});

describe("eviction notify when the feature is switched off", () => {
  it("makes NO request at all when no secret is configured", async () => {
    // Local development with INTERNAL_SECRET unset: not an error, just no
    // eviction. The system stays correct — a demotion applies on reconnect.
    const spy = vi.spyOn(globalThis, "fetch");

    if (env.INTERNAL_SECRET) {
      // A secret IS configured in this environment, so the negative case cannot
      // be exercised here. Assert the positive counterpart instead, so this test
      // is never silently vacuous.
      spy.mockResolvedValue(new Response("{}", { status: 200 }));
      await sendEviction({
        action: "removed",
        roomId: "11111111-1111-1111-1111-111111111111",
        userId: "22222222-2222-2222-2222-222222222222",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      return;
    }

    await expect(
      sendEviction({
        action: "removed",
        roomId: "11111111-1111-1111-1111-111111111111",
        userId: "22222222-2222-2222-2222-222222222222",
      }),
    ).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
