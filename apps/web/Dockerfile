# apps/web — Next.js 15 app (canvas engine + realtime client).
#
# BUILD CONTEXT IS THE MONOREPO ROOT, never apps/web:
#
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_REALTIME_URL=ws://localhost:3002 \
#     -t sketchsync-web .
#
# FOR COMPOSE ONLY. Production deploys web to Vercel, which builds from source
# and never reads this file. It exists so `docker compose up` yields a working
# app from a fresh clone.

FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
FROM base AS build

# Every workspace manifest: --frozen-lockfile validates against the whole
# workspace and reads a missing one as a stale lockfile.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json                   apps/api/
COPY apps/realtime/package.json              apps/realtime/
COPY apps/web/package.json                   apps/web/
COPY apps/e2e/package.json                   apps/e2e/
COPY packages/auth/package.json              packages/auth/
COPY packages/config/package.json            packages/config/
COPY packages/db/package.json                packages/db/
COPY packages/shared/package.json            packages/shared/
COPY packages/eslint-config/package.json     packages/eslint-config/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/db/prisma packages/db/prisma

# web depends only on @sketchsync/shared, so this pulls in neither Prisma nor
# the server-only packages. There is no --prod stage here: `output: standalone`
# already traces the reachable file set, which is a tighter filter than
# production-vs-dev dependencies.
RUN pnpm install --frozen-lockfile --filter @sketchsync/web...

COPY . .

# ── The two env vars behave differently, and mixing them up is the classic
# ── failure here.
#
# NEXT_PUBLIC_REALTIME_URL is INLINED INTO THE BROWSER BUNDLE at build time, so
# it must be an address the BROWSER can reach — a host-published one. Putting a
# compose service name here (ws://realtime:3002) compiles fine and then breaks
# every socket in the browser, because DNS for `realtime` only exists inside the
# container network. Changing it is a rebuild, never a restart.
ARG NEXT_PUBLIC_REALTIME_URL=ws://localhost:3002
ENV NEXT_PUBLIC_REALTIME_URL=$NEXT_PUBLIC_REALTIME_URL

# API_ORIGIN is read by next.config.ts to build the /api/* rewrite. It is
# consumed by the NEXT SERVER, which runs inside the container network, so it is
# a SERVICE NAME (http://api:3001) and must never be NEXT_PUBLIC_.
#
# It is set at build time AND at runtime deliberately. Next evaluates
# `rewrites()` during `next build` and writes the result into
# routes-manifest.json, so the build-time value is the one that actually routes
# traffic; the runtime ENV in the final stage is belt-and-braces for any code
# path that re-reads it. Treat a change to this as a REBUILD.
ARG API_ORIGIN=http://api:3001
ENV API_ORIGIN=$API_ORIGIN

RUN pnpm --filter @sketchsync/web build

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# `output: standalone` traces the reachable files into .next/standalone. Because
# outputFileTracingRoot is the MONOREPO ROOT, that directory mirrors the repo
# layout — node_modules at its top and the server at apps/web/server.js — which
# is why this copies to ./ and starts apps/web/server.js rather than server.js.
COPY --from=build /app/apps/web/.next/standalone ./
# Static assets are deliberately NOT traced (they are served, not imported), so
# they must be copied separately or every page loads unstyled with no JS.
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static

# The standalone server defaults HOSTNAME to localhost, which inside a container
# means it accepts nothing from outside it — the port looks published but every
# connection is refused. 0.0.0.0 is required, not optional.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV API_ORIGIN=http://api:3001

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/signin').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
