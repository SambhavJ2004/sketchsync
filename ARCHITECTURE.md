# SketchSync — Architecture

Real-time collaborative infinite whiteboard. Several people draw on one shared,
pannable/zoomable canvas and see each other's shapes, edits and cursors live.

This document describes **what is actually in the tree**, not what is planned. Where the
code and the surrounding docs disagree, the code wins and the disagreement is called out
in [Known gaps](#11-known-gaps--todo--hacky-bits).

Two things to know before reading further:

- **There is no Docker, no CI, and no deployment configuration anywhere in this repo.**
  See [§10](#10-docker--deployment). That section exists to say so precisely.
- **The working tree is not a git repository** (no `.git`), so the `.gitignore` is
  currently aspirational and three real `.env` files sit in the tree unprotected.

---

## 1. System shape

Three long-running processes plus a hosted Postgres:

```
                 browser
                    │
        ┌───────────┴────────────┐
        │  http (same origin)    │  websocket (cross origin, allowlisted)
        ▼                        ▼
 ┌──────────────┐         ┌──────────────────┐
 │  web :3000   │         │  realtime :3002  │
 │  Next.js 15  │         │  node + ws       │
 └──────┬───────┘         └────────┬─────────┘
        │ /api/:path* rewrite      │
        │ (server-side proxy)      │
        ▼                          │
 ┌──────────────┐                  │
 │  api :3001   │                  │
 │  Express 5   │                  │
 └──────┬───────┘                  │
        │                          │
        └──────────┬───────────────┘
                   ▼
          Postgres (Neon, ap-southeast-1)
          via Prisma — one schema, shared
```

The split that matters: **the browser never addresses the API's origin directly.** All
HTTP goes to `/api/*` on the web origin and Next proxies it server-side. The WebSocket
*cannot* be proxied that way, so it connects cross-origin and therefore cannot use the
session cookie — hence the ticket handshake in [§4](#4-auth-flow-end-to-end).

`api` and `realtime` never talk to each other directly. They share a database and a
`JWT_SECRET`; their only synchronisation point is a Postgres row (the `WsTicket` table).

---

## 2. Monorepo layout

pnpm workspaces (`apps/*`, `packages/*`) + Turborepo. Package scope `@sketchsync/*`.

### Apps

| Path | Package | What it is |
| --- | --- | --- |
| `apps/web` | `@sketchsync/web` | Next.js 15 App Router + React 19 + Tailwind v4 + Zustand. The canvas engine, the realtime client, and all UI. Port **3000**. |
| `apps/api` | `@sketchsync/api` | Express 5 HTTP service: auth, rooms, WS ticket issuance. Port **3001**. |
| `apps/realtime` | `@sketchsync/realtime` | Node + `ws` WebSocket gateway: upgrade auth, room registry, sync, presence, rate limiting, z-order arbitration. Port **3002**. |
| `apps/e2e` | `@sketchsync/e2e` | Playwright browser suite. Seeds via the API and direct SQL, never through the UI. Run separately from `pnpm test`. |

### Packages

| Path | Package | What it is | Who imports it |
| --- | --- | --- | --- |
| `packages/shared` | `@sketchsync/shared` | Zod schemas + inferred types: `SignupInput`/`SigninInput`, `RoomName`, `ElementData` (discriminated union), `Element`, `ElementInput`, `ClientMessage`/`ServerMessage`, `WS_TICKET_PROTOCOL`, content caps. **Browser-safe.** | web, api, realtime, e2e |
| `packages/db` | `@sketchsync/db` | Prisma schema + migrations, the `PrismaClient` singleton, and the authz helpers (`getMembership`, `roleAtLeast`, `ROLE_RANK`). Re-exports all generated Prisma types. | api, realtime, e2e |
| `packages/auth` | `@sketchsync/auth` | **Server-only** token primitives: `AUTH_COOKIE`, `signToken`, `verifyToken`, `TokenPayload`, `TOKEN_TTL_SECONDS`, `WS_TICKET_TTL_SECONDS`. | api, realtime |
| `packages/config` | `@sketchsync/config` | `loadEnv()` — one Zod schema validating `DATABASE_URL`, `JWT_SECRET`, `API_PORT`, `REALTIME_PORT`, `NODE_ENV`, `WEB_ORIGIN`. Fails fast at boot, memoized. | api, realtime |
| `packages/typescript-config` | — | Shared `tsconfig` bases (`base`, `node`, `nextjs`). | all |
| `packages/eslint-config` | — | Shared ESLint 9 flat configs (`base`, `next`). | all |

Three boundaries are load-bearing and are stated in the code itself:

- **`auth` must never reach the browser bundle** — it depends on `jsonwebtoken`. That is
  why `WS_TICKET_PROTOCOL`, which the browser genuinely needs, lives in `shared` instead
  ([`packages/shared/src/ws.ts`](packages/shared/src/ws.ts)).
- **`auth` must not depend on Prisma**, or token verification would drag in the DB layer.
  `verifyToken(token, secret)` takes a raw string and is transport-agnostic on purpose:
  cookie today, `Sec-WebSocket-Protocol` ticket tomorrow, same call.
- **`web` cannot import `@sketchsync/db`** (Prisma, server-only). It therefore re-states
  the OWNER/EDITOR rank comparison inline in
  [`CanvasStage.tsx:121`](apps/web/app/canvas/CanvasStage.tsx:121) — deliberate
  duplication, flagged at both sites.

### Build model

Internal packages are consumed **just-in-time**: they export TS source
(`"exports": { ".": "./src/index.ts" }`) with no build step. Consumers compile them.

- `api` / `realtime`: **tsup** → `dist/index.js` (ESM, node22). Workspace packages are
  bundled (`noExternal: [/^@sketchsync\//]`); `@prisma/client` is kept **external**
  because of its native query engine and dynamic requires. Dev runs `tsx watch src/index.ts`.
- `web`: `transpilePackages: ["@sketchsync/shared"]` plus a webpack `extensionAlias`
  mapping `.js` → `.ts`, because `shared` uses NodeNext-style `.js` import extensions that
  the api/realtime NodeNext builds require.

---

## 3. Entry points

### Web

| Concern | File |
| --- | --- |
| Root layout, provider tree | [`apps/web/app/layout.tsx`](apps/web/app/layout.tsx) — `<AuthProvider>` wrapping `<ToastProvider>` |
| Landing (redirects signed-in users to `/rooms`) | [`apps/web/app/page.tsx`](apps/web/app/page.tsx) |
| Auth pages | [`app/signin/page.tsx`](apps/web/app/signin/page.tsx), [`app/signup/page.tsx`](apps/web/app/signup/page.tsx) |
| Board list | [`apps/web/app/rooms/page.tsx`](apps/web/app/rooms/page.tsx) |
| **The board** | `apps/web/app/room/[slug]/page.tsx` → `<Protected>` → `<Board>` → `<CanvasStage>` |
| Canvas host + all socket wiring | [`apps/web/app/canvas/CanvasStage.tsx`](apps/web/app/canvas/CanvasStage.tsx) (667 lines — the integration point) |
| `/canvas` | [`apps/web/app/canvas/page.tsx`](apps/web/app/canvas/page.tsx) — **server redirect to `/rooms`**. The old dev entry is gone. |
| HTTP client | [`apps/web/lib/api/client.ts`](apps/web/lib/api/client.ts) — base is the relative `"/api"` |
| Proxy config | [`apps/web/next.config.ts:28`](apps/web/next.config.ts:28) — `/api/:path*` → `${API_ORIGIN}/:path*` |

The board route is the real entry: it fetches `GET /rooms/:slug` first and only mounts
`CanvasStage` (and therefore the socket) once membership is confirmed. A 403 renders a
"Join this board?" screen; 404 renders "Board not found".

Canvas engine modules live under `apps/web/lib/canvas/` and are deliberately separate and
mostly pure: `viewport`, `renderer`, `input`, `keyboard`, `store` (Zustand),
`drawSession`, `editSession`, `shapes`, `geometry`, `hitTest`, `selectionChrome`,
`layers`, `history`, `textMeasure`, `exportPng`, `exportSvg`, `testHook`.
`apps/web/lib/realtime/` holds `socket.ts` (the `RealtimeClient`) and `userColor.ts`.

### API server

[`apps/api/src/index.ts`](apps/api/src/index.ts) — `express()`, `cors`, `express.json()`,
`cookieParser()`, `GET /health`, the `/auth` router, the `/rooms` router, and a central
error handler that logs only `err.message` (never request bodies), then
`app.listen(env.API_PORT)`.

CORS is explicitly **defence-in-depth, not load-bearing**: normal browser traffic arrives
through the web app's server-side proxy and carries no browser-policed `Origin`. It is
kept because it still constrains anything hitting port 3001 directly.

### WebSocket server

[`apps/realtime/src/index.ts`](apps/realtime/src/index.ts) is the entry:

1. A plain `node:http` server serving exactly one route: `GET /health` → `{ ok, connections }`.
2. `new WebSocketServer({ noServer: true, maxPayload: 1 MiB, handleProtocols: () => WS_TICKET_PROTOCOL })`.
   `noServer` is required because **auth must complete during the upgrade**.
3. `httpServer.on("upgrade")` ([index.ts:60](apps/realtime/src/index.ts:60)) calls
   `authenticateUpgrade(req)` and either refuses with a hand-written HTTP response
   (`refuseUpgrade`) or hands off to `wss.handleUpgrade`, emitting `connection` with the
   resolved `userId`.
4. `wss.on("connection")` ([index.ts:97](apps/realtime/src/index.ts:97)) builds a `Conn` —
   `{ ws, userId, name, avatarUrl, roomId, role, rate, parseErrorSent }` — adds it to a
   module-level `Set`, and routes every frame to `handleMessage`. `close` and `error` both
   run the same `release()`, which drops the limiter state and broadcasts presence.

By the time a `connection` exists it is already authenticated; there is no post-handshake
auth check anywhere.

Supporting modules: `auth.ts` (upgrade auth), `registry.ts` (`RoomRegistry`),
`messages.ts` (all handlers + the limiter pipeline), `rateLimit.ts`, `zorder.ts`,
`syncChunks.ts`.

---

## 4. Auth flow end-to-end

### 4.1 Signup / signin → session cookie

`POST /api/auth/signup` → proxied to `POST /auth/signup`
([`routes.ts:17`](apps/api/src/auth/routes.ts:17)):

1. `SignupInput` (Zod: email, password ≥ 8, name ≥ 1). Failure → 400 with per-field issues.
2. Email lowercased and trimmed. **Password hashed with bcrypt cost 12 *before* the
   insert**, so the duplicate-email path costs about what the success path costs.
3. `prismaClient.user.create`. Prisma `P2002` (unique email) → **409**.
4. `signToken({ userId }, JWT_SECRET)` — JWT, 7-day expiry.
5. `setAuthCookie` → **`sketchsync_token`**, `httpOnly`, `sameSite: "lax"`, `path: "/"`,
   `secure` only when `NODE_ENV === "production"`, `maxAge` 7 days.
6. 201 with the `SafeUser` (`id`, `email`, `name`, `avatarUrl` — never `passwordHash`).

`POST /auth/signin` ([`routes.ts:51`](apps/api/src/auth/routes.ts:51)) is the same tail,
with one deliberate detail: it **always runs a bcrypt compare**, against `DUMMY_HASH` when
the user does not exist, and returns the identical `401 "Invalid email or password"` for
both "no such user" and "wrong password".

`POST /auth/signout` clears the cookie. `GET /auth/me` re-reads the user and clears a stale
cookie if the token is valid but the user is gone.

**Why the cookie works at all:** it is set on the *web* origin, because the browser only
ever talks to `/api` on its own origin. This is not a convenience. Measured previously with
web on `localhost:3000` and the API on `127.0.0.1:3001`: signup returned 201 with a correct
`Set-Cookie` and correct CORS headers, and the very next request 401'd — a top-level
navigation straight to the API origin was also 401, proving the browser had never *stored*
the cookie. CORS was never the problem. Dev uses the same proxy path on purpose, because a
dev-only direct connection is exactly what hid that bug until production.

Client side: `AuthProvider` fetches `GET /auth/me` once and shares it app-wide.
**Only a 401 clears the user** ([`AuthProvider.tsx:53`](apps/web/lib/auth/AuthProvider.tsx:53));
any other failure sets `error` and leaves the session intact, so an unreachable API does not
look like an ordinary sign-out.

### 4.2 Session cookie → WebSocket ticket

The socket cannot use the cookie: it must reach `realtime` directly and cross-origin, and a
Next rewrite cannot proxy a WebSocket. **There is deliberately no cookie fallback** — one
that works in dev and fails in prod is the exact failure class this design removes.

`POST /api/auth/ws-ticket` ([`routes.ts:112`](apps/api/src/auth/routes.ts:112)), reached
same-origin so the ordinary session cookie authenticates it via `requireAuth`:

1. Per-**user** token bucket (`allowTicket`): capacity 10, refill 0.5/s, idle buckets
   evicted after 10 minutes → **429** when exceeded. A ticket endpoint that can be hammered
   is a token-minting oracle.
2. `issueTicket(userId)` ([`ticket.ts`](apps/api/src/auth/ticket.ts)): 32 random bytes,
   base64url. **Only the SHA-256 hash is stored** in `WsTicket`; the raw value is returned
   once and never persisted. TTL **15 seconds**.
3. Opportunistically deletes that user's expired ticket rows, best-effort.
4. 201 `{ ticket, expiresAt, ttlSeconds }`.

An opaque value rather than a JWT, on purpose: single-use has to be enforced across two
processes whose only shared state is the database, so a redemption round trip is unavoidable
either way — and once that is true, a JWT would still need a `jti` row to mark it consumed
(the same write) plus a second token format to keep in sync. With an opaque value, **the row
*is* the ticket**.

TTL is seconds because the client fetches a ticket immediately before connecting, so the
only gap is one round trip plus the handshake. A longer TTL buys nothing — every reconnect
mints a fresh one — and only widens the window a leaked ticket is usable in.

The ticket payload is `userId` **only — no room scope**. It means "you are this user", never
"you may enter this board".

### 4.3 Ticket → upgrade handshake

The client ([`socket.ts:94`](apps/web/lib/realtime/socket.ts:94)) fetches a **fresh ticket
before every connect attempt**, then:

```js
new WebSocket(url, [WS_TICKET_PROTOCOL, ticket])
```

The credential rides in `Sec-WebSocket-Protocol` — **never a query parameter**, which would
land in access logs, proxy logs and browser history. Base64url values are valid RFC 6455
protocol tokens, which is what makes this legal.

Server, `authenticateUpgrade` ([`auth.ts:80`](apps/realtime/src/auth.ts:80)):

1. **Origin allowlist.** A present `Origin` must equal `WEB_ORIGIN` exactly; an absent one
   is allowed (non-browser tooling, which could spoof any value anyway). Browsers always
   send it, so the browser surface is fully covered. Mismatch → **HTTP 403**.
   *This check must not be removed.* Before tickets, `SameSite=Lax` was implicitly
   preventing cross-site socket auth — a hostile page could open a socket but the browser
   withheld the cookie. Now the credential is client-supplied, so this check is the only
   thing standing between a malicious page and a cross-site WebSocket hijack.
2. `extractTicket` parses the header, requiring exactly `[marker, ticket]` in that order.
3. `redeemTicket` — one atomic statement:
   ```sql
   DELETE FROM "WsTicket" WHERE "tokenHash" = $1 AND "expiresAt" > NOW() RETURNING "userId"
   ```
   Two racing upgrades both issue the delete; only one gets a row. Check-then-delete would
   leave both valid. **Expiry is evaluated by the database clock**, so a skewed gateway
   cannot extend a ticket. Missing / expired / already-redeemed → **HTTP 401**.
4. The server echoes back **only the marker**, never the ticket.

Refusal is a real HTTP status *during* the handshake, not `101` followed by `close(1008)` —
the older shape could not express "get a new ticket" versus "you are signed out".

The browser cannot read a failed handshake's status, so the client distinguishes the two
401s at *issuance*, which is an ordinary fetch:

- **401 from `/auth/ws-ticket`** → the session is gone. Terminal: stop retrying, fire
  `onSignedOut`, redirect to `/signin?next=…`.
- **Issuance OK but the handshake failed** → ticket/transport. Retry after ~150 ms with a
  fresh ticket (twice), then fall back to 0.5 s → 8 s exponential backoff.

Measured cost of the ticket hop: open-board → socket-open is **283 ms median** (a 134 ms
ticket fetch on top of a 103 ms handshake, ~+180 ms versus the pre-ticket shape). That
widening is what made the connect-window queue worth building rather than tolerating.

### 4.4 Socket → room access check

Authentication is not authorization. A connected socket has a `userId` and nothing else.

On `join {roomId}` ([`messages.ts:119`](apps/realtime/src/messages.ts:119)):

1. `getMembership(userId, roomId)` — the shared helper from `@sketchsync/db`, the same one
   the API's `requireMembership` uses. No row → `error "You are not a member of this room"`,
   and the socket stays in no room.
2. Name/avatar fetched once for presence; `registry.join(roomId, conn)`; `conn.role = role`.
3. Chunked `sync` to the joiner, then a `presence` broadcast to the room.

Writes are then gated by `canWrite` ([`messages.ts:99`](apps/realtime/src/messages.ts:99)) —
`conn.roomId !== null && roleAtLeast(conn.role, EDITOR)` — on **every** create, update and
delete. `ROLE_RANK` is `OWNER 3 > EDITOR 2 > VIEWER 1`.

**Membership is created over HTTP, never by the socket.** `POST /rooms/:slug/join` upserts a
`RoomMember` as EDITOR (idempotent). The gateway only ever *checks*.

The client's `canEdit` flag is **UX, not security** — it exists so a VIEWER does not draw a
shape that renders locally, gets refused, and vanishes on reload. That is stated at the
declaration in [`store.ts:68`](apps/web/lib/canvas/store.ts:68) so it is not later removed
as redundant. The gateway remains the authority: the flag comes from a fetch the user
controls, and a hand-crafted socket frame never passes through the store.

### 4.5 HTTP room authorization

`requireAuth` verifies the cookie JWT and sets `req.userId`.
`requireMembership(minRole = VIEWER)` resolves `:slug` → room (404 if absent), checks
membership and rank (403), and attaches `req.room` / `req.roomRole`.

| Route | Auth | Notes |
| --- | --- | --- |
| `POST /rooms` | `requireAuth` | Creates the room **and** its OWNER membership in one transaction. Slug = `slugify(name)` + 4-char random suffix, retried up to 5× on `P2002`. |
| `GET /rooms` | `requireAuth` | Rooms the caller is a member of, with their role, newest first. |
| `GET /rooms/:slug` | `requireMembership()` | Metadata + caller role + `memberCount`. |
| `POST /rooms/:slug/join` | `requireAuth` | Open share-link join. **Always grants EDITOR**; idempotent upsert, so existing members keep their role. |
| `PATCH /rooms/:slug` | `requireMembership(OWNER)` | Rename. `RoomName` (trim, 1–80) is shared with create so client and server cannot drift. |

---

## 5. WebSocket message protocol

Both directions are Zod discriminated unions on `type`, defined once in
[`packages/shared/src/ws.ts`](packages/shared/src/ws.ts). Every inbound frame is validated
against `ClientMessage`; a bad frame produces an `error`, never a crash. The client
validates inbound frames against `ServerMessage` and silently drops anything that fails.

**Standing rule: no new message types are ever added.** New element state (zIndex is the
precedent) rides on `elementUpdate`.

### 5.1 Client → server (`ClientMessage`)

| `type` | Payload | Sent when | Server handler |
| --- | --- | --- | --- |
| `join` | `{ roomId: uuid }` | On every socket open **and** every reconnect, from `ws.onopen` ([socket.ts:127](apps/web/lib/realtime/socket.ts:127)) | `handleJoin` — membership check → chunked `sync` → `presence` broadcast |
| `leave` | `{ roomId: uuid }` | **Never sent by the web client.** There is no `emitLeave`, and `send()` explicitly drops it when the socket is closed. Handled server-side for protocol completeness. | `handleLeave`, and only if `conn.roomId === msg.roomId` |
| `elementCreate` | `{ element: ElementInput }`, where `ElementInput = { id: uuid, data: ElementData, version: int > 0 }` | Local commit of a new shape. The client generates the `id` so it can render optimistically. | `handleCreate` — **the server assigns `version = 1` and `zIndex = roomMax + 1` authoritatively**; `ElementInput` deliberately has no `zIndex` field and the sent `version` is advisory |
| `elementUpdate` | `{ id: uuid, data: ElementData (full replacement, not a patch), zIndex: number, version: int > 0 }` | Move, resize, restyle, layer nudge, and undo/redo of any of those | `handleUpdate` — LWW gate, then either the fast unlocked path or the locked z-placement path |
| `elementDelete` | `{ id: uuid, version: int > 0 }` | Delete key / multi-select delete | `handleDelete` — LWW gate, then soft delete |
| `cursor` | `{ x: number, y: number }` — **world** coordinates | Pointer move while in a room, throttled to **50 ms** (~20/s) | `handleCursor` — relayed, never persisted |

### 5.2 Server → client (`ServerMessage`)

| `type` | Payload | Sent when | Recipients |
| --- | --- | --- | --- |
| `sync` | `{ elements: Element[], seq: int ≥ 0, done: boolean }` | Immediately after a successful `join` | The joining socket only |
| `elementCreated` | `{ element: Element }` | After a create commits | Everyone in the room **except the sender** |
| `elementUpdated` | `{ element: Element }` | After an update commits; also **N of these** after a z-renormalization | Everyone except the sender — **except renormalization broadcasts, which go to everyone**, because the initiator's optimistic zIndex is stale too |
| `elementDeleted` | `{ id: uuid }` | After a soft delete | Everyone except the sender |
| `presence` | `{ users: PresenceUser[] }`, `PresenceUser = { userId, name, avatarUrl? }` | On join, and on leave/disconnect | Everyone in the room **including** the joiner. **Deduped by `userId`** — multi-tab safe: a user drops only when their last socket closes |
| `cursor` | `{ userId: uuid, x, y }` | On relay | Everyone except the sender |
| `error` | `{ message: string }` | Validation, authz, or handler failure | The offending socket only |

`Element` is the full server-authoritative row:
`{ id, roomId, data: ElementData, version, createdBy, zIndex, createdAt, updatedAt, deleted }`.

`ElementData` is a discriminated union on its own `type`: `rect` / `ellipse`
(`x, y, width, height`), `line` / `arrow` (`x1, y1, x2, y2`), `pencil` (`points[]`, 2–10 000),
`text` (`x, y, text ≤ 5 000, fontSize`). Every variant carries
`style: { stroke ≤ 64 chars, width ≥ 0, fill? ≤ 64 chars }`. **All geometry is in world
coordinates** — selection chrome, handles and cursors are drawn in screen space, but nothing
screen-space ever crosses the wire.

The broadcast excludes the sender because the sender already rendered optimistically.

### 5.3 Error strings and close codes

Every `error` message the gateway can emit:

`"Invalid JSON"` (at most **once per socket**) · `"Invalid message"` (Zod) ·
`"You are not a member of this room"` · `"Join a room first"` ·
`"You do not have permission to edit"` · `"Could not create element"` ·
`"Element not found"` · `"Internal error"`.

| Signal | Meaning |
| --- | --- |
| HTTP **403** at upgrade | Origin not allowlisted |
| HTTP **401** at upgrade | Missing / expired / already-redeemed ticket |
| HTTP **500** at upgrade | Unexpected failure in the upgrade handler |
| Close **1009** | Frame exceeded `maxPayload` (1 MiB). `ws` rejects it during protocol decode, before any handler runs |
| Close **1008** | `"policy violation"` — the decaying violation score exceeded 500 |

### 5.4 Inbound pipeline and rate limiting

Every frame runs [`handleMessage`](apps/realtime/src/messages.ts:427) in this order — the
order is the design:

```
global bucket (unconditional, PRE-parse)
  → JSON.parse  → classify (from the PARSED msg.type, never raw bytes)
  → REFUND global (known type only)
  → class bucket → Zod → authz → handler
```

Per-socket token buckets (pure functions, no timers; refill computed from elapsed time):

| Bucket | Capacity | Refill | Cost |
| --- | ---: | ---: | --- |
| `global` | 400 | 60/s | 1 per frame, **refunded** as soon as the frame yields a known type |
| `cursor` | 40 | 25/s | 1 per frame |
| `mutation` | 300 | 20/s | `max(1, ceil(bytes / 4096))` — **size-weighted** |

Details that are easy to get wrong when editing this:

- **Global's only job is frames that cannot be *classified*** — unparseable bodies and
  unknown/non-string types. Once a frame is classifiable the class bucket owns it, and a
  class rejection already scores a violation (which closes the socket at 500 — a strictly
  stronger bound than global draining at 400 and staying open). Do not move the refund later:
  holding the charge past classification re-couples the buckets, so a cursor burst blocks a
  write the client already rendered.
- **The class is decided from the parsed `msg.type`, never from raw bytes.** Classifying by
  substring was unsound — a frame can put `"cursor"` in a field *value* while its type is
  `elementCreate`. Unknown types fall to the stricter `mutation` bucket.
- **Parse failures score a violation directly**, at full weight, rather than waiting for
  global to drain. The `"Invalid JSON"` reply is sent **at most once per socket**; the rest
  would be attacker-driven outbound work.
- **Mutations are charged by size** because counting frames alone would admit 20 max-legal
  elements per second, and one max-legal element is ~238 KB that takes ~1.8–7 s to persist.
  At 59 tokens each, the bucket admits 5 back-to-back then sustains ~1 per 3 s.
- **Mutation capacity is deliberately ≫ refill**, because legitimate client code emits
  synchronous bursts (multi-select delete, renormalization). Unlike an LWW drop, a
  rate-limit drop loses a write the server never saw.
- Violations **decay at 10/s**, so the score measures intensity, not lifetime total: 500 in
  ten seconds closes the socket; 500 across an eight-hour session never does.
- Cursor and mutation buckets are independent, so cursor traffic never starves edits.
- Server-originated broadcasts bypass the limiter **by construction**: it lives in
  `handleMessage`, reachable only from `ws.on("message")`, while `registry.broadcast` calls
  `ws.send` directly.
- Content caps (`MAX_PENCIL_POINTS` 10 000, `MAX_TEXT_LENGTH` 5 000, `MAX_STYLE_STRING` 64)
  are enforced at **both** ends from the same `@sketchsync/shared` constants. A
  receiver-only cap would let the client render and emit an element the server rejects,
  which then persists locally and vanishes on the next sync.

---

## 6. Canvas state: storage and rehydration

### 6.1 Where state lives

| State | Home | Persisted? |
| --- | --- | --- |
| Committed elements | `Element` rows (`data` Json) | **Yes** |
| Stacking order | `Element.zIndex` (float) | Yes |
| Conflict version | `Element.version` (int) | Yes |
| Deletions | `Element.deleted` (soft) | Yes |
| Room membership / roles | `RoomMember` | Yes |
| Who is connected | `RoomRegistry` — an in-memory `Map<roomId, Set<Conn>>` in the single realtime process | **No** |
| Cursors | Relayed frames + a client-side `Map` | **No** — never in the scene array, never in undo |
| Client scene | Module-scoped Zustand store, `scene: SceneElement[]`, kept sorted by `(zIndex, createdAt)` | **No** — memory only; no localStorage, no IndexedDB |
| Undo history | `history: { past, future }` in the same store; command-based, **local-only and id-scoped** | No |

`SceneElement` is `{ id, version, zIndex, createdAt, data }` — the wire `Element` minus
`roomId` / `createdBy` / `updatedAt` / `deleted`.

### 6.2 Writing state

A local commit does **optimistic scene update → history entry → `outbound` emit**, in that
order, inside the store. The drawing user never waits on the network to see their own
stroke. `CanvasStage` wires the `outbound` sink to
`client.emitCreate` / `emitUpdate` / `emitDelete`.

Server-side authority:

- **`version` starts at 1 and is assigned by the server on create.** After that the *client*
  supplies it: the store increments (`version: e.version + 1`) and the gateway stores what it
  is told. LWW is `incoming.version >= stored.version`; a strictly older write is dropped
  **silently**. (See [gap #10](#protocol-and-consistency).)
- **`zIndex` on create is assigned under a per-room advisory lock.**
  `sketchsync_insert_element` (plpgsql, migration `20260806130000`) takes
  `pg_advisory_xact_lock(hashtext('sketchsync:zindex:' || roomId))`, reads `MAX(zIndex)`,
  and inserts — in that order, which plpgsql guarantees and a SQL planner does not. Two
  cheaper-looking shapes were measured and rejected: an interactive transaction is correct
  but ~5 round trips (**468 ms per create** once serialized), and a single `INSERT … SELECT`
  with the lock in a materialized CTE is fast but **unsound** (138 duplicates in 200
  concurrent creates), because nothing forces the lock CTE to evaluate before the MAX read.
- **`zIndex` on update is advisory too.** Layer actions compute a midpoint client-side from a
  possibly-stale snapshot, so two clients can propose the same value for different elements.
  A zIndex-*changing* update therefore runs the whole placement under the same lock in one
  transaction: `lock → read the board once → LWW re-check → resolveZ (re-place on collision)
  → UPDATE → gap check in memory → renormalize if needed`. On collision the server
  **re-places rather than rejects** — a rejected layer action is a dead keystroke.
- **A content-only edit takes no lock at all**
  ([`messages.ts:274`](apps/realtime/src/messages.ts:274)), so two people dragging different
  shapes never serialize against each other.
- **Renormalization** rewrites collapsed float gaps (`minGap < 1e-6`) in one
  `UPDATE … FROM (VALUES …)` — all-or-nothing, since a partial renumber would reorder the
  board for everyone — and broadcasts **N ordinary `elementUpdated`s, never a re-sync**.
  That distinction is the acceptance criterion: `applyRemoteSync` clears the undo stack and
  `applyRemoteUpdate` does not, so a routine z-nudge must not destroy anyone's history. It is
  pinned by a unit test.

Measured: 200 fully-contended creates finish in 1.9 s (9.7 ms each); in-function lock hold is
1.7 ms for a small rect and 5.9 ms for a max-legal 10 000-point stroke. The lock is never
held across a network round trip.

### 6.3 Rehydration when someone joins

**Server** ([`handleJoin`](apps/realtime/src/messages.ts:119)):

1. Membership check.
2. `element.findMany({ where: { roomId, deleted: false }, orderBy: [zIndex asc, createdAt asc] })`
   — soft-deleted rows are excluded, so the snapshot is the live board.
3. `chunkElements` splits it into ordered batches under a **256 KiB** budget
   ([`syncChunks.ts`](apps/realtime/src/syncChunks.ts)). `maxPayload` governs inbound only,
   and an outbound snapshot is O(room size): 50 realistic elements ≈ 77 KiB, 500 ≈ 818 KiB
   (already 80 % of 1 MiB), 20 max-legal strokes ≈ 4.5 MiB. An element larger than the budget
   is emitted **alone** rather than dropped.
4. One `sync` per chunk, `seq` incrementing from 0, `done: true` on the last. An **empty room
   still gets one frame**: `{ elements: [], seq: 0, done: true }`.
5. `presence` broadcast to the whole room.

**Client** ([`onSyncChunk`](apps/web/lib/realtime/socket.ts:213)):

1. Chunks accumulate in `syncBuffer`. `seq === 0` always **restarts** a sequence (so a
   re-join mid-stream cleanly supersedes a partial one); an out-of-order `seq` discards the
   accumulation entirely rather than commit a board with holes in it.
2. On `done`, commit **once** → `applyRemoteSync(elements, keepIds)`. One scene swap, one
   undo clear, no flicker.
3. `applyRemoteSync` ([`store.ts:346`](apps/web/lib/canvas/store.ts:346)) replaces the scene
   wholesale, resets history to empty, and filters `selectedIds` to surviving ids — except
   for `keepIds`.
4. Immediately after, `flushQueue()` sends any connect-window mutations.

**`keepIds` and the connect-window queue.** The canvas attaches pointer listeners
synchronously, but the socket needs a ticket fetch plus a handshake first (**measured
63–227 ms**). Mutations committed in that window used to be discarded silently: the shape
rendered locally, reached nobody, and vanished on reload. An e2e test found it; nothing else
could have.

- Mutations are queued until the socket opens — **cursors never are** (stale on arrival, and
  a flush would dump a burst of positions nobody wants).
- **Initial connect only**, keyed on `hasEverOpened`. After a disconnect the old
  drop-then-resync behaviour stands, because replaying stale mutations across a re-sync that
  wholesale-replaces the scene and clears history needs version reconciliation. **(pinned)**
- Bounded at **200 ops and 1 MiB** — the server's rate limiter is per-socket and does not
  exist yet during the connect window.
- Overflow drops the **newest**, never the oldest: the queue is order-dependent, and evicting
  an older op could strand an update whose create was discarded. Dropping the tail always
  leaves a valid prefix.
- No drop is silent: `dropped.{overflow,disconnected}` counters, a dev-mode `console.warn`,
  and an `onDropped` handler that raises a toast.

**Flush ordering is load-bearing: flush on `done`, never on open.** `ws.on("message")` runs
`void handleMessage(...)` per frame with no serialization, and `handleJoin` has two awaits
before `registry.join` sets `conn.roomId`. Flushing right after `join` would risk both a
`"Join a room first"` rejection *and* a create committing after the snapshot read — which
`applyRemoteSync`'s wholesale replace would then delete locally and **permanently**, since
the server never echoes a sender its own create.

**On reconnect**, `ws.onopen` re-sends `join`, so the client always re-syncs against server
truth; a partial snapshot in flight when the socket drops is discarded.

**Presence is cleared on any non-open status.** It is a server broadcast, so the last one is
stale the moment the socket dies; leaving the avatars up would assert people are still there.

---

## 7. Prisma models and relations

[`packages/db/prisma/schema.prisma`](packages/db/prisma/schema.prisma). Postgres, uuid
primary keys (`@db.Uuid`), `Role` enum `OWNER | EDITOR | VIEWER`.

```
User ──< RoomMember >── Room
 │  (owns)  ▲             │
 ├──────────┘             │
 ├──< WsTicket            │
 └──< Element (createdBy) ┘
```

### User
`id` uuid pk · `email` **unique** · `passwordHash` · `name` · `avatarUrl?` · `createdAt`

Relations: `ownedRooms Room[] @relation("RoomOwner")`, `memberships RoomMember[]`,
`elements Element[] @relation("ElementCreatedBy")`, `wsTickets WsTicket[]`.

### WsTicket
`tokenHash` **pk** (SHA-256 hex of the ticket) · `userId` · `expiresAt` · `createdAt`

`user` FK → `User`, **`onDelete: Cascade`**. Index on `expiresAt` for the sweep. The raw
ticket value is never stored; the row *is* the credential, and redemption is
`DELETE … RETURNING`.

### Room
`id` uuid pk · `slug` **unique** · `name` · `ownerId` · `createdAt`

`owner` FK → `User` (**no cascade** — the FK blocks deleting a user who owns rooms),
`members RoomMember[]`, `elements Element[]`. Index on `ownerId`.

### RoomMember
`id` uuid pk · `roomId` · `userId` · `role Role`

`@@unique([roomId, userId])` — the composite key used by `getMembership` and by the
idempotent join upsert. `@@index([userId])` serves "my rooms". Both FKs cascade on delete.

### Element
`id` uuid pk · `roomId` · `type String` · `data Json` · `version Int @default(1)` ·
`createdBy` · `zIndex Float @default(0)` · `createdAt` · `updatedAt @updatedAt` ·
`deleted Boolean @default(false)`

- `data` holds the shared `ElementData`; **`type` mirrors `data.type`** as a queryable
  column. Nothing in the database enforces that they agree — the server always writes
  `type: data.type`, so they agree by convention.
- `zIndex` is a **float** so a shape can be inserted *between* two others without renumbering
  the room. Render order is `(zIndex, createdAt)`, with `id` as a final tiebreak in
  `compareZ` for a total order. Since the create race was fixed, zIndex alone is unique per
  room in practice — no clock is load-bearing.
- `@@index([roomId, zIndex, createdAt])` serves both the sync query and the locked z-order
  read (which selects ids + ordering columns only, never the `data` payloads).
- `room` FK cascades; `creator` FK does not.

### Migrations

| Migration | What it does |
| --- | --- |
| `20260715120000_init` | User, Room, RoomMember, Element |
| `20260718120000_element_created_at` | `Element.createdAt` |
| `20260719120000_element_zindex` | `Element.zIndex` + the composite index |
| `20260806120000_repair_duplicate_zindex` | One-off data repair: renumbers each room's live elements to a clean 1..N using exactly the shared `(zIndex, createdAt, id)` order, bumping `version` so connected clients accept it under LWW. Repaired 302 rows across 5 rooms; damaged rooms could not self-heal, because in them "send backward" was a silent no-op. |
| `20260806130000_element_zindex_lock` | `sketchsync_insert_element` plpgsql function — the locked create path |
| `20260807120000_ws_ticket` | `WsTicket` table + `expiresAt` index + cascade FK |

Apply with `migrate deploy` against a **direct** (non-pooled) Neon connection — migrations
take advisory locks and run DDL that a transaction-mode pooler breaks.

---

## 8. Environment and configuration

`loadEnv()` validates `process.env` once, fails fast at boot, and memoizes. Each server calls
`process.loadEnvFile()` first (gitignored `.env`); in production the platform injects real
env and the missing file is ignored.

| Variable | Required | Consumers | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes (no default) | api, realtime, prisma CLI | **Must be identical** for api and realtime |
| `JWT_SECRET` | yes, ≥ 16 chars | api, realtime | **Must be identical** — realtime verifies what the API issues |
| `API_PORT` | yes | api | 3001 |
| `REALTIME_PORT` | yes | realtime | 3002 |
| `NODE_ENV` | default `development` | api, realtime | Drives the cookie `secure` flag |
| `WEB_ORIGIN` | default `http://localhost:3000` | api (CORS), realtime (**upgrade allowlist**) | On realtime this is a security control, not cosmetics |
| `API_ORIGIN` | default `http://localhost:3001` | web, **server-side only** | Target of the `/api/*` rewrite. Deliberately **not** `NEXT_PUBLIC_`, so changing it is a restart, not a rebuild |
| `NEXT_PUBLIC_REALTIME_URL` | default `ws://localhost:3002` | web | **Build-time inlined** — the socket is not proxied, so changing it *is* a rebuild. Use `wss://` in production |
| `NEXT_PUBLIC_E2E` | unset | web | `=1` installs the read-only test hook |
| `E2E_WEB_ORIGIN` | default `http://localhost:3000` | e2e | |

Env files: `apps/api/.env`, `apps/realtime/.env`, `packages/db/.env` (Prisma CLI),
`apps/web/.env.local`. Each has a committed `.env.example`.

Cookies are **host-scoped and ignore ports**, which is why the 3000/3001/3002 split works
locally while a genuine cross-origin split does not.

---

## 9. Build, run, test

From the repo root:

```bash
pnpm dev          # web + api + realtime via Turborepo
pnpm build        # all packages
pnpm lint
pnpm typecheck
pnpm test         # vitest, for every package that defines a test script
pnpm test:e2e     # Playwright, separate on purpose so `pnpm test` stays fast
```

Database:

```bash
pnpm --filter @sketchsync/db exec prisma migrate deploy
pnpm --filter @sketchsync/db exec prisma generate
```

`prisma generate` also runs on `postinstall`.

### Test inventory (verified by counting, not by trusting the docs)

**143 unit tests** across 10 files:

| File | Tests | Covers |
| --- | ---: | --- |
| `apps/realtime/src/rateLimit.test.ts` | 35 | Refill math on a synthetic clock, burst-then-sustain, bucket independence, misclassification, size-weighted cost, refund clamping, cost > capacity, violation decay, a `KNOWN_CLIENT_TYPES` drift guard |
| `apps/web/lib/canvas/export.test.ts` | 25 | Arrowhead geometry pinned against the pre-extraction formula, ink/union bounds incl. empty and zero-area, SVG viewBox in world units, stroke-width passthrough, the PNG size guard |
| `apps/realtime/src/zorder.test.ts` | 19 | Renormalize threshold (strict `<`, float-boundary anchored), order preserved across a rewrite, only-changed rows emitted, a 400-element board, `resolveZ` collision re-placement |
| `apps/web/lib/canvas/store.test.ts` | 17 | **Undo survives renormalization**, a full sync still clears it, one layer action = one outbound op, the style preview/commit split, the read-only role gate |
| `apps/realtime/src/messages.test.ts` | 12 | The real `handleMessage` pipeline against a stub socket. Every path it exercises stops before authz touches Prisma, so **no DB is needed** — which is exactly where the refund policy lives |
| `apps/realtime/src/upgradeAuth.test.ts` | 10 | Origin allowlist (scheme/port/trailing-slash/`null` rejected, absent allowed) and the subprotocol parser |
| `apps/realtime/src/syncChunks.test.ts` | 9 | Chunk boundary math, order across boundaries, over-budget element emitted alone |
| `apps/web/lib/roomName.test.ts` | 6 | Shared board-name bounds (trim-then-measure, 1..80) |
| `apps/api/src/auth/ticketLimiter.test.ts` | 6 | Burst/refill, per-user isolation, a realistic reconnect flurry passing, a hostile loop bounded |
| `apps/realtime/src/zlock.test.ts` | 4 | The advisory-lock key string pinned against the migration's |

There is **no vitest config file anywhere** — the suites run on Vitest defaults.

**27 e2e tests** across 7 spec files (`01-open-gap`, `02-transport`, `03-collaboration`,
`04-resilience`, `05-export`, `06-deferrals`, `07-states`), ~4.4–7.4 min, headless Chromium,
`workers: 1` (they share one database and one gateway). Playwright starts all three services
itself with **per-service readiness probes** — Turbo's combined output gives no per-service
signal, and "the web server answered" does not imply the API or gateway are up. `globalSetup`
absorbs Neon's cold start (~850 ms) and Next's per-route dev compile (board route ~7–12 s).

Design notes worth preserving:

- **Two browser contexts, never two tabs** — tabs share a cookie jar and cannot represent
  two users.
- Fixtures hit the API and the DB directly, never the UI. Users are created through the web
  origin's `/api` proxy so the cookie is attributed exactly as a browser's is; elements are
  seeded through the **same `sketchsync_insert_element` function the gateway uses**, keeping
  the advisory-lock zIndex invariants identical. `addMember()` writes the `RoomMember` row
  directly because **no HTTP route can grant VIEWER**.
- Assertions read a build-gated, **read-only** hook (`NEXT_PUBLIC_E2E=1`,
  `lib/canvas/testHook.ts`): the scene lives in a module-scoped store and never reaches the
  DOM. It exposes getters plus one deliberate exception, `dropSocket()`, because Chromium's
  CDP offline emulation does not tear down an already-established WebSocket.
- **Three fixed delays are load-bearing** and must not be "cleaned up" into waits: the gap
  test holds `/auth/ws-ticket` open for 3 s (the real window is shorter than Playwright's own
  navigation overhead — the test first shipped vacuous, and now also asserts
  `socketOpen() === false` at draw time so it cannot silently regress); the deferral test
  waits 5 s because it proves a *non*-event and there is no signal for that; test 18 allows
  180 s per download because the point is to measure the number, not to hide it.
- Harness traps found the hard way: React keeps its own value tracker, so assigning
  `input.value` and dispatching `input` does **not** fire `onChange` (go through the
  prototype's value setter); `waitForScene` returns its last value instead of throwing on
  timeout, so assert the returned length explicitly; the export panel uses `data-testid`
  throughout because `getByRole("button", { name: "SVG" })` is ambiguous.

Baseline gate: `pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm test:e2e`.
Manual browser verification is retired — the e2e suite is the gate.

**Windows:** `prisma generate` (run by `db`'s typecheck) fails with `EPERM … query_engine`
while `pnpm dev` is running, because the servers hold the DLL open. Stop dev servers first,
or typecheck `db` with `pnpm exec tsc --noEmit` directly.

---

## 10. Docker / deployment

**There is no Docker in this repository.** No `Dockerfile`, no `docker-compose.yml`, no
`.dockerignore`, no `Containerfile` — verified by a full-tree search. There is also:

- **no CI configuration** (no `.github/`, no pipeline file of any kind),
- **no deployment manifest** (no `vercel.json`, `fly.toml`, `render.yaml`, `Procfile`,
  Terraform, or Kubernetes),
- **no process manager or reverse-proxy config**,
- **no root `README.md`**.

The only YAML in the tree is `pnpm-workspace.yaml` and `pnpm-lock.yaml`.

What exists instead:

| Concern | Actual mechanism |
| --- | --- |
| Running locally | `pnpm dev` → Turborepo runs three persistent `dev` tasks (`next dev`, two `tsx watch`) |
| Running "built" | `tsup` → `dist/index.js` per service, started with `node dist/index.js` (`pnpm start`); web with `next start` |
| Database | **Hosted Neon Postgres** (ap-southeast-1) over TLS. Nothing is containerized — there is no local Postgres to run |
| Service orchestration in tests | Playwright's `webServer` array, which is the closest thing to an orchestrator in the repo |
| Configuration | `.env` files per app + `loadEnv()` validation |

Anyone containerizing this should know:

1. The services are **not independently buildable from their own directories** — they consume
   workspace packages as TS source, so a build context must include the whole monorepo plus
   the lockfile.
2. `@prisma/client` is kept external from the tsup bundle and needs its **native query
   engine** present at runtime; `prisma generate` must run for the image's target platform.
3. `web` needs `NEXT_PUBLIC_REALTIME_URL` **at build time** (it is inlined), while
   `API_ORIGIN` is read at runtime. Those are different lifecycle stages inside one image.
4. `WEB_ORIGIN` on the realtime service is a **security control**. Getting it wrong in an
   orchestrator either breaks every socket (403) or, set too loosely, removes the only
   protection against cross-site socket hijack.
5. `realtime` holds room membership in **process memory**, so more than one replica needs
   sticky routing plus a cross-process fanout that does not exist yet.
6. Neon should move to a pooled connection (`?pgbouncer=true` + Prisma `directUrl` for
   migrations) before any many-replica deployment. This is the stated Phase 5 item and is
   **not** wired into `schema.prisma`.

---

## 11. Known gaps / TODO / hacky bits

Honest inventory. Items marked **(pinned)** have a test that fails if you "fix" them without
confronting the underlying work.

### Repository and operations

1. **Not a git repository.** No `.git` directory, so there is no history, no branches, and
   the `.gitignore` currently protects nothing.
2. **Three real `.env` files are in the tree** (`apps/api/.env`, `apps/realtime/.env`,
   `packages/db/.env`) holding a live `DATABASE_URL` and `JWT_SECRET`. Combined with #1,
   nothing has prevented them from being committed. Rotate before publishing anywhere.
3. **No Docker, no CI, no deploy config, no README** — see [§10](#10-docker--deployment).
   Nothing gates a bad commit; the "baseline gate" is a command a human has to remember.
4. **Observability is `console.log`/`warn`/`error`.** No structured logging, no request or
   connection ids, no metrics, no tracing. `GET /health` returns `{ ok }` on the API and
   `{ ok, connections }` on the gateway; that is the entire surface.
5. `apps/e2e/results.json` and `apps/e2e/test-results/` are **not** gitignored.

### Authorization model

6. **There is no private board.** `GET /rooms/:slug` returns 403 for any non-member, and the
   client renders *every* 403 as "Join this board?" — and `POST /rooms/:slug/join` **always
   grants EDITOR**. Anyone with the slug can join and edit. VIEWER exists in the schema and
   is honoured by the UI, but **nothing can create one except a direct DB write** (which is
   exactly what the e2e fixture does). Invite-only rooms, role-on-invite, and a real 403
   screen are unbuilt.
7. **No room lifecycle routes at all**: no delete, no leave-room, no member list, no role
   change, no ownership transfer. A room and its elements can only be removed via SQL.
8. **Role is snapshotted at `join`.** `conn.role` is read once, so a role change mid-session
   is not observed until the socket reconnects.
9. **Only `/auth/ws-ticket` is rate-limited.** `signup` and `signin` have no throttling — the
   constant-time compare mitigates enumeration, but nothing bounds credential stuffing. The
   room routes are unthrottled too.

### Protocol and consistency

10. **`version` is client-supplied after create.** The server assigns `version = 1` on create,
    but `handleUpdate` / `handleDelete` store whatever integer the client sends
    ([`messages.ts:277`](apps/realtime/src/messages.ts:277),
    [`:317`](apps/realtime/src/messages.ts:317),
    [`:366`](apps/realtime/src/messages.ts:366)). A buggy or hostile client can send
    `version: 2147483647` and win **every** future LWW comparison for that element,
    permanently. Renormalization's `version + 1` is the only server-side increment.
    Server-monotonic versions are the real fix and are unbuilt.
11. **Simultaneous same-version edits of the same element can briefly diverge.** No CRDT, no
    OT, no tiebreaker — by design, but it is a real limitation.
12. **`leave` is dead protocol surface.** The type is defined and the server handles it, but
    the web client has no `emitLeave` and `send()` explicitly drops it. Rooms are only left by
    closing the socket.
13. **Mutations made while disconnected are dropped, not replayed. (pinned)** The
    connect-window queue is initial-connect only; replaying across a re-sync that
    wholesale-replaces the scene and clears history needs version reconciliation. Pinned by
    `apps/e2e/tests/04-resilience.spec.ts` ("DEFERRAL PINNED", test 15).
14. **The creating client keeps its optimistic `zIndex` and `version`.** The server assigns
    both authoritatively but broadcasts `elementCreated` to everyone *except* the sender, so
    the creator's local values remain its own guess (`nextZIndex` = local max + 1) until the
    next full sync or a renormalization broadcast. Usually identical; under concurrent
    creates, not.
15. **A board rename does not propagate** to clients already in the board — the WS protocol
    has no room-metadata message, and adding one would break the no-new-message-types rule.
    It self-corrects on reload. Unlike #13, this is **not** pinned by a test (the rename e2e
    covers persistence and the OWNER-only rule), so it can be changed silently.
16. **Undo does not propagate** to other clients, is local-only and id-scoped, and stores whole
    elements — so undoing a local command after a remote renormalization can momentarily
    restore a stale `zIndex`. Undo never broadcasts, so the next server update corrects it.
17. **Toasts are neither persisted nor queued.** A drop that happens while the tab is hidden
    shows a toast that may auto-dismiss unseen; the connection pill is the durable signal.

### Data

18. **Soft-deleted elements are never purged.** `deleted: true` rows accumulate forever — no
    reaper, no retention policy, no `deleteMany` anywhere in the application code.
19. **`WsTicket` cleanup is opportunistic and per-user.** Expired rows are swept only when
    *that same user* next requests a ticket, so a user who never returns leaves rows behind
    indefinitely. There is no scheduled sweep.
20. **`avatarUrl` is written by nobody.** It exists in the schema, in `SafeUser`, and in every
    `presence` payload, but no route ever sets it. It is always `null`.
21. **`Element.type` duplicates `data.type`** with no database constraint keeping them in
    sync. The server always writes `type: data.type`, so they agree by convention only.
22. **Prisma still uses a direct (non-pooled) Neon connection.** `directUrl` is not in
    `schema.prisma`. Phase 5 item.

### Performance

23. **Every edit is its own row write.** No batching or coalescing of WS writes — the stated
    next performance item. Coalescing would also shrink the renormalization burst the mutation
    bucket is sized for.
24. **`permessage-deflate` is measured (4.4× on a sync chunk: 238 KB → 53.5 KB) but not
    enabled** — `ws` allocates ~300 KB of zlib context per connection (~30 MB at 100
    connections, ~300 MB at 1000). Revisit with real connection counts; if enabled, use
    `threshold: 1024` so 20/s cursor frames skip it, a reduced `memLevel`, and a
    `concurrencyLimit`.
25. **Cold-start note — expected and self-correcting, not a bug:** admitted bulk throughput
    (~80 KB/s) exceeds *cold* Neon persistence (~32 KB/s, 7.35 s for the first 238 KB write
    after idle), so an in-flight write queue can grow transiently on the first writes after an
    idle period. Warm persistence is ~1.8 s, well inside the admitted rate, so it drains on
    its own. Do not "fix" this by lowering the mutation rate.
26. **`realtime` is a single process with in-memory rooms.** Horizontal scaling needs a
    pub/sub fanout (Redis or similar) that does not exist.

### Testing

27. **A known e2e flake is unexplained.** Across three unperturbed runs (7.4 min pass, 7.1 min
    fail, 4.4 min pass), one failed on `waitForCanvas`'s 30 s
    `page.waitForSelector("canvas")` ceiling in a `beforeAll` — with the failure snapshot
    showing the board fully rendered, and both affected files passing in isolation. **The
    timeout has deliberately not been raised**; bumping a number until a symptom stops is how a
    suite quietly stops testing. Do not treat a red run as a real regression until you have
    re-run.
28. **`reuseExistingServer: !process.env.CI` is a trap.** If `pnpm dev` is already running
    without `NEXT_PUBLIC_E2E=1`, Playwright reuses it, the test hook is absent, and the suite
    fails confusingly. Stop dev servers before `pnpm test:e2e`.
29. **What the e2e suite does not cover** — assume unverified: no screenshot/visual regression
    (a shape could render *wrongly* and pass; rendering is only asserted indirectly via the
    store); Chromium only, no Firefox/WebKit/mobile/touch; cross-origin is never exercised
    (everything runs on `localhost` — the genuinely cross-origin socket path was verified once
    by a throwaway script); no load/soak; no real service kill (failures are simulated with
    `page.route`/`dropSocket`, not by stopping processes); multi-tab same-user untested; no
    keyboard-layout coverage, so the non-US bracket-label path and the Firefox/Safari fallback
    are unverified; `role="alert"` is asserted as an *attribute*, never as an announcement.
30. **Integration checks that need live servers plus Neon** (WS floods, oversized frames, the
    200-concurrent-create race, socket-state release) are scripted `tsx` throwaways — written,
    run, deleted. **They cannot run in CI as-is**, and there is no CI anyway.

### Stale documentation in the tree

31. [`apps/web/.env.example`](apps/web/.env.example) still says the socket "remains
    cookie-authenticated and therefore still breaks cross-origin. That is Phase 4 step 3b."
    That work shipped — the socket uses ticket auth and has no cookie fallback.
32. `CLAUDE.md`'s layout table lists the web route as `/canvas`; boards actually live at
    `/room/[slug]`, and `/canvas` is a server redirect to `/rooms`.

### Deferred UX (deliberately out of scope, not forgotten)

33. Select-all, copy/paste, duplicate, arrow-key nudge, zoom-to-fit, and a `?` shortcuts
    overlay are unbuilt.
34. **Shift shape constraints are missing.** Shift reaches `EditSession` only —
    `DrawSession.begin` is called without modifiers, so there is no square/circle/45°-line
    constraint.
35. **`DrawSession.cancel()` is Escape-only and draw-only.** An edit drag has already previewed
    a moved scene and `EditSession` has no restore path, so aborting one would strand the
    preview. That asymmetry is a decision, not an oversight.
36. **SVG export keeps the font stack** rather than converting text to paths, so exported text
    may re-flow elsewhere. Surfaced in the export panel itself, not in a tooltip.
37. **PNG export refuses very large boards** (> 16384 px per side or > 67,108,864 px²) with
    `ExportTooLargeError` rather than emitting a silently blank or truncated image. Not
    theoretical: a board of 20 max-legal strokes spans ~150M pixels and **is** refused; the
    same board exports to SVG at 2.13 MiB / 700 ms — flagged rather than silently decimated.
