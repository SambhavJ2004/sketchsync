# apps/api — HTTP service (auth + rooms + WS ticket issuance).
#
# BUILD CONTEXT IS THE MONOREPO ROOT, never apps/api:
#
#   docker build -f apps/api/Dockerfile -t sketchsync-api .
#
# The services consume workspace packages as raw TypeScript
# ("exports": { ".": "./src/index.ts" }), so a per-app context cannot see the
# code it needs to compile. In compose this is `context: .` with
# `dockerfile: apps/api/Dockerfile`.

# ---------------------------------------------------------------------------
# base — shared by every stage, deliberately
# ---------------------------------------------------------------------------
# bookworm-slim, NOT Alpine: Prisma's query engine and bcrypt are native and
# want glibc, not musl. openssl and ca-certificates are what Prisma's engine
# links against and what TLS to Postgres needs.
#
# Build and runtime share this base so the Prisma engine generated during the
# build provably matches the libc/openssl the runtime provides. Splitting them
# is how you get "works in build, PrismaClientInitializationError at boot".
FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Pinned to the packageManager field in the root package.json. An unpinned
# corepack would silently drift from the lockfile format.
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# manifests — every workspace package.json, and nothing else
# ---------------------------------------------------------------------------
# Shared by the two install stages below so they cache identically and cannot
# drift apart. `--frozen-lockfile` validates against the WHOLE workspace, so a
# missing package.json reads as "the lockfile is out of date" and fails the
# build — hence every manifest, including ones this service never uses.
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
# packages/db runs `prisma generate` on postinstall, which needs the schema to
# exist BEFORE install. Copied here rather than with the rest of the source so
# the dependency layers still cache independently of application code.
COPY packages/db/prisma packages/db/prisma

# ---------------------------------------------------------------------------
# build — full install (dev deps included), then bundle
# ---------------------------------------------------------------------------
FROM manifests AS build

# `@sketchsync/api...` (trailing dots) = this project plus its workspace
# dependencies, so Next.js and the Playwright suite are never installed.
RUN pnpm install --frozen-lockfile --filter @sketchsync/api...

COPY . .

# Generated INSIDE the image, on the runtime's own base. The host is Windows,
# so a client generated there would carry a query engine that cannot execute
# here — which is also why .dockerignore excludes **/node_modules outright.
RUN pnpm --filter @sketchsync/db exec prisma generate

# tsup bundles @sketchsync/* into dist but keeps @prisma/client external, so
# the generated client must reach the runtime stage.
#
# STAGE THE WHOLE .pnpm ENTRY, not just @prisma/client. `prisma generate`
# writes its real output — index.js, the schema, and the query engine — into a
# SIBLING `.prisma/client` directory, and @prisma/client merely re-exports from
# it. Copying only @prisma/client produces an image that builds fine and then
# dies at first construction with "@prisma/client did not initialize yet".
#
# Resolved with node rather than hardcoded: the .pnpm hash encodes peer deps
# and is not guaranteed to match between the full and prod installs.
#   resolve  -> .pnpm/<hash>/node_modules/@prisma/client/package.json
#   x3 dirname -> .pnpm/<hash>/node_modules   (holds BOTH @prisma/ and .prisma/)
RUN cd apps/api \
 && PRISMA_NM="$(node -e "const p=require.resolve('@prisma/client/package.json'),d=require('path').dirname;console.log(d(d(d(p))))")" \
 && echo "staging prisma tree from: $PRISMA_NM" \
 && mkdir -p /staged && cp -R "$PRISMA_NM" /staged/prisma-nm \
 && test -d /staged/prisma-nm/.prisma/client \
 && test -f /staged/prisma-nm/@prisma/client/package.json

RUN pnpm --filter @sketchsync/api build

# ---------------------------------------------------------------------------
# prod-deps — the same dependency graph, minus everything dev
# ---------------------------------------------------------------------------
FROM manifests AS prod-deps

# `--prod` cannot run packages/db's postinstall: that script is `prisma
# generate` and the prisma CLI is a devDependency, so it fails with
# "prisma: not found" and takes the whole install with it.
#
# Stripping this ONE script is deliberately narrower than `--ignore-scripts`,
# which would also skip bcrypt's node-pre-gyp step and ship an api that cannot
# hash a password. The generated client is copied in below instead.
RUN node -e "const fs=require('fs'),f='packages/db/package.json',p=JSON.parse(fs.readFileSync(f,'utf8'));delete p.scripts.postinstall;fs.writeFileSync(f,JSON.stringify(p,null,2))"

RUN pnpm install --frozen-lockfile --filter @sketchsync/api... --prod

# Merge the build-stage prisma tree over the prod one, resolving both ends with
# node so neither .pnpm hash is ever written down. Merged rather than replaced,
# so @prisma/client's own dependency links in this directory survive.
#
# The final step CONSTRUCTS a PrismaClient rather than merely requiring the
# package. `require` succeeds even when the generated output is missing, which
# is exactly how an earlier, broken version of this image passed its check and
# then died at boot. The dummy URL is enough: the constructor validates config
# and loads the engine, but opens no connection.
COPY --from=build /staged/prisma-nm /staged/prisma-nm
RUN cd apps/api \
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

# THE DIRECTORY LAYOUT HERE IS LOAD-BEARING. pnpm's isolated node_modules is a
# tree of RELATIVE symlinks: apps/api/node_modules/@prisma/client points at
# ../../node_modules/.pnpm/<hash>/node_modules/@prisma/client. Both ends must
# land at the same relative offsets they had in the install stage, so the app
# stays at /app/apps/api rather than being flattened to /app. Flattening breaks
# every symlink silently and surfaces as module-not-found at boot.
COPY --from=prod-deps /app/node_modules          ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build     /app/apps/api/dist         ./apps/api/dist

USER node
EXPOSE 3001

# node:22 has global fetch, so the check needs no curl/wget in the image.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/index.js"]
