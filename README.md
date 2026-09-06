# SketchSync

A real-time collaborative infinite whiteboard — several people draw on one shared,
pannable/zoomable canvas and see each other's shapes, edits and cursors live.

**Live demo: <LIVE_URL>**

> The backend runs on a free tier that sleeps after ~15 minutes of inactivity. **The first
> load after an idle period takes about a minute** while it wakes up. Subsequent loads are
> fast.

[![CI](https://github.com/SambhavJ2004/sketchsync/actions/workflows/ci.yml/badge.svg)](https://github.com/SambhavJ2004/sketchsync/actions/workflows/ci.yml)

**Stack:** pnpm + Turborepo monorepo · Next.js 15 / React 19 / Tailwind v4 / Zustand ·
Express 5 · Node + `ws` · Prisma + Postgres (Neon) · Zod for every input boundary ·
TypeScript strict throughout · Docker · GitHub Actions.

---

## Architecture

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

Three processes because they have different shapes: `api` is stateless request/response,
while `realtime` holds long-lived connections and per-room state in memory — so the gateway
can be hardened, rate-limited and restarted without touching page serving.

**The browser never addresses the API's origin directly**; all HTTP goes to `/api/*` on the
web origin and Next proxies it server-side. That was measured, not preferred: with the two on
separate origins, signup returned `201` with a correct `Set-Cookie` and the very next request
`401`'d, because the browser had never *stored* the cross-site cookie at all. Dev uses the
same proxy deliberately — a dev-only direct connection is exactly what hid that until
production.

Full protocol, data model and auth flow: [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Interesting problems

### The WebSocket couldn't use the session cookie

Fixing HTTP by proxying it same-origin broke the socket, because a rewrite cannot proxy a
WebSocket — it has to reach the realtime host directly, cross-origin, where the cookie is
neither sent nor stored. The obvious workaround, keeping a cookie path for dev and something
else for production, is the precise bug class that had just cost a production outage: a code
path that only executes where you aren't looking.

So the socket authenticates with a **single-use ticket** instead, and there is deliberately
**no cookie fallback**. The client asks the API for one over the same-origin proxy (where the
cookie still works), then opens the socket with it. The ticket is 32 random bytes, stored
only as its SHA-256, so a database leak yields nothing usable, and it is redeemed with one
atomic statement — `DELETE ... WHERE tokenHash = $1 AND expiresAt > NOW() RETURNING userId`.
That single statement is what makes single-use safe across two processes that share only a
database: two racing upgrades both issue the delete and only one gets a row back, where
check-then-delete would have left both valid. Expiry is evaluated by the *database* clock, so
a skewed gateway can't extend a ticket, and the TTL is **15 seconds** — the client fetches one
immediately before connecting, so a longer window would only widen the replay surface. The
credential travels in the `Sec-WebSocket-Protocol` header rather than a query parameter,
because query strings land in access logs, proxy logs and browser history. Verification
happens *during* the upgrade, so a refusal is a real HTTP status — `401` for a bad ticket,
`403` for a bad origin — rather than a successful `101` followed by an immediate close, which
cannot express the difference.

The subtle part is what this **removed**. Previously `SameSite=Lax` was quietly doing security
work: a hostile page could open a socket, but the browser withheld the cookie, so the
connection was useless. Once the credential became something the client supplies explicitly,
that accidental protection vanished — and the **origin allowlist became the only thing**
standing between a malicious page and a cross-site WebSocket hijack. It is an exact string
match per entry, never a prefix or wildcard, because `https://app.example.com.evil.test`
prefix-matches `https://app.example.com`. Cost of the whole handshake: **283 ms median** to
first open, about **+180 ms** versus the cookie version.

### 138 duplicate orderings in 200 concurrent creates

Every shape has a floating-point `zIndex` so a new one can be inserted *between* two others
without renumbering the board. Assigning it looked trivial: read the room's current maximum,
write max + 1. Under concurrency it isn't — two creates read the same maximum and write the
same value.

That sounds cosmetic and isn't. The client moves a shape backward by computing the midpoint
between it and its lower neighbour. If a duplicate makes that neighbour's value *equal* to
the shape's own, the midpoint is the value it already has — so **"send backward" silently
does nothing**, forever, and no error is raised anywhere. Worse, an affected board can never
self-heal, because the repair path only runs when a z-changing update arrives, and that is
exactly the operation that has become a no-op.

Two cheaper-looking fixes were built and measured before the real one. Wrapping the
read-and-write in an interactive transaction is *correct* but costs about five network round
trips, and because the lock serializes creates per room that cost is paid sequentially:
**468 ms per create**. Folding it into a single `INSERT ... SELECT` with the lock in a
materialized CTE is fast but **unsound** — nothing forces the CTE holding the lock to evaluate
before the `MAX` read, which produced **138 duplicates across 200 concurrent creates** in
testing. The fix was to push the whole operation into a Postgres `plpgsql` function that takes
a per-room `pg_advisory_xact_lock`, reads the max, and inserts — *in that order*, which
plpgsql guarantees and a query planner does not. One round trip, and correct: 200
fully-contended creates now finish in **1.9 s (9.7 ms each)**, with 200 distinct orderings.
The lock is held only for in-database work, never across a network call, which is why
contention is cheap.

### Rate limiting that can't be gamed by frame count

The gateway is exposed publicly, so a single socket must not be able to exhaust it. Counting
frames per second is the obvious approach and is wrong here, because frames aren't
comparable: a cursor update is a few dozen bytes, while one maximum-legal pencil stroke is
**~238 KB** that takes seconds to persist. A limiter admitting "20 mutations/sec" would
happily admit 20 of those, enough to starve the shared database connection pool for every
room on the instance.

So mutations are charged **by size** — `cost = max(1, ceil(bytes / 4096))`, taken from the raw
frame before parsing. Three independent token buckets refill from elapsed time with no timers:
`global` (400 capacity, 60/s), `cursor` (40, 25/s) and `mutation` (300, 20/s). Cursor and
mutation stay independent so ordinary pointer traffic can never starve edits, and mutation
capacity is deliberately far larger than its refill rate, because legitimate clients emit
synchronous bursts — a multi-select delete is one frame per element. Over-limit frames drop
silently and score a **violation**, and that score **decays at 10/s**, so it measures intensity
rather than lifetime total: 500 violations in ten seconds closes the socket, while 500 spread
across an eight-hour session never does.

The part worth explaining is the **refund**. Every frame is charged against `global` *before*
parsing, since an unparseable flood must be bounded too — but that charge is **refunded the
moment the frame turns out to have a known message type**. From that point the class bucket
owns it, and a class-bucket rejection already scores a violation, which closes the socket at
500 — a strictly stronger bound than `global` merely draining at 400 and leaving it open.
Holding the charge past classification would only re-couple the buckets, so a burst of cursor
frames could block an edit the user had already seen rendered. `global`'s sole remaining job
is frames that cannot be *classified* at all — malformed JSON and unknown types — which pay
it and stop there. The message class is decided from the parsed `type` field, never from the
raw bytes: a frame can perfectly well contain the string `"cursor"` inside a *value* while
being an element write.

---

## Quick start

From a clean clone, with no `.env` files and nothing installed:

```bash
docker compose up --build
```

Then open **http://localhost:3000**.

That brings up Postgres 16, runs the schema migrations as a one-shot job, waits for it to
finish, then starts `api`, `realtime` and `web` — each gated on the previous one being
healthy, so there is no race and no retry loop on first boot.

For day-to-day development, run only the database in Docker and the three services on the
host with hot reload:

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm install && pnpm dev
```

---

## Tests

**150 Vitest unit tests** and **27 Playwright end-to-end tests** (headless Chromium, two
browser contexts so two real users are represented rather than two tabs sharing a cookie
jar). The unit suites cover the security- and correctness-critical logic directly: the origin
allowlist, the ticket parser, z-order renormalization and collision re-placement, the rate
limiter's refill and refund maths, and the canvas store's undo semantics.

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm test:e2e
```

That is the full gate, and **CI runs it on every push** along with a parallel job that builds
all three Docker images, so a broken Dockerfile fails the build too.

---

## Known limitations

Stated plainly rather than buried:

- **Free-tier cold start.** The backend sleeps after ~15 minutes idle; the first request after
  that takes about a minute. It affects the WebSocket gateway too, so a wake also drops live
  connections.
- **Room membership lives in process memory.** The realtime gateway keeps connected sockets in
  an in-memory map, so restarting it clears presence for everyone and would need a cross-process
  fanout before it could run more than one instance.
- **Boards are link-access — anyone with a board URL can edit it.** Joining always grants
  editor rights, and there is no way to share a board read-only.
- **There are no private boards yet.** The role model exists in the schema and the UI honours
  it, but nothing can currently *create* a view-only membership. Proper sharing — invite-only
  rooms, roles on invite, a real no-access screen — is the next piece of work.
- **Simultaneous edits to the same shape by two people can briefly diverge.** Conflicts resolve
  last-write-wins by version; this is deliberately not a CRDT.

The complete list, including what the test suite does *not* cover, is
[`ARCHITECTURE.md` §11](ARCHITECTURE.md#11-known-gaps--todo--hacky-bits).
