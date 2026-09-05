import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the HTTP API actually lives. SERVER-SIDE ONLY — deliberately not
 * `NEXT_PUBLIC_`, so it is never inlined into the browser bundle and a
 * per-environment change is a restart, not a rebuild.
 */
const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * Emit a self-contained server bundle for the Docker image: Next traces the
   * files actually reachable and writes `.next/standalone`, so the image needs
   * neither the pnpm store nor a `next` install at runtime.
   *
   * Harmless outside Docker — `pnpm dev` and `next start` ignore it — so it is
   * unconditional rather than env-gated.
   *
   * Pairs with `outputFileTracingRoot` below: tracing must start at the
   * monorepo root, because the reachable set includes workspace packages that
   * live outside apps/web.
   */
  output: "standalone",
  /**
   * The browser talks to `/api/*` on its OWN origin; Next proxies to the API.
   *
   * This exists because `SameSite=Lax` cookies are not sent — and, as measured,
   * not even STORED — cross-site. With web and api on separate origins in
   * production, the session cookie never sticks and every authenticated request
   * 401s. Same-origin makes the cookie a first-party cookie again.
   *
   * DEV USES THIS PATH TOO, on purpose. A dev-only direct connection is exactly
   * what hid this bug: localhost shared an origin, so the cross-site case never
   * ran until production.
   */
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/:path*` }];
  },
  // Pin the workspace root so Next doesn't pick up unrelated lockfiles.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Internal packages ship TS source (JIT) — let Next transpile them.
  transpilePackages: ["@sketchsync/shared"],
  webpack: (config) => {
    // Our TS-source workspace packages use NodeNext-style ".js" extensions in
    // their relative imports (needed for the api/realtime NodeNext builds).
    // Teach webpack to resolve those to the ".ts" sources.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ...(config.resolve.extensionAlias ?? {}),
    };
    return config;
  },
};

export default nextConfig;
