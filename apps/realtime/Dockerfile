# apps/realtime — WebSocket gateway (upgrade auth, rooms, sync, presence).
#
# BUILD CONTEXT IS THE MONOREPO ROOT, never apps/realtime:
#
#   docker build -f apps/realtime/Dockerfile -t sketchsync-realtime .
#
# Same shape as apps/api/Dockerfile; the differences are the install filter,
# the port, and the entrypoint. That file carries the full reasoning for each
# stage — the comments here cover only what differs or what would be dangerous
# to get wrong while editing this one alone.

# ---------------------------------------------------------------------------
# base — shared by every stage, so the Prisma engine matches at runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# manifests — every workspace package.json
# ---------------------------------------------------------------------------
# All of them: --frozen-lockfile validates against the whole workspace and
# treats a missing manifest as a stale lockfile.
FROM base AS manifests
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

# ---------------------------------------------------------------------------
# build — full install, then bundle
# ---------------------------------------------------------------------------
FROM manifests AS build
RUN pnpm install --frozen-lockfile --filter @sketchsync/realtime...
COPY . .
RUN pnpm --filter @sketchsync/db exec prisma generate

# STAGE THE WHOLE .pnpm ENTRY, not just @prisma/client. `prisma generate`
# writes its real output — index.js, the schema, and the query engine — into a
# SIBLING `.prisma/client` directory, and @prisma/client merely re-exports from
# it. Copying only @prisma/client produces an image that builds fine and then
# dies at first construction with "@prisma/client did not initialize yet".
#
# Resolved with node rather than hardcoded: the .pnpm hash encodes peer deps
# and is not guaranteed to match between the full and prod installs.
#   resolve    -> .pnpm/<hash>/node_modules/@prisma/client/package.json
#   x3 dirname -> .pnpm/<hash>/node_modules   (holds BOTH @prisma/ and .prisma/)
RUN cd apps/realtime \
 && PRISMA_NM="$(node -e "const p=require.resolve('@prisma/client/package.json'),d=require('path').dirname;console.log(d(d(d(p))))")" \
 && echo "staging prisma tree from: $PRISMA_NM" \
 && mkdir -p /staged && cp -R "$PRISMA_NM" /staged/prisma-nm \
 && test -d /staged/prisma-nm/.prisma/client \
 && test -f /staged/prisma-nm/@prisma/client/package.json

RUN pnpm --filter @sketchsync/realtime build

# ---------------------------------------------------------------------------
# prod-deps
# ---------------------------------------------------------------------------
FROM manifests AS prod-deps

# packages/db's postinstall is `prisma generate`, and the prisma CLI is a
# devDependency — under --prod it fails with "prisma: not found" and takes the
# install down. Strip that ONE script rather than reaching for
# --ignore-scripts, which is a blunter tool than it looks: this service has no
# bcrypt, but it does depend on @prisma/engines' postinstall.
RUN node -e "const fs=require('fs'),f='packages/db/package.json',p=JSON.parse(fs.readFileSync(f,'utf8'));delete p.scripts.postinstall;fs.writeFileSync(f,JSON.stringify(p,null,2))"

RUN pnpm install --frozen-lockfile --filter @sketchsync/realtime... --prod

# Merged rather than replaced, so @prisma/client's own dependency links in this
# directory survive. The final step CONSTRUCTS a PrismaClient rather than merely
# requiring the package: `require` succeeds even when the generated output is
# missing, which is exactly how an earlier, broken version of this image passed
# its check and then died at boot. The dummy URL is enough — the constructor
# validates config and loads the engine, but opens no connection.
COPY --from=build /staged/prisma-nm /staged/prisma-nm
RUN cd apps/realtime \
 && PRISMA_NM="$(node -e "const p=require.resolve('@prisma/client/package.json'),d=require('path').dirname;console.log(d(d(d(p))))")" \
 && echo "restoring prisma tree into: $PRISMA_NM" \
 && cp -R /staged/prisma-nm/. "$PRISMA_NM/" \
 && rm -rf /staged \
 && test -d "$PRISMA_NM/.prisma/client" \
 && DATABASE_URL="postgresql://u:p@127.0.0.1:5432/d" node -e "const {PrismaClient}=require('@prisma/client');new PrismaClient();console.log('prisma client CONSTRUCTS in the prod tree')"

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# Paths preserved exactly as installed — pnpm's node_modules is a tree of
# relative symlinks and flattening /app/apps/realtime to /app breaks them.
COPY --from=prod-deps /app/node_modules               ./node_modules
COPY --from=prod-deps /app/apps/realtime/node_modules ./apps/realtime/node_modules
COPY --from=build     /app/apps/realtime/dist         ./apps/realtime/dist

USER node
EXPOSE 3002

# The gateway serves GET /health on the SAME http server it upgrades sockets
# on, so a healthy response also proves the upgrade listener is up.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.REALTIME_PORT||3002)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/realtime/dist/index.js"]
