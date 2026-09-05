# SketchSync — Shipping Plan

Getting the project from "works on my machine, no git" to "public repo with a live link."

**How to use this with Claude Code:** work one phase at a time. Each phase lists what to
build and the traps specific to *this* codebase. Do not hand Claude Code the whole file and
say "do it" — the phases have real dependencies and Phase 0 has to land first.

Read `ARCHITECTURE.md` alongside this. Where they disagree, ARCHITECTURE.md describes what
exists and this file describes what should exist.

---

## Phase 0 — Git and secrets (do this before anything else)

Right now there is no `.git` directory. That means **every edit Claude Code makes is
unrecoverable.** Nothing else in this plan should start until this phase is done.

1. **Rotate secrets first, while they're still only local.**
   - Neon: reset the database password, get a fresh connection string.
   - Generate a new `JWT_SECRET` (32+ random bytes). Rotating this invalidates every
     existing session cookie — fine, there are no real users.
   - Update `apps/api/.env`, `apps/realtime/.env`, `packages/db/.env`.

2. **Extend `.gitignore`.** The current file correctly covers `.env` / `.env.*` with a
   `!.env.example` exception. Three things it misses, all of which are currently in the tree:
   ```
   apps/e2e/results.json
   apps/e2e/test-results/
   apps/e2e/playwright-report/
   .claude/settings.local.json
   ```
   `.claude/settings.local.json` also contains absolute Windows paths, so it is machine-specific
   as well as noisy.

3. **`git init`, commit, push to a private GitHub repo.** Private for now; flip to public at
   the end of Phase 5. Then verify nothing leaked:
   ```bash
   git ls-files | grep -E '\.env$|\.env\.' ,   # should show only .env.example files
   git grep -iE 'postgres(ql)?://|npg_' -- ':!*.example'   # should be empty
   ```

4. **Work in branches from here.** One branch per phase. This is what makes Claude Code safe
   to use aggressively.

---

## Phase 1 — Docker

Two goals, and it's worth being clear that they're different:

- **Local development parity.** Right now there is no local Postgres at all — dev *and* the
  Playwright suite both run against hosted Neon. That's the weakest part of the setup. A local
  Postgres container fixes it and is a prerequisite for CI in Phase 2.
- **Deployment artifact.** Render deploys `api` and `realtime` from Dockerfiles in Phase 4.
  `web` goes to Vercel and is **not** containerized for deployment — but it is included in the
  full-stack compose file so `docker compose up` gives a working app from a fresh clone.

### Files to add

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Full stack: postgres + migrate + api + realtime + web |
| `docker-compose.dev.yml` | Postgres only — the one you'll actually use day to day alongside `pnpm dev` |
| `apps/api/Dockerfile` | Multi-stage, build context = repo root |
| `apps/realtime/Dockerfile` | Same shape |
| `apps/web/Dockerfile` | Compose only; Vercel does not use it |
| `.dockerignore` | `node_modules`, `.next`, `dist`, `.turbo`, `.git`, `apps/e2e/test-results` |

### Traps specific to this repo

1. **Build context must be the monorepo root.** The services consume workspace packages as
   raw TypeScript (`"exports": { ".": "./src/index.ts" }`), so a per-app build context cannot
   work. In compose: `context: .` with `dockerfile: apps/api/Dockerfile`.

2. **Use `node:22-bookworm-slim`, not Alpine.** Prisma's query engine and `bcrypt` both want
   glibc. On slim you still need `apt-get install -y openssl ca-certificates` for Prisma.

3. **`@prisma/client` is external to the tsup bundle** (`noExternal` covers `@sketchsync/*`
   only), so the generated client and its native engine must exist in the runtime image.
   Run `prisma generate` inside the build stage on the same base image as the runtime stage,
   and add an explicit target to `schema.prisma` as insurance:
   ```prisma
   generator client {
     provider      = "prisma-client-js"
     binaryTargets = ["native", "debian-openssl-3.0.x"]
   }
   ```
   Your dev machine is Windows, so a client generated on the host will *not* work in the
   container. Never copy host `node_modules` in.

4. **Enable pnpm via corepack**, pinned to the version in `package.json`:
   ```dockerfile
   RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
   ```

5. **`pnpm deploy --filter` can be awkward in pnpm 10/11 workspaces.** If it fights you, don't
   burn an hour on it — copy `dist/` plus the full `node_modules` into the runtime stage and
   move on. Image size is not a portfolio criterion.

6. **Migrations need their own one-shot service.** Use `prisma migrate deploy`, never
   `db push` — `db push` will not create the `sketchsync_insert_element` plpgsql function
   from migration `20260806130000`, and without it every element create races. Have `api` and
   `realtime` use `depends_on: { migrate: { condition: service_completed_successfully } }`.

7. **`NEXT_PUBLIC_REALTIME_URL` is inlined at build time** — it must be a build `ARG` in the
   web Dockerfile, not a runtime env var. `API_ORIGIN` is the opposite: runtime only.

8. **In compose, `WEB_ORIGIN` must be the origin the browser uses** (`http://localhost:3000`),
   not the compose service name. It's an exact-match allowlist at WebSocket upgrade; get it
   wrong and every socket 403s.

### Starting point for `apps/api/Dockerfile`

Treat this as a sketch to iterate on, not something to trust unverified:

```dockerfile
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json      apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json     packages/db/
COPY packages/auth/package.json   packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/typescript-config/package.json packages/typescript-config/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @sketchsync/db exec prisma generate
RUN pnpm --filter @sketchsync/api build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/packages/db/node_modules ./packages/db/node_modules
EXPOSE 3001
CMD ["node", "dist/index.js"]
```

The `prisma generate` step writes into `node_modules/.prisma/client`; confirm that path
survives into the runtime stage before assuming it works.

### Done when

```bash
docker compose up --build          # from a clean clone, with no .env files present
```
brings up a working app at `http://localhost:3000` — signup, create a board, draw in two
browser windows, see both cursors.

Also point the Playwright suite at the local Postgres and confirm all 27 e2e tests still pass.
`pnpm test:e2e` no longer touching Neon is the real win of this phase.

---

## Phase 2 — CI

You already have the gate; it just needs to run automatically:

```
pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm test:e2e
```

`.github/workflows/ci.yml`, on push and PR:

- `services: postgres:16` as a GitHub Actions service container (now possible because of Phase 1)
- `pnpm/action-setup` + `actions/setup-node` with `cache: pnpm`
- `prisma migrate deploy` against the service container
- Run the full gate. `CI=true` is set automatically, which correctly flips
  `reuseExistingServer: !process.env.CI` to `false`.
- Upload the Playwright report as an artifact on failure.

**Trap:** ARCHITECTURE.md §11 item 27 documents a known e2e flake — one run in three failed on
`waitForCanvas`'s 30s ceiling with the board visibly rendered. It is deliberately unexplained
and the timeout was deliberately not raised. Do not "fix" CI by bumping that number. If it
flakes in CI, re-run once and treat a second failure as real. If it flakes persistently, that
becomes a genuine debugging task, not a config tweak.

Add a green CI badge to the README. It is a surprisingly strong signal to anyone browsing.

---

## Phase 3 — Private boards and invites

The biggest code change in this plan. Today `POST /rooms/:slug/join` **always grants EDITOR**,
so anyone with a slug can edit any board, and `VIEWER` can only be created by direct SQL.

### Design

Reuse the pattern you already built in `apps/api/src/auth/ticket.ts`: random token, only the
SHA-256 hash stored, raw value returned once, atomic redemption. Doing invites the same way
is both less code and a good thing to be able to explain in an interview.

```prisma
enum RoomVisibility {
  PRIVATE   // members only; a link alone grants nothing
  LINK      // anyone with the link may join (today's behaviour, now opt-in)
}

model Room {
  // ...existing fields
  visibility RoomVisibility @default(PRIVATE)
}

model Invite {
  id        String    @id @default(uuid())
  roomId    String
  tokenHash String    @unique
  role      Role      @default(EDITOR)
  createdBy String
  expiresAt DateTime
  maxUses   Int       @default(1)
  usedCount Int       @default(0)
  revokedAt DateTime?
  createdAt DateTime  @default(now())

  room Room @relation(fields: [roomId], references: [id], onDelete: Cascade)

  @@index([roomId])
  @@index([expiresAt])
}
```

Routes:

| Route | Who | Notes |
| --- | --- | --- |
| `POST /rooms/:slug/invites` | OWNER | Returns the raw token **once**, plus an accept URL |
| `GET /rooms/:slug/invites` | OWNER | Metadata only — never raw tokens |
| `DELETE /rooms/:slug/invites/:id` | OWNER | Sets `revokedAt` |
| `POST /invites/:token/accept` | any signed-in user | Redeem → `RoomMember` at the invite's role |
| `GET /rooms/:slug/members` | any member | Fills gap #7 |
| `DELETE /rooms/:slug/members/:userId` | OWNER | Remove a member |
| `POST /rooms/:slug/join` | any signed-in user | **Now only succeeds when `visibility = LINK`** |

**Redemption must be a single atomic statement**, the same discipline as `redeemTicket`:

```sql
UPDATE "Invite" SET "usedCount" = "usedCount" + 1
WHERE "tokenHash" = $1
  AND "revokedAt" IS NULL
  AND "expiresAt" > NOW()
  AND "usedCount" < "maxUses"
RETURNING "roomId", "role"
```

Two users redeeming a single-use invite simultaneously must not both get in. Write a test for
exactly that.

### Client changes

- A real 403 screen. Today `apps/web/app/room/[slug]/page.tsx` renders *every* 403 as
  "Join this board?" — that becomes wrong the moment private boards exist. Private board →
  "You don't have access to this board." LINK board → the existing join prompt.
- New route `/invite/[token]` that accepts and redirects into the board.
- Owner-facing panel: create invite (role + expiry + single-use vs multi-use), copy link,
  member list, revoke.

### The wrinkle worth knowing about before you start

`api` and `realtime` never talk to each other — they share only a database. And per
ARCHITECTURE.md §11 item 8, `conn.role` is snapshotted at `join`. So **removing a member or
downgrading their role does not take effect until their socket reconnects.** They keep drawing.

Two options:

- **(a) Accept and document it.** Revocation applies on next connect. Note it in the README.
  Zero new coupling. This is the right default.
- **(b) Add a small internal endpoint on `realtime`** (`POST /internal/evict`, guarded by a
  shared secret) that `api` calls to close the affected sockets. `RoomRegistry` already holds
  the connections, so it's roughly 40 lines — but it breaks the "these services never talk"
  property, which is currently a clean part of the design.

Start with (a). Only do (b) if you want the demo to show instant revocation.

### Done when

The full gate passes. Expect e2e breakage — several specs assume join-grants-EDITOR. The
fixtures that write `RoomMember` rows directly (`addMember()`) will still work, and you can now
delete the comment explaining that no HTTP route can grant VIEWER, because one finally can.

---

## Phase 4 — Deploy

### Neon

- Get **both** connection strings: pooled (host contains `-pooler`) and direct.
- Add `directUrl` to `schema.prisma` — currently missing, ARCHITECTURE.md §11 item 22:
  ```prisma
  datasource db {
    provider  = "postgresql"
    url       = env("DATABASE_URL")       // pooled — the app
    directUrl = env("DIRECT_URL")         // direct — migrations
  }
  ```
- Add `DIRECT_URL` to the Zod schema in `packages/config`. It should be **optional**, so local
  Docker Postgres (no pooler) still boots.

### Render — two Docker web services

`sketchsync-api` (port 3001) and `sketchsync-realtime` (port 3002), both from their Dockerfiles
with the repo root as context. Health check paths: `/health` on both.

**Free tier reality:** services sleep after 15 minutes idle and take ~50 seconds to wake. The
chain is web → api (ticket fetch) → realtime (socket), so a first visitor after idle can wait a
long time. Two mitigations, do both:

- A free cron ping (cron-job.org or similar) hitting both `/health` endpoints every 10 minutes.
- A line in the README saying the first load may take a minute. Honesty reads better than a
  visitor assuming the app is broken.

Your client already fetches a fresh ticket before *every* connect attempt, so reconnect after a
sleep works correctly. That is a design decision paying off — worth mentioning in an interview.

### Vercel — web

Root directory is the repo root (it's a monorepo); build command `pnpm build --filter
@sketchsync/web`. Environment variables:

| Variable | Value | Lifecycle |
| --- | --- | --- |
| `API_ORIGIN` | `https://sketchsync-api.onrender.com` | **Runtime** — deliberately not `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_REALTIME_URL` | `wss://sketchsync-realtime.onrender.com` | **Build time, inlined** — changing it needs a redeploy |

Note the `wss://`, not `ws://`. Mixed content will be blocked outright.

### The one that will bite you

`WEB_ORIGIN` on `realtime` is an exact-match allowlist and is a genuine security control — it is
the only thing preventing cross-site WebSocket hijack now that the credential is client-supplied.
Every Vercel **preview** deployment gets a different domain, so every preview will 403 at upgrade
while production works fine.

Pick one:

- Change `WEB_ORIGIN` to a comma-separated list in `packages/config` and include your
  production domain plus any preview pattern you actually need. Parse it into an array; keep
  exact matching per entry. **Do not** switch to prefix or wildcard matching — that quietly
  removes the protection.
- Or accept it: production works, previews have no realtime. Document it.

### Environment matrix for production

| Variable | web (Vercel) | api (Render) | realtime (Render) |
| --- | --- | --- | --- |
| `DATABASE_URL` (pooled) | — | ✓ | ✓ (identical) |
| `DIRECT_URL` | — | ✓ (migrations) | — |
| `JWT_SECRET` | — | ✓ | ✓ (**must be identical**) |
| `NODE_ENV=production` | auto | ✓ (drives cookie `secure`) | ✓ |
| `WEB_ORIGIN` | — | ✓ (CORS) | ✓ (**upgrade allowlist**) |
| `API_PORT` / `REALTIME_PORT` | — | 3001 | 3002 |
| `API_ORIGIN` | ✓ runtime | — | — |
| `NEXT_PUBLIC_REALTIME_URL` | ✓ build | — | — |

### Post-deploy smoke test

Two different browsers, two accounts, one board: draw, move, delete, undo, both cursors visible,
export PNG and SVG, kill the network on one side and confirm it reconnects, sign out and back in.

---

## Phase 5 — README, demo, resume

The README is the highest-value hour in this entire plan. Most people who open the GitHub link
read it and nothing else.

Structure:

1. **One-sentence description and a live link**, above everything.
2. **A GIF.** Two cursors drawing on one board, 10–15 seconds. This does more than any
   paragraph. Record with two browser windows side by side.
3. **Architecture diagram** — the ASCII one at the top of `ARCHITECTURE.md` is already good.
4. **Three or four "interesting problems" with one paragraph each.** This is where you separate
   yourself from every other whiteboard clone:
   - the cross-origin WebSocket ticket handshake, and the measured cookie bug that forced it
   - the z-index race: 138 duplicates in 200 concurrent creates, fixed with a plpgsql advisory
     lock after benchmarking and rejecting two cheaper approaches
   - size-weighted rate limiting with decaying violation scoring
5. **Quick start:** `docker compose up`. One command.
6. **Known limitations**, honestly. Link to ARCHITECTURE.md §11. Publishing an honest gap list
   reads as senior, not as weakness — very few student projects have one.
7. Free-tier cold-start note.

### Resume bullets

The current bullets undersell the project badly. "JWT-based authentication" describes every CRUD
app ever written. Suggested replacements — pick three:

- Built a real-time collaborative whiteboard where multiple users draw, edit and see live
  cursors on a shared infinite canvas, synced over WebSockets with optimistic local rendering.
- Designed a cross-origin WebSocket auth handshake using single-use, hashed-at-rest tickets
  (15s TTL) passed via `Sec-WebSocket-Protocol`, with an origin allowlist enforced at upgrade.
- Hardened the gateway with size-weighted token-bucket rate limiting and decaying violation
  scoring; eliminated a z-order race (138 duplicates across 200 concurrent creates) using a
  Postgres advisory-lock insert function after benchmarking two rejected alternatives.
- Containerized the stack with Docker Compose and gated every push with CI running 170
  automated tests (Vitest + Playwright); deployed on Vercel, Render and Neon.

The last bullet only becomes true after Phases 1, 2 and 4. Don't put it on the resume before then.

### Finally

Flip the repo to public. Re-run the leak check from Phase 0 first.

---

## Also worth fixing while you're in there

Cheap, and they're the kind of thing an attentive reviewer notices:

- `apps/web/.env.example` still describes the socket as cookie-authenticated and calls the
  ticket work "Phase 4 step 3b." That shipped. (§11 item 31)
- `CLAUDE.md` lists the board route as `/canvas`; boards live at `/room/[slug]` and `/canvas` is
  a redirect. (§11 item 32)
- No rate limiting on `signup` / `signin` — only `/auth/ws-ticket` is throttled. You already have
  a token-bucket implementation sitting in `ticketLimiter.ts`; reusing it on the auth routes is
  a small change with a real security story attached. (§11 item 9)
