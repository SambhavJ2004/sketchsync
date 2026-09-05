import { defineConfig } from "@playwright/test";

/**
 * The three services are started SEPARATELY rather than via `pnpm dev`, so each
 * gets its own readiness probe. Turbo's combined output gives no per-service
 * signal, and "the web server answered" does not imply the API or the gateway
 * are up — which is precisely how a suite becomes flaky on a cold machine.
 *
 * Readiness order matters: api and realtime both open a Neon pool, and web's
 * /api/* rewrite is useless until the API answers. Playwright starts all three
 * and blocks until every `url` responds; `globalSetup` then does a real
 * database round trip to absorb Neon's cold start (~1s) before any test runs,
 * so the first test does not pay it and time out.
 */
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./globalSetup.ts",
  // Serial: these tests share one database and one realtime process, and several
  // deliberately stop a service. Parallel workers would fight over that.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "results.json" }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.E2E_WEB_ORIGIN ?? "http://localhost:3000",
    trace: "retain-on-failure",
    video: "off",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
  },
  projects: [{ name: "chromium", use: { channel: undefined, browserName: "chromium" } }],
  webServer: [
    {
      command: "pnpm --filter @sketchsync/api dev",
      url: "http://localhost:3001/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter @sketchsync/realtime dev",
      url: "http://localhost:3002/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // NEXT_PUBLIC_E2E=1 installs the read-only inspection hook.
      command: "pnpm --filter @sketchsync/web dev",
      url: "http://localhost:3000/signin",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { NEXT_PUBLIC_E2E: "1" },
    },
  ],
});
