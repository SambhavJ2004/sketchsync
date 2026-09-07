# SketchSync — Shipping Plan

Getting the project from "works on my machine, no git" to "public repo with a live link."

**How to use this with Claude Code:** work one phase at a time. Each phase lists what to
build and the traps specific to *this* codebase. Do not hand Claude Code the whole file and
say "do it" — the phases have real dependencies and Phase 0 has to land first.

Read `ARCHITECTURE.md` alongside this. Where they disagree, ARCHITECTURE.md describes what
exists and this file describes what should exist.

---

## Progress

**THIS SECTION IS THE SOURCE OF TRUTH FOR PROJECT STATE.** Read it before doing anything
else in this repo. Where any other document — `ARCHITECTURE.md`, `CLAUDE.md`, a code
comment — disagrees with it, this section wins and the other document is stale.

**Update it at the end of every phase.** A phase is not finished until its entry here says
so. Prose elsewhere drifts; this list is what a new session is told to trust.

- **Phase 0 — done.** Secrets rotated, `.gitignore` extended, git initialised, pushed to
  the private repo `SambhavJ2004/sketchsync`. One branch per phase.

- **Phase 1 — done.** Local Postgres via `docker-compose.dev.yml`; migrations applied with
  `migrate deploy` and `sketchsync_insert_element` confirmed present. Dockerfiles for api,
  realtime and web; full `docker-compose.yml` verified from a clean `down -v`. Images:
  **api 752 MB, realtime 742 MB, web 448 MB**. The full e2e suite has been run against the
  local containerized Postgres: **27 passed in 5.3 minutes, no flake.**

- **Phase 2 — done.** `.github/workflows/ci.yml` with a `gate` job and a `docker` job.
  `docker` was green on the first run. `gate` failed on run #1 with turbo strict env mode —
  Turbo 2 strips variables a task does not declare, which is invisible locally because the
  apps read `.env` off disk — fixed by declaring env vars **per task** in `turbo.json`
  rather than in `globalEnv`, so cache keys stay granular. **Run #2 passed the full gate in
  6m26s, including `test:e2e` on a Linux runner** — the suite is now verified in CI, not
  only locally. The `ci` branch is merged into `main`.

- **Phase 4 — done. The app is deployed and working end to end.**

  **Topology:**
  - **Database — Neon.** Migrations applied with `migrate deploy` against the direct
    (non-pooled) URL; the app runs on the pooled one.
  - **Render — `sketchsync-api` and `sketchsync-realtime`**, both as **Docker** services in
    **Singapore** on the **free** plan, created from the `render.yaml` blueprint and tracking
    `main`.
  - **Vercel — `apps/web`**, with the project's root directory set to `apps/web`, and
    `API_ORIGIN` and `NEXT_PUBLIC_REALTIME_URL` set there. Both are build-time values, so
    changing either is a redeploy, not a restart (see `ARCHITECTURE.md` §8).
  - **`WEB_ORIGIN` on both Render services points at the Vercel domain.** On realtime that
    is the WebSocket upgrade allowlist, so this value is what makes the socket work at all —
    and it is the security control, not a convenience.

  **Verified in the browser against the live deployment:** signup, board creation, and
  multi-user drawing all work.

  **Known operational caveat — the Render free plan sleeps after ~15 minutes idle, with
  roughly a minute of cold start.** For a demo link this means the first visit after a quiet
  period is slow, and it lands on the realtime gateway too: a sleeping socket service drops
  live connections and clears in-process room presence on wake. This was flagged in
  `render.yaml` before deploying and is accepted for now; upgrading the realtime service is
  the fix if it becomes annoying.

  **Code prep that preceded the deploy** (full gate green afterwards):
  - **Pooled/direct database split.** `directUrl = env("DIRECT_URL")` added to the datasource
    in `schema.prisma`, and `DIRECT_URL` added to the `packages/config` schema as
    **optional** so the local Docker Postgres — which has no pooler — still boots without it.
    Note the asymmetry found while doing this: it is optional for the *app*, but the Prisma
    *CLI* refuses to run `migrate deploy` at all when `directUrl` is in the schema and the
    variable is unset. So `DIRECT_URL` is now set anywhere migrations run — the three local
    `.env` files, `ci.yml`, and the compose `migrate` service.
  - **`WEB_ORIGIN` accepts a comma-separated list.** Parsed into an array in
    `packages/config`; **matching is still `===` per entry.** This is the WebSocket upgrade
    allowlist and the only thing preventing a cross-site hijack now that the credential is
    client-supplied, so it was deliberately not relaxed to prefix or wildcard matching.
    `isAllowedOrigin(origin, allowed = env.WEB_ORIGIN)` takes the list as an injectable
    argument for testing. A single value with no comma is unchanged (it parses to a
    one-element array). **7 new tests** in `apps/realtime` cover the multi-entry case,
    including that a non-matching origin in a multi-entry list is still refused and that the
    check has not degraded to prefix/suffix/substring matching. Realtime suite 89 → 96 tests.
  - **`render.yaml`** at the repo root: two Docker web services (`sketchsync-api`,
    `sketchsync-realtime`), both building from their Dockerfiles with the repo root as
    context, `healthCheckPath: /health`, env vars declared with `sync: false` (declared, not
    populated). `web` is not here — it goes to Vercel.

  Gate after these changes: typecheck, lint, build, unit tests all green;
  **e2e 27 passed in 3.5 minutes** against the local containerized Postgres.

- **Phase 3 — in progress. Step 1 of 4 done: database and backend.** No client changes and
  no socket eviction yet; those are later steps.

  **Schema + migration `20260907120000_room_visibility_and_invites`:**
  - `RoomVisibility` enum (`PRIVATE` | `LINK`), `Room.visibility` defaulting to **PRIVATE**.
  - `Invite` model — id, roomId, tokenHash, role, createdBy, expiresAt, maxUses, usedCount,
    revokedAt, createdAt; unique index on `tokenHash`, indexes on `roomId` and `expiresAt`;
    room FK cascades, creator FK restricts.
  - **BACKFILL: every existing room is set to `PRIVATE`, and that is safe ONLY because the
    database was empty.** Production was wiped before Phase 3 started, so there were zero
    `Room` rows and no share link could break. Against a populated database the correct
    backfill would have been the opposite — `LINK`, preserving access people were already
    relying on, since a migration should not silently change the meaning of existing data.
    With no rows to preserve, that reasoning has no subject, and backfilling to `LINK` would
    have shipped a "private boards" migration whose every row said public. The reasoning is
    recorded in the migration itself so the line is not copied into a later migration by
    pattern-matching.
  - Verified on a clean apply, not just in the file: the local database was dropped
    (`down -v`) and all 7 migrations re-applied from empty. Column default reads
    `'PRIVATE'::"RoomVisibility"`, and a freshly inserted room comes out `PRIVATE`.
    Note `prisma migrate deploy` does **not** checksum already-applied migrations — editing
    an applied migration reports "No pending migrations" and silently leaves the old SQL in
    place, so a reset was the only way to actually exercise the change.

  **Invite tokens** (`apps/api/src/rooms/invites.ts`) reuse the `auth/ticket.ts` pattern:
  32 random bytes, only the SHA-256 stored, raw token returned once. Redemption is a single
  atomic `UPDATE ... WHERE revokedAt IS NULL AND expiresAt > NOW() AND usedCount < maxUses
  RETURNING`, so a use is claimed and checked in one statement. One deliberate divergence
  from tickets: an invite is consumed by INCREMENT, not DELETE, because it carries a use
  budget and an audit trail.

  **Routes:** `POST/GET /rooms/:slug/invites` and `DELETE /rooms/:slug/invites/:id` (OWNER),
  `POST /invites/:token/accept` (any signed-in user, mounted at the top level since the
  caller is not yet a member), `GET /rooms/:slug/members` (any member),
  `PATCH`/`DELETE /rooms/:slug/members/:userId` (OWNER), `PATCH /rooms/:slug` extended to
  take `visibility`, and **`POST /rooms/:slug/join` now 403s unless visibility is LINK**.
  The 403 body carries `visibility` so the client can later tell "join this board?" from
  "you don't have access" — that is what step 3c needs.

  **An owner cannot remove or demote themselves.** Extracted as a pure function
  (`rooms/ownerGuard.ts`) because it guards two routes and is the kind of rule that gets
  dropped in a rewrite. It refuses two targets: yourself, and the room's `ownerId` — the
  second because OWNER is a rank and a second OWNER-ranked member could otherwise strand
  the board. Invites and role changes are also capped at EDITOR/VIEWER, so OWNER is not
  mintable at all.

  **Tests: 150 → 181.** `ownerGuard.test.ts` (17, pure) covers the authorization rules and
  the shared Zod bounds, including a drift guard pinning the hand-written `MemberRole` /
  `RoomVisibility` enums against Prisma's. `invites.test.ts` (14) covers redemption.
  - **`pnpm test` now requires a database** for the first time. Atomicity is a property of
    a SQL statement, and a mock would only prove the mock agrees with the implementation.
    Run `docker compose -f docker-compose.dev.yml up -d` first; CI already provisions
    Postgres and migrates before the unit-test step. The suite **fails rather than skips**
    when `DATABASE_URL` is absent.
  - The atomicity test was checked for teeth against a deliberately naive
    read-check-update implementation: **naive → 2 winners, `usedCount` 2** on a single-use
    invite; **atomic → 1 and 1**.

  **Gate: FULLY GREEN.** typecheck, lint, build, 181 unit tests, **e2e 27/27 in 1.6 min.**

  The 6 e2e failures this step first produced were all one root cause — `joinRoom()` getting
  a 403 now that rooms default to PRIVATE — and were repaired as a **fixture** change, not a
  product change:
  - `createRoom(user, name, { visibility })` gained an explicit option, **defaulting to
    PRIVATE** so the fixture keeps matching production. `"LINK"` is reached over the real
    owner-only `PATCH /rooms/:slug`, not by writing the column, so the fixture opens a board
    the same way a user would.
  - Five rooms opt into LINK — the open-gap timing tests, drawing propagation, the two
    resilience boards, and the deferrals board. **None of those is testing access**; they
    need a second user present and should not care how they got there.
    **Six of eleven `createRoom` calls stay PRIVATE**, including all of `07-states`,
    `02-transport` and `05-export`. Audited: the LINK opt-ins exactly match the `joinRoom`
    calls, file by file.
  - `joinRoom()` now says so in its 403 message ("is the room LINK?"), because the next
    person to hit this will otherwise read it as an auth failure.
  - The stale comment in `07-states.spec.ts` is corrected: an HTTP route **can** grant VIEWER
    now. `addMember()` stays as the mechanism there — that file asserts what a VIEWER *sees*,
    so minting and redeeming an invite would be two round trips no assertion depends on.

  **Coverage gap, deliberate and not yet closed:** nothing in the e2e suite exercises private
  boards or invites end to end — no spec redeems an invite, hits a PRIVATE board as a
  stranger, or checks the 403 body carries `visibility`. The backend has unit coverage (31
  tests) but the browser path does not. That belongs with the client work, since the screens
  it would drive do not exist yet.

  **Step 2 of 4 done: instant eviction.** Backend only, no client changes.

  Removing or demoting a member used to change the database and nothing else —
  `conn.role` is snapshotted at `join`, so the user kept drawing, and every stroke
  persisted, until they happened to reconnect. `POST /internal/evict` on the realtime
  gateway closes that window.

  - **THIS BREAKS THE "api AND realtime NEVER TALK" PROPERTY.** That was a genuinely good
    property — either service could restart or scale without the other noticing, and their
    only synchronisation point was a Postgres row. It is given up for one reason: only the
    process holding the sockets can act on them. The trade-off is documented at the top of
    `packages/shared/src/internal.ts` and `apps/api/src/rooms/evict.ts`, i.e. at both ends of
    the call, where someone changing either side will see it.
  - **IT IS NOT THE SECURITY BOUNDARY, and the code says so in both files.** `handleJoin`
    still re-reads membership from the database on every join, so a removed user cannot
    reconnect. Eviction only shortens the gap between "removed in the database" and "their
    live socket notices". It **fails open by design** — if it never fires, the system is
    exactly as correct as before, just slower to react.
  - **Best-effort, structurally:** 2 s timeout, nothing branches on the result, every failure
    (timeout, refused connection, 403 secret mismatch, 500, sleeping free-tier service) is
    logged and swallowed. A removal that succeeded in the database must never report failure
    because a notification did not land.
  - **Removed** → sockets for that user *in that room* close with code **4403** ("removed
    from board"). Per-room on purpose: losing one board must not disconnect the user's other
    boards. **Demoted** → `conn.role` is rewritten in place, so the next mutation is refused
    by the same `canWrite` check that has always guarded writes — no second enforcement path.
  - **The demotion notice reuses the existing `error` frame rather than adding a message
    type.** "No new WS message types" is doing real work here: the client validates inbound
    frames against the `ServerMessage` union and *silently drops* unknown ones, so a new type
    would be invisible until the client shipped support for it. `error` already surfaces as a
    toast. A richer signal (live read-only toolbar) is client work.
  - **Config:** `INTERNAL_SECRET` (shared, both services) and `REALTIME_INTERNAL_URL` (api
    only — a second variable was unavoidable; the API has to know where to send the call).
    Optional locally, **required in production** via a `superRefine` on NODE_ENV. Added to
    `packages/config`, `render.yaml` (`sync: false` on both services), `docker-compose.yml`,
    both `.env.example` files, `turbo.json` (dev/test/test:e2e) and `ci.yml`.
  - **Fails closed with no secret configured:** the endpoint refuses everything rather than
    falling open, and the API skips calling. Every refusal is the same bare
    `403 {"message":"Forbidden"}` — no signal about whether the room or user exists.

  **Tests 181 → 205** (realtime 96 → 114, api 37 → 43): bad/missing/array/prefix secret all
  refused and the no-secret case fails closed; a removed user's sockets in that room close
  while their sockets in other rooms and other users' sockets are untouched; a demotion
  rewrites the role without closing and emits the `error` frame; an unreachable gateway
  resolves `false` instead of throwing.

  Also verified against the **running service**, since the unit tests exercise the pure
  functions and not the HTTP glue where a header-name mistake would hide: no header → 403,
  wrong secret → 403, correct secret → `{"closed":0,"updated":0}`, malformed body → 400,
  `GET` → 404.

  **Gate: green.** typecheck, lint, build, 205 unit tests, e2e 27/27 in 3.2 min.
  (`db:typecheck` hit the documented Windows `EPERM … query_engine` first — a dev server I
  had started was still holding the DLL. Stopping stray node processes cleared it.)

  **Still to do:** 3b client (403 screen, `/invite/[token]` route, owner panel), 3c wiring,
  and e2e coverage for the access paths themselves — including eviction, which currently has
  no browser-level test.

- **Phase 5 — in progress.** `README.md` written at the repo root: description, live link,
  stack + CI badge, the architecture diagram reused from `ARCHITECTURE.md`, a three-part
  "Interesting problems" section (the cross-origin WebSocket ticket handshake, the z-order
  race, the size-weighted rate limiter), `docker compose up` quick start, tests, and an
  honest known-limitations list. Every figure in it is taken from `ARCHITECTURE.md` or from
  this section — nothing invented. **No screenshots or GIFs, by decision.**
  - **`<LIVE_URL>` is still a placeholder** and must be filled in before the README is
    useful to anyone.
  - **The CI badge points at a private repo, so it will not render for a logged-out
    viewer.** It resolves once the repo is public — which is gated on Phase 3, below.
  - **Test count corrected to 150.** `ARCHITECTURE.md` and `CLAUDE.md` still say 143; that
    predates the 7 origin-allowlist tests added during Phase 4 prep (realtime 89 → 96).
    Verified by counting the suites directly. Those two documents should be updated.
  - Still to do: demo and resume material.

### Why Phase 4 was done before Phase 3

**Deliberate reordering, not an oversight.** Phase 4 is configuration and deployment and
barely touches application logic. Phase 3 rewrites the authorization model, and is deferred
until the codebase has been studied properly rather than rushed alongside a deploy.

**The consequence, accepted knowingly — and now live, not hypothetical:** until Phase 3
lands, boards are link-access. `POST /rooms/:slug/join` always grants EDITOR and every 403
renders as "Join this board?", so **anyone who has a board URL can edit that board**. There
is now a real deployed URL for which that is true.

Therefore **the repo stays private and the deployed URL is shared selectively** until Phase 3
is done. Do not publicise the deployed link — in a README, on a resume, or anywhere public —
before then. That is the first thing Phase 5 will want to do, so Phase 3 gates Phase 5 in
practice even though nothing in the code enforces the order.

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
