import "./fixtures/env.js"; // MUST precede the @sketchsync/db import
import { prismaClient } from "@sketchsync/db";
import { WEB_ORIGIN, createRoom, createUser, cleanup } from "./fixtures/seed.js";

/**
 * Absorb cold-start latency BEFORE any test runs.
 *
 * Neon suspends an idle branch, so the first query pays ~1s (and the first large
 * write far more). The API's /auth/me baseline is ~90ms warm but much worse
 * cold. Paying that inside the first test is the classic source of a suite that
 * fails only on the first run of the day.
 */
async function globalSetup(): Promise<void> {
  const t0 = Date.now();

  // 1. Wake Neon with a trivial round trip through Prisma.
  await prismaClient.$queryRaw`SELECT 1`;
  const dbMs = Date.now() - t0;

  // 2. Exercise the full proxied path the tests use, so Next has compiled the
  //    /api rewrite and the API's pool is warm.
  const t1 = Date.now();
  const health = await fetch(`${WEB_ORIGIN}/api/health`);
  if (!health.ok) throw new Error(`proxied /api/health failed: ${health.status}`);
  const proxyMs = Date.now() - t1;

  // 3. Compile the board route once. Next dev compiles per-route on first hit,
  //    which can take seconds and would otherwise land inside a test's timeout.
  const t2 = Date.now();
  await fetch(`${WEB_ORIGIN}/signin`);
  await fetch(`${WEB_ORIGIN}/rooms`);
  const pagesMs = Date.now() - t2;

  // 4. Compile the board route too. Next dev compiles per-route on first hit
  //    (measured ~17s for /signin cold), which would otherwise land inside the
  //    first test's timeout rather than here.
  const t3 = Date.now();
  const warmUser = await createUser("warmup");
  const warmRoom = await createRoom(warmUser, "warmup");
  await fetch(`${WEB_ORIGIN}/room/${warmRoom.slug}`);
  await cleanup([warmRoom], [warmUser]);
  const boardMs = Date.now() - t3;

  console.log(
    `[e2e] warmup: db ${dbMs}ms, proxied api ${proxyMs}ms, ` +
      `pages ${pagesMs}ms, board route ${boardMs}ms`,
  );
  await prismaClient.$disconnect();
}

export default globalSetup;
