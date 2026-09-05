# SketchSync

Real-time collaborative **infinite whiteboard**. Multiple users draw on a shared,
pannable/zoomable canvas and see each other's shapes, edits, and cursors live.

Status: **Phase 4.7 complete — Phase 4 is done** (real-time sync, LWW versioning, layer
ordering, presence/cursors, auth+rooms UI, gateway hardening, same-origin HTTP,
cross-origin socket auth, e2e browser suite, PNG+SVG export, board rename, role-aware
read-only UI, connection status + toasts, keyboard/empty-state pass). See "What's next".

## Stack

- **Monorepo:** pnpm workspaces + Turborepo. Package scope `@sketchsync/*`.
- **web:** Next.js 15 (App Router) + React 19 + TS + Tailwind v4 + Zustand + lucide-react. Port **3000**.
- **api:** Express 5 + TS (HTTP). Port **3001**.
- **realtime:** Node + `ws` WebSocket server + TS. Port **3002**.
- **db:** Prisma + Postgres (**Neon**, ap-southeast-1). Also hosts the shared authz helpers.
- **auth:** server-only JWT primitives shared by api + realtime (never imported by web).
- **shared:** Zod schemas + inferred TS types (the single source of truth for cross-app contracts).
- **config:** Zod-validated env loader. **typescript-config / eslint-config:** shared bases.

## Layout

```
apps/web        canvas engine + realtime client (route: /canvas)
apps/api        auth + room HTTP routes
apps/realtime   WebSocket gateway (auth, rooms, sync, presence)
packages/auth   SERVER-ONLY token primitives: AUTH_COOKIE, signToken/verifyToken, TokenPayload
packages/db     Prisma client singleton, generated types, authz (getMembership/roleAtLeast/ROLE_RANK)
packages/shared Zod schemas: Auth, Room, ElementData (discriminated union), Element, WS ClientMessage/ServerMessage
packages/config loadEnv() — validates DATABASE_URL, JWT_SECRET, API_PORT, REALTIME_PORT, NODE_ENV, WEB_ORIGIN
apps/e2e         Playwright browser suite (fixtures + tests; `pnpm test:e2e`)
packages/{typescript-config,eslint-config}
```

**Build model:** internal packages are consumed **just-in-time** — they export TS
source (`exports: "./src/index.ts"`), no build step. Consumers compile them:
- api/realtime build with **tsup** (bundle `@sketchsync/*`, keep `@prisma/client` external), dev via `tsx watch`.
- web uses `transpilePackages: ["@sketchsync/shared"]` + a webpack `extensionAlias` mapping `.js`→`.ts`
  (shared uses NodeNext-style `.js` extensions for the api/realtime NodeNext builds).

## Commands (from repo root)

- `pnpm dev` — web + api + realtime via Turborepo
- `pnpm build` · `pnpm lint` · `pnpm typecheck` · `pnpm test` — all packages
- `pnpm test:e2e` — Playwright browser suite (separate from `pnpm test`, which stays fast)
- DB: `pnpm --filter @sketchsync/db exec prisma migrate deploy` (apply migrations, direct Neon URL);
  `... prisma generate` regenerates the client. Runs `prisma generate` on `postinstall`.

## Environment

`loadEnv()` validates `process.env`; each app calls `process.loadEnvFile()` at
startup (gitignored `.env`), platform injects real env in prod.
- `apps/api/.env` and `apps/realtime/.env` **must share the same `JWT_SECRET` and `DATABASE_URL`**
  (realtime verifies the cookie the API issues, and both read/write the same DB).
- `packages/db/.env` holds `DATABASE_URL` for Prisma CLI.
- web: **`API_ORIGIN`** (default `http://localhost:3001`) — **server-side, NOT `NEXT_PUBLIC_`**, used by
  the `/api/:path*` rewrite. Because it is not inlined into the bundle, pointing an environment at a
  different API is a restart, not a rebuild. `NEXT_PUBLIC_REALTIME_URL` (default `ws://localhost:3002`)
  is still build-time inlined — the socket is not proxied (step 3b).
- **No secrets in code.** Cookies are host-scoped; ports are irrelevant to cookie scope, which is why
  the `localhost:3000/3001/3002` split worked and a real cross-origin split does not (see below).

## Data model (Prisma)

- **User** (id uuid, email unique, passwordHash, name, avatarUrl?, createdAt)
- **WsTicket** (`tokenHash` PK = SHA-256 of the ticket, userId, expiresAt, createdAt). Single-use
  WebSocket credential; redeemed with `DELETE … RETURNING`. Raw value never stored.
- **Room** (id, slug unique, name, ownerId, createdAt)
- **RoomMember** (roomId, userId, role `OWNER|EDITOR|VIEWER`, unique(roomId,userId))
- **Element** (id, roomId, type, `data Json`, `version Int`, createdBy,
  `zIndex Float`, `createdAt`, updatedAt, `deleted Bool`). Indexed `(roomId, zIndex, createdAt)`.
  `data` holds the shared `ElementData`; `type` mirrors `data.type`.

## Same-origin HTTP (Phase 4.3a)

**The browser never talks to the API's origin.** `next.config.ts` rewrites
`/api/:path*` → `${API_ORIGIN}/:path*`, and `lib/api/client.ts` uses the relative base `"/api"`.

Why, measured rather than assumed: with web on `http://localhost:3000` and the API on
`http://127.0.0.1:3001` (different hosts = different sites), signup returned **201 with a correct
`Set-Cookie`** and correct CORS headers — and the very next request was **401**. A top-level
navigation straight to the API origin was **also 401**, which proves the browser **never STORED
the cookie**, not merely that it declined to send it. Auth failed completely, not gracefully.
CORS was never the problem; it was negotiated fine throughout.

Confirmed after the change, from the browser (cookies ignore PORT but honour HOST and PATH):
- `/api/auth/me` → 200.
- `http://localhost:3001/auth/me` → 200 — same host, path *outside* `/api`, so the stored
  **`Path` is `/`**; the rewrite did not narrow it to `/api`.
- `http://127.0.0.1:3001/auth/me` → 401 — the cookie is scoped to the **web** origin's host.
- `document.cookie` never exposes it (still httpOnly).

**Dev uses the same proxy deliberately.** A dev-only direct connection is precisely what hid this
bug: localhost shared an origin, so the cross-site path never executed until production.
Cost of the hop: `/auth/me` median **90.8 ms direct → 96.8 ms proxied (+6.0 ms)**; the ~90 ms
baseline is the Neon round trip.

The API's CORS config is now **defence-in-depth, not load-bearing** — same-origin traffic never
exercises it. It is kept because it still constrains anything calling port 3001 directly.

**The WebSocket is NOT proxied** and remains cookie-authenticated, so it is still broken
cross-origin. That is Phase 4 step 3b (a ticket via `Sec-WebSocket-Protocol` — never a query
param, which would land in access logs, proxy logs, and browser history).

## HTTP API (apps/api)

Auth (bcrypt cost 12; JWT `{userId}` 7-day; httpOnly cookie **`sketchsync_token`**, sameSite lax,
secure in prod): `POST /auth/signup|signin|signout`, `GET /auth/me`, `POST /auth/ws-ticket`
(single-use socket credential, 15s TTL, rate-limited per user). `requireAuth` middleware.
Signin/wrong-password both return the same 401; duplicate signup → 409.

Rooms (all require auth): `POST /rooms` (create; owner auto-added OWNER; slug = slugify+random suffix),
`POST /rooms/:slug/join` (open **EDITOR** join via share link, idempotent), `GET /rooms/:slug`
(metadata + caller role + memberCount; 403 if not a member), `GET /rooms` (rooms the caller is in).
`requireMembership(minRole)` middleware. **The WS socket only CHECKS membership; the HTTP join route creates it.**

## WebSocket gateway (apps/realtime)

**Auth is a SINGLE-USE TICKET verified DURING the upgrade — never the cookie** (Phase 4.3b, see
below). Every inbound message validated with the shared `ClientMessage` Zod schema
(bad message → `error`, never crash). In-memory `RoomRegistry` (roomId → Set of sockets, each tagged
with userId/name/role). **Writes require role ≥ EDITOR** (`roleAtLeast`).

Message flow (all shared types — **no new message types are ever added**):
- `join {roomId}` → membership check → **chunked** `sync {elements, seq, done}` (ordered
  `zIndex, createdAt`) + `presence {users}` broadcast.
- `elementCreate {element}` → server assigns `version=1` **and** `zIndex = roomMax+1` authoritatively
  (ignores client-sent values; `ElementInput` deliberately has no zIndex field) → broadcast
  `elementCreated` to others. zIndex assignment is **serialized per room** — see below.
- `elementUpdate {id, data, zIndex, version}` → **LWW**: accept iff `incoming.version >= stored.version`,
  then set stored version = incoming; else drop silently → broadcast `elementUpdated`. (zIndex rides here.)
  A **content-only** edit (drag/resize/restyle) takes no lock — two people dragging different shapes
  must never serialize. A **zIndex-changing** edit runs under the per-room lock; see below.
- `elementDelete {id, version}` → soft-delete (same LWW gate) → broadcast `elementDeleted {id}`.
- `cursor {x,y}` → relay `cursor {userId,x,y}` to **others only**, **never persisted**.
- `presence {users}` → broadcast on join and on leave/disconnect; **deduped by userId** (multi-tab safe —
  a user drops only when their last socket closes).
The server broadcasts to everyone **except the sender** (sender already rendered optimistically).
The one exception is renormalization, below, which goes to **everyone** — the initiator's
optimistic zIndex is stale too.

## WebSocket ticket auth (Phase 4.3b)

The socket **cannot** use the session cookie. It must reach the realtime host directly and
cross-origin — a rewrite cannot proxy WebSockets — and cross-site cookies are not sent (measured
in 4.3a: not even *stored*). **There is deliberately no cookie fallback**: one that works in dev
and fails in prod is the exact bug class 4.3a existed to remove.

**Issuance** — `POST /auth/ws-ticket` on the API, reached same-origin through the `/api` proxy, so
the ordinary session cookie authenticates it. Returns an **opaque 32-byte base64url value**, not a
JWT: single-use has to be enforced across two processes sharing only the database, so a redemption
round trip is unavoidable either way — and once that is true a JWT's statelessness buys nothing
(it would still need a `jti` row to mark consumed, i.e. the same write, plus a second token format
to keep in sync). With an opaque value **the row IS the ticket**. Only its SHA-256 is stored.
Payload is `userId` only — **no room scope**; membership is still checked at `join` (decision #9),
so a ticket means "you are this user", never "you may enter this board". Issuance is rate-limited
**per user** (capacity 10, refill 0.5/s → 429), because a ticket endpoint that can be hammered is
a token-minting oracle.

**TTL is 15 SECONDS.** The client fetches a ticket immediately before connecting, so the only gap
is one round trip plus the handshake. A longer TTL buys nothing — every reconnect mints a fresh
one — and only widens the window a leaked ticket is usable in.

**Redemption** — `DELETE FROM "WsTicket" WHERE tokenHash = $1 AND expiresAt > NOW() RETURNING
"userId"`. One atomic statement is what makes single-use safe across processes: two racing upgrades
both issue the delete, only one gets a row. Check-then-delete would leave both valid. Expiry is
evaluated by the **database** clock, so a skewed gateway cannot extend a ticket.

**Verification happens at the UPGRADE, not after.** `WebSocketServer({ noServer: true })` plus an
`httpServer.on("upgrade")` handler, so a refusal is a real HTTP status: **403** for a disallowed
Origin, **401** for a missing/expired/already-redeemed ticket. The old shape (101 then `close(1008)`)
could not express the difference.

**The credential rides in `Sec-WebSocket-Protocol`**, as `[WS_TICKET_PROTOCOL, <ticket>]` — never a
query param, which lands in access logs, proxy logs, and browser history. The server echoes back
**only the marker**, never the ticket. `WS_TICKET_PROTOCOL` lives in `@sketchsync/shared`, not
`@sketchsync/auth`, because the browser needs it and `auth` must never reach the client bundle.

**Origin allowlist at upgrade — DO NOT REMOVE.** Until 4.3b, `SameSite=Lax` was implicitly
preventing cross-site socket auth: a hostile page could open a socket but the browser withheld the
cookie. Now the credential is one the client supplies, so that protection is **gone**, and this
check is all that stands between a malicious page and a cross-site WebSocket hijack. Semantics: an
`Origin` present must equal `WEB_ORIGIN`; absent is allowed (non-browser tooling, which could spoof
any value anyway — browsers always send it, so the browser surface is fully covered).

**Cost of the ticket hop:** time from "open board" to "socket open" is **283 ms median** — a
**134 ms** ticket fetch on top of a **103 ms** handshake, i.e. **+180 ms** versus the pre-ticket
shape. That widening is what made the connect-window drop (4.4b) worth fixing rather than tolerating.

**Client flow** — fetch a ticket, then open; on every reconnect fetch a **fresh** one. The browser
cannot read a failed handshake's status, so the two 401s are told apart at *issuance*, which is an
ordinary fetch: **401 from `/auth/ws-ticket` = session gone** → terminal, stop retrying, route to
`/signin?next=…`; **issuance OK but handshake failed** = ticket/transport → retry after ~150 ms
with a fresh ticket (twice), then fall back to the normal 0.5s→8s backoff.

## Visible state: roles, connection, keyboard (Phase 4.7)

Two of these were correctness bugs, not polish. Both were the same failure class as the
connect-window drop: work that renders locally, is refused or never sent, and disappears.

**VIEWER silent loss — FIXED.** `RoomDetail.role` was fetched and never read, so a VIEWER
drew, saw the shape, had every mutation refused by the gateway, and lost it on reload.
Permanent, not a race. `role` now reaches `CanvasStage`, which derives `canEdit`
(OWNER|EDITOR) and pushes it into the store.
- **The store is the choke point.** `addElement` / `deleteSelected` / `applyStyleToSelection`
  / `previewStyleOnSelection` / `commitStylePreview` / `layerAction` / `commitScene` all
  return early when `!canEdit`, so nothing enters the scene, history, **or the outbound
  sink**. `commitScene` additionally *restores* `previous`, because an edit drag has already
  previewed a moved scene by then.
- **`setTool` is gated too**, which covers the toolbar buttons and the `v r o l a p t h`
  shortcuts in one place — a read-only client can only reach `select` and `pan`.
- `EditSession` takes a `canEdit()` callback: selection still works (it drives
  selection-scoped export), move/resize never starts, and the resize handles are not drawn
  (`handles: []` in `CanvasStage`) — an affordance that cannot act is worse than none.
- **Chosen: disabled tools + a persistent "View only" badge, NOT draw-then-refuse.** The
  structure made this much the cheaper option: tool selection already funnels through
  `setTool` and drawing through `DrawSession.begin`, so two guards cover every entry point.
  Draw-then-refuse would need a rollback path for server-rejected optimistic commits, which
  does not exist anywhere in the client — that is the same reconciliation work the
  offline-queue deferral is blocked on.
- **SERVER ENFORCEMENT IS UNCHANGED AND STAYS AUTHORITATIVE.** `canWrite` in
  `apps/realtime/src/messages.ts` still checks `roleAtLeast(role, EDITOR)` on every
  create/update/delete. The client flag comes from a fetch the user controls and a
  hand-crafted socket frame never passes through the store. This is said in the code, at
  the `canEdit` declaration in `store.ts`, so it is not removed as "now redundant".

**Toast channel.** There was no mechanism for errors that arrive *unsolicited*, which is the
entire category the socket produces — every other error surface is attached to a form the
user just submitted. `components/Toast.tsx`: provider + `useToast().show(message, {tone,
durationMs, key})`, auto-dismiss at 6 s, `role="alert"`. **`key` dedupes** — a second toast
with the same key replaces the first and restarts its timer, because a burst of dropped
mutations is one condition, not N notifications. `FormError` also gained `role="alert"`: a
failed sign-in previously appeared with no announcement at all.

**Connection status.** 4.4b built `dropped.{overflow,disconnected}`, `onDropped`, `onFlush`
and four statuses, and *nothing outside the test hook consumed them* — `onStatus` went to
`e2eSetStatus`, which is a no-op unless `NEXT_PUBLIC_E2E=1`. So a user whose socket dropped
saw a completely normal canvas, kept drawing, and lost it: the accepted offline-drop deferral
became a data-loss surprise purely through silence.
- `ConnectionStatus` renders a calm inline pill (bottom-centre), never a modal — the state is
  recoverable and usually sub-second, and the canvas stays usable throughout. It names the
  consequence ("Changes you make now will not be saved"), not just the state.
- **400 ms grace before showing anything.** Connect is ~283 ms and reconnect backoff starts
  at 500 ms, so without it every page load flashes a warning. Long enough to hide the normal
  case, short enough that a real outage is immediate.
- `onDropped` → toast; `onError` (server `error` frames) → toast, keyed so a flood collapses.
- **Presence is cleared on any non-open status.** It is a server broadcast, so the last one
  is stale the moment the socket dies; leaving the avatars up asserts people are still there.

**Keyboard guard unification.** There were THREE predicates for "is the user typing" —
`e.target.tagName` in the shortcut handler, `document.activeElement` in `Input`'s Space
guard, and `editingRef` for the nav lock. They agreed **only by coincidence**: the text
overlay happens to be autofocused and commits on blur. `lib/canvas/keyboard.ts` now owns
both forms (`isTypingElement(target)` for key events, `isTypingNow()` for ambient focus) and
all three call sites use it; the shortcut handler checks both, and `isNavLocked` is
`editingRef.current || isTypingNow()`.

**Export panel keyboard isolation.** The panel listened on `document` while the canvas
listens on `window`, so both fired: Escape closed the panel **and** ran `clearSelection()` —
destroying the selection a "Selection"-scoped export was about to use. Every other canvas
shortcut reached the board through the open panel too.
- **CHOSEN: a capture-phase `window` listener that stops propagation for every key**, rather
  than making the panel a true modal. It is a popover anchored to its trigger; a real modal
  needs a focus trap, backdrop and `aria-modal`, and would block the canvas underneath.
  Capture at `window` is strictly ordered before *any* bubble-phase listener and does not
  depend on React's event delegation, so React internals cannot break it.
- `stopPropagation` does **not** suppress default actions, so Tab still moves focus and
  Enter/Space still activate the focused button inside the panel.
- Focus moves into the panel on open and **returns to the trigger** on close.

**Layer shortcut labels.** `e.code` is KEPT for layer keys — positional is correct, and it is
what makes Shift-to-front work without caring that Shift turns `]` into `}`. The *labels*
were wrong twice over: `⌘` on Windows, and `]` on any layout where that physical key prints
something else (German QWERTZ `+`, French AZERTY `$`). `lib/shortcutLabel.ts` resolves the
modifier from the UA and the bracket characters from `navigator.keyboard.getLayoutMap()`,
falling back to `]`/`[` where the API is absent (Firefox, Safari) — i.e. today's behaviour,
no regression, correct wherever the browser can tell us. Rejected: rebinding to `e.key` so
the label is trivially right — that moves the shortcut to a different physical key per layout
and reintroduces the Shift problem. **Resolved in an effect, not during render**, or the
server HTML and first client paint disagree (hydration mismatch over a tooltip).

**`DrawSession.cancel()` was dead code — now wired to Escape.** A draft could not be
abandoned; you had to release and undo. Escape aborts an in-progress draw (and
`Input.cancelGesture()` clears the `drawing` flag so pointerup cannot commit it), otherwise
falls through to clear the selection. **Deliberately DRAW-only**: an edit drag has already
previewed a moved scene and `EditSession` has no restore path, so aborting one would strand
the preview. That asymmetry is a decision, not an oversight.

**Empty vs broken.** The rooms list set `rooms = []` on a failed load *and* showed a banner,
so an unreachable API rendered as "No boards yet." with a Create button — a user was told
they had no boards. `loadError` is now separate state, `rooms` stays `null`, and a failure
renders its own panel ("Your boards are still there — this is a connection problem") with
Try again. Empty boards get a centre-canvas hint, and the export panel now states *why* its
run button is disabled on an empty scene.

## Small fixes (Phase 4.6)

**Colour picker no longer spams undo.** `<input type="color">` fires React `onChange` on every
pointer move, so one tweak produced an undo entry AND a network mutation per frame. The store now
splits `previewStyleOnSelection` (updates the scene, NO history, NO emit, snapshots the pre-drag
scene once) from `commitStylePreview` (one history entry, one emit per element, one version bump).
**Debounce-on-idle at 350 ms, plus an immediate flush on blur and on unmount.** Chosen over
commit-on-close because React's `onChange` maps to the DOM `input` event and browsers disagree about
when `change` fires for a colour input (Safari fires it mid-drag) — idle-debounce behaves the same
everywhere and is directly testable; the blur flush removes the "commits later than you expect"
drawback. **Stroke width needed no change**: it is four discrete buttons, not a range input, so a
click was already one entry.

**Board rename.** `PATCH /rooms/:slug`, **OWNER only** — editors arrive via a share link and are
effectively guests; read/draw access should not imply the right to relabel someone else's board.
`RoomName` in `@sketchsync/shared` (trim, **1..80**) is used by create AND rename so client and
server cannot drift. The rooms list has inline rename, and the pencil control is hidden for
non-owners (the API still enforces it — the UI merely avoids offering a guaranteed 403).
**A rename does NOT propagate to clients already in the board**: the WS protocol has no
room-metadata message and adding one would break the no-new-message-types rule. The divergence is a
stale title in the board chrome only, and it self-corrects on reload or on navigating via `/rooms`.
**Unlike the offline-mutation deferral, this one is NOT pinned by a test** — the rename e2e test
covers persistence and the OWNER-only rule, not non-propagation. It is a documented accepted
behaviour, so changing it will not fail anything; decide deliberately rather than by accident.

**Signed-in users are redirected off `/signin` and `/signup`**, honouring `?next=`. Gated on
`AuthProvider`'s `loading`, and the form returns a spinner while `loading || user`, so the auth
form is never painted first. Note the coupling this creates: a socket `onSignedOut` bounce to
`/signin` only shows a form if the session really is gone — which it is, since one dead cookie
401s both `/auth/ws-ticket` and `/auth/me`.

## Export (Phase 4.5)

PNG and SVG, both from the SCENE bounds — never the current viewport, since exporting whatever
happens to be scrolled into view makes the output depend on where the user last looked.

**Shared geometry, extracted only where it would otherwise drift.** `arrowHeadPoints` in
`geometry.ts` owns the arrowhead constants (`3.5` scale, `8` floor, `PI/6` spread) and is consumed
by BOTH `renderer.ts` and the SVG serializer. Rect/ellipse/line/text are deliberately NOT abstracted
— they are near-1:1 with SVG primitives and an indirection layer would buy nothing.

**Bounds.** `elementInkBBox` pads by `style.width / 2` (text excepted — it is filled, not stroked)
and, for arrows, unions the barbs, which `elementBBox` excludes. `unionBBox` returns **null** for an
empty scene rather than a zero box at the origin: "nothing to export" and "empty content at (0,0)"
are different, and the caller must decide. A zero-area element (zero-length line, single-point
pencil) still yields a real box, because stroke padding gives it `style.width` of extent — which is
what actually renders, since round caps draw a dot.

**SVG.** `viewBox` is in **WORLD units** and coordinates are emitted verbatim; the viewport
transform is never baked in, which is what makes `stroke-width` a straight copy of `style.width` and
reproduces decision #4 for free. Pinned by a test, because getting it wrong fails silently.
The arrowhead is an explicit two-segment `<path>`, **not `marker-end`** — a marker renders a filled
triangle and the canvas draws open stroked barbs. Pencil is a `<polyline>` with round join/cap.
Text uses `dominant-baseline="text-before-edge"` to match the canvas `textBaseline="top"`, and keeps
the font stack rather than converting to paths — so it may re-flow elsewhere, a caveat surfaced in
the export panel itself, not a tooltip.

**PNG.** Rendered offscreen via `Renderer.renderElements` (content only — no background fill, no
grid, no chrome), so exported shapes are drawn by exactly the code that draws them on screen.
`scale` (1x/2x) is applied ONLY when sizing the backing store, per decision #3; bounds math stays
pure world units. **Background is transparent by default** — an export is more often pasted onto
something else than viewed standalone, and transparency can be filled in later while a baked-in
white cannot be removed.

**Size guard.** Browsers cap canvas dimensions (~16384px/side) and, more restrictively, total area.
`checkPngSize` refuses beyond 16384/side or 67,108,864px² (8192²) with `ExportTooLargeError`, rather
than returning a silently blank or truncated image. This is not theoretical: a board of 20
max-legal strokes spans ~10020x15000 world units = ~150M pixels and **is refused** (verified by
e2e). The same board exports to SVG in **2.13 MiB / 700 ms**, which is large but usable — flagged
rather than silently decimated, since decimation is a separate decision.

## Connect-window queue (Phase 4.4b)

The canvas attaches pointer listeners synchronously, but the socket needs a ticket fetch plus a
handshake first — **measured 63-227 ms** in which a user can draw. `RealtimeClient.send()` used to
discard silently, so a shape drawn in that window rendered locally, reached nobody, and vanished on
reload. An e2e test found it; nothing else could have.

**Mutations are queued until the socket opens, then flushed.** Scope, deliberately narrow:
- **Mutations only.** Cursors are never queued — stale on arrival, and a flush would dump a burst.
- **INITIAL CONNECT ONLY**, keyed on `hasEverOpened`. After a disconnect the old drop-then-resync
  behaviour stands; replaying stale mutations across a re-sync that wholesale-replaces the scene and
  clears history needs version reconciliation, which is the offline-queueing deferral. **Pinned by
  `apps/e2e/tests/04-resilience.spec.ts` ("DEFERRAL PINNED", test 15)** so nobody "fixes" it
  without confronting reconciliation — if you make the queue survive reconnects, that test fails.
- **Bounded: 200 ops AND 1 MiB.** The server's rate limiter is per-socket and does not exist yet
  during the connect window; if ticket issuance keeps failing, backoff stretches this to minutes.
- **Overflow drops the NEWEST**, never the oldest — the queue is order-dependent and evicting an
  older op could strand an update whose create was discarded. Dropping the tail leaves a valid prefix.
- **No drop is silent.** `dropped.{overflow,disconnected}` counters, a dev-mode `console.warn`, and
  an `onDropped` handler. The original bug survived precisely because a discarded mutation produced
  no error, no log, and no counter.

**FLUSH ORDERING IS LOAD-BEARING — flush on `done`, never on open.** Traced:
`ws.on("message")` runs `void handleMessage(...)` per frame with **no serialization**, and
`handleJoin` has two awaits before `registry.join` sets `conn.roomId`. Flushing right after `join`
therefore risks (a) `"Join a room first"` rejection, and (b) the create committing after the
snapshot read, so the snapshot lacks it and `applyRemoteSync`'s wholesale replace deletes it locally
— permanently, since the server never echoes a sender its own create. Flushing on `done` makes both
impossible: join is provably complete before the first chunk is sent, and the snapshot is already
applied. `applyRemoteSync(elements, keepIds)` additionally preserves still-queued ids through the
replace.

## Whole-board operations (Phase 4.2)

Two operations touch the entire board. Both used to be expressed as something unbounded.

**Server-side z renormalization** (`zorder.ts`, pure + unit-tested). The client only ever inserts
at the **midpoint** and emits **exactly ONE `elementUpdate`** for the element that moved —
`computeLayerChanges` can no longer return a whole-board rewrite. Each midpoint halves the gap,
so after ~20 nudges it underflows; the server detects this itself:
- On any `elementUpdate` where `zIndex` actually changed, query `{id, zIndex, createdAt}` only
  (served by the `(roomId, zIndex, createdAt)` index — never the `data` payloads) and test
  `minGap < 1e-6`.
- If collapsed, rewrite every changed row in **ONE parameterized `UPDATE … FROM (VALUES …)`** —
  one round trip and all-or-nothing. A partial renumber would reorder the board for everyone.
  Versions bump, so LWW and the client's `>=` guard accept it.
- Broadcast as **N ordinary `elementUpdated`s, never a re-sync.** This is the acceptance
  criterion: `applyRemoteSync` CLEARS the client's undo stack, `applyRemoteUpdate` does not
  touch it, so a routine z-nudge must not destroy anyone's undo history. Pinned by
  `apps/web/lib/canvas/store.test.ts`.
- Server-originated broadcasts bypass the inbound limiter **by construction**: the limiter lives
  in `handleMessage`, reachable only from `ws.on("message")`; `registry.broadcast` calls
  `ws.send` directly.
**Atomic zIndex assignment on create (Phase 4.2b).** `elementCreate` used to do
`SELECT max("zIndex")` then `INSERT max+1` as two statements — concurrent creates read the same
max and wrote the same value. That is not merely a cosmetic tie: **a duplicate lower neighbour
makes the client's midpoint `(lo+z)/2 === z`, so "send backward" silently does nothing.**

Now a plpgsql function (`sketchsync_insert_element`, migration `20260806130000`) takes a per-room
`pg_advisory_xact_lock`, reads the max, and inserts — **in that order, which plpgsql guarantees
and a SQL planner does not.** Renormalization takes the **same** lock (`zLockKey` in
`messages.ts`), so a create can never interleave with a rewrite; a unit test pins the TS key
string against the migration's, because a silent divergence would give them different locks.

Shapes measured and rejected — don't "simplify" back into them:
- **Interactive transaction** (BEGIN/lock/max/insert/COMMIT): correct, but ~5 round trips, and
  since the lock serializes per room that cost is paid sequentially — **468 ms per create**.
- **Single `INSERT … SELECT` with the lock in a MATERIALIZED CTE**: fast but **unsound** —
  nothing forces the lock CTE to evaluate before the MAX read. Measured **138 duplicates in 200
  concurrent creates**.
- Plain `INSERT … SELECT MAX(...)` without a lock is unsound for the original reason: under READ
  COMMITTED the subquery takes no lock.

Why a lock rather than a counter column on `Room`: renormalization rewrites every zIndex, which
would leave a counter stale and require syncing the two on every rewrite. The lock stores nothing.
The lock is held only for the function's in-database work, **not** across a network round trip,
which is why 200 fully-contended creates finish in **1.9 s (9.7 ms each)**. Measured hold time
inside the function: **1.7 ms** for a small rect, **2.9 ms** for a 2500-point stroke, **5.9 ms**
for a max-legal 10000-point stroke. A second socket's small create queued behind a max-legal one
is delayed **79 ms**; sustained per-room throughput is **~150 creates/sec**.

**zIndex on UPDATE is validated too (Phase 4.2c).** Layer actions still compute midpoints on the
client, from a snapshot that may be stale — two clients nudging different elements into the same
gap both compute `(p+q)/2`, which would recreate the duplicates the create lock just eliminated.
So a zIndex-changing `elementUpdate` runs the whole placement under the **same** per-room lock,
in one transaction:
```
lock -> read board once -> LWW re-check -> resolveZ (re-place on collision)
     -> UPDATE -> gap check on the post-update board -> renormalize if needed
```
- **The client's zIndex is ADVISORY**, exactly like `version` and like zIndex on create.
- On collision the server **re-places rather than rejects** — a rejected layer action is a dead
  keystroke. `resolveZ` (pure, unit-tested) picks the midpoint between the colliding value and
  the next distinct neighbour **in the direction the client's value implies**, so intent is kept.
  When no gap is representable it returns the value unchanged and the MIN_GAP check below
  renormalizes, which places the element deterministically.
- The gap check runs **after** re-placement and is computed **in memory** from the same read, so
  the locked section is a single round trip. Doing it as separate queries cost +194 ms per nudge
  (474 → 668 ms); folded, a layer nudge is **492 ms vs a 474 ms pre-lock baseline** — within noise.

**Bounded sync** (`syncChunks.ts`, pure + unit-tested). `maxPayload` governs inbound only; an
outbound snapshot is O(room size). Measured: 50 realistic elements ≈ 77 KiB, 500 ≈ **818 KiB**
(already 80% of 1 MiB), 20 max-legal strokes ≈ **4.5 MiB**. So `sync` carries `seq` + `done` and
is emitted in ordered batches under a **256 KiB** budget. An element bigger than the budget is
emitted alone rather than dropped. The client accumulates and commits **once** on `done` — one
scene swap, one undo clear, no flicker; `seq: 0` restarts a sequence, an out-of-order chunk
discards the partial accumulation, and a disconnect clears it so the re-join re-requests.

**permessage-deflate: measured 4.4× on a sync chunk (238 KB → 53.5 KB), NOT enabled.** Chunking
already fixed the correctness problem; compression is purely bandwidth, and `ws` allocates zlib
contexts per connection (~300 KB each, so ~30 MB at 100 connections, ~300 MB at 1000). Revisit in
Phase 5 with real connection counts; if enabled, use `threshold: 1024` (so 20/s cursor frames
skip it), reduced `memLevel`, and a `concurrencyLimit`.

**Hardening (Phase 4.1).** The gateway is safe to expose publicly:
- `maxPayload` = **1 MiB** — `ws` rejects oversized frames during decode (before any handler)
  and closes **1009**.
- **Per-socket token buckets** (`rateLimit.ts` — pure, no timers; refill computed from elapsed
  time), charged in **two stages**:
  ```
  global bucket (unconditional, PRE-parse) -> JSON.parse -> classify
    -> REFUND global (known type only) -> class bucket -> Zod -> authz -> handle
  ```
  `global` cap 400 @ 60/s · `cursor` cap 40 @ 25/s · `mutation` cap 300 @ 20/s.
- **The global charge is refunded the moment the frame yields a known type** (clamped at
  capacity). **Global's sole responsibility is frames that cannot be CLASSIFIED** — unparseable
  bodies and unknown/non-string types. Don't move the refund later: once a frame is
  classifiable the class bucket owns it, and a class-bucket rejection already scores a
  violation, which closes the socket at 500 — a strictly stronger bound than global draining at
  400 and staying open. Holding the charge past classification only re-couples the buckets, so a
  cursor burst blocks a write the client already rendered. `classOf` returns `null` for
  unclassifiable frames; `KNOWN_CLIENT_TYPES` is pinned to `ClientMessage`'s discriminator
  values by a unit test so it can't drift.
- **Parse failures score a violation directly**, at the same weight as a rate-limit drop.
  Otherwise an unparseable flood only starts scoring once global has drained, delaying
  disconnect by ~400 frames for no benefit. The `Invalid JSON` **reply is sent at most once per
  socket** (`Conn.parseErrorSent`) — the first is useful to a buggy client, the other 400+ before
  the socket closes are attacker-driven outbound work.
- **Mutations are charged BY SIZE**: `cost = max(1, ceil(bytes / 4096))`, from the raw frame
  length taken pre-parse. Cursor and global stay 1/frame. Counting frames alone would admit 20
  max-legal elements/sec, and one max-legal element is ~238 KB that takes ~1.8-7s to persist —
  enough to starve the shared Neon pool for every room on the instance. At 59 tokens each, the
  bucket admits **5 back-to-back** then sustains **~1 per 3s**, which tracks what the DB absorbs.
  `tryConsume` admits a frame costing more than the whole bucket only when the bucket is *full*
  (draining it to zero), so such a frame can never be permanently unsendable; with `maxPayload`
  1 MiB the max cost is 256 < 300, so that path is a guard for future constant changes, not
  live behaviour.
- **Cold-start note.** Admitted bulk throughput (~80 KB/s: 238 KB every ~3s) exceeds *cold*-Neon
  persistence (~32 KB/s — 7.35s measured for the first 238 KB write after idle), so an in-flight
  write queue can grow transiently on the first writes after an idle period. Warm persistence is
  ~1.8s, well inside the admitted rate, so the queue drains on its own. Expected and
  self-correcting — not a bug, and not something to "fix" by lowering the mutation rate.
- **The class is decided from the PARSED `msg.type`, never from the raw bytes.** Classifying by
  substring was unsound: a frame can put `"cursor"` in a field *value* while its type is
  `elementCreate`. Unknown/non-string types fall to the stricter `mutation` bucket.
- The **global** charge is what bounds garbage: unparseable frames and unknown types pay it and
  stop there, so a nonsense flood can never buy unbounded parse work. Consequence to know: a
  cursor flood now drains `global`, so it *can* briefly delay mutations — but a legitimate
  client (20 cursors/s vs 60/s refill) never comes close to draining it.
- Cursor and mutation buckets remain **independent**, so ordinary cursor traffic never starves edits.
- Mutation **capacity is deliberately ≫ refill**: legitimate client code emits synchronous
  bursts (multi-select delete, zIndex renormalization = one update per element in the room).
  Unlike an LWW drop, a rate-limit drop loses a write the server never saw.
- Over-limit frames **drop silently**, logged at most once per socket per 5s. The violation score
  **decays at 10/s**, so it measures *intensity*, not lifetime total — 500 violations in ten
  seconds closes the socket (1008); 500 spread over an eight-hour session never does. State lives
  on `Conn` and is released on close.
- **Content caps are enforced at BOTH ends** from the same `@sketchsync/shared` constants
  (`MAX_PENCIL_POINTS` 10000, `MAX_TEXT_LENGTH` 5000, `MAX_STYLE_STRING` 64). Client-side
  enforcement matters: a receiver-only cap lets the client render and emit an element the server
  rejects, which then persists locally and vanishes on the next sync. `drawSession` freezes a
  stroke at the point ceiling (still committable); the text overlay caps input length.
- A **maximum-legal element fits the transport by construction**: 10000 points serializes to
  ~238 KB (realistic coords) / ~600 KB (worst-case doubles), both under the 1 MiB `maxPayload`.
- `GET /health` on the same HTTP server → `{ ok, connections }` (live socket/limiter count).

## Client canvas engine (apps/web, /canvas)

Modules under `lib/canvas/` (kept separate; hit-testing/geometry/ordering are pure & unit-testable):
- **viewport** — pan/zoom, `screenToWorld`/`worldToScreen`, clamp scale [0.1, 8]. Pure, no DOM.
- **renderer** — two layers: *static* (bg + infinite grid + committed elements) and *overlay*
  (in-progress draft + selection chrome + remote cursors). dpr-aware.
- **input** — pointer/keyboard/wheel → intents (pan / zoom-anchored / draw); nav-lock while editing text.
- **keyboard** — the ONE "is the user typing" predicate (`isTypingElement` / `isTypingNow`),
  shared by the shortcut handler, Input's Space guard and the nav lock. Do not re-inline it.
- **store** (Zustand) — tool, style, `scene: SceneElement[]` (kept sorted by `(zIndex, createdAt)`),
  selectedIds, **command-based** history, `canEdit` (role gate), and an `outbound` sink wired to
  the socket.
- **drawSession / editSession** — draw tools vs select/move/resize. **shapes / geometry / hitTest /
  selectionChrome / layers / history** — pure helpers.
- `lib/realtime/` — **socket** (RealtimeClient: reconnect w/ backoff, re-join+re-sync on reconnect,
  validates incoming, dispatches to store/handlers) and **userColor** (FNV hash → hue).

`SceneElement = { id, version, zIndex, createdAt, data: ElementData }`. Tools: select/rect/ellipse/
line/arrow/pencil/text/pan. Shortcuts: `v r o l a p t h`, Delete, Esc (abort draw, else deselect),
⌘/Ctrl+Z / +Shift+Z / +Y, layer ⌘/Ctrl+`]`/`[` (+Shift = to front/back, bound by `e.code` —
positional; the label is resolved per layout). Presence: stacked coloured initials top-right
(hidden when solo). Read-only clients get `select`/`pan` only, plus a "View only" badge.

Realtime wiring: local commit → optimistic scene update + `outbound` emit. Remote deltas →
`applyRemote{Sync,Create,Update,Delete}` (LWW `>=` guard locally too). Cursors interpolate (lerp) each
frame on the overlay only, prune when stale (5s) or on leave; emit throttled to **50ms** in world coords.

## Key architectural invariants

- **World vs screen coordinates:** element geometry is WORLD; selection chrome, handles, and cursors are
  drawn in SCREEN space (constant on-screen size). Cursors emit/receive WORLD coords so they map to the
  same board spot for everyone regardless of pan/zoom.
- **CSS-px vs device-px:** the Viewport works entirely in **CSS pixels**; dpr is applied only inside the
  Renderer (`ctx.scale(dpr,dpr)` + backing store = CSS×dpr). Never feed device px to world conversions.
- **Server-authoritative:** the server assigns `version` (starts 1) and `zIndex` (roomMax+1) on create;
  clients render optimistically but the server value wins. LWW everywhere is by `version` (`>=`).
- **Shared types once:** all cross-app contracts live in `@sketchsync/shared` (`ElementData`, `Element`,
  `ClientMessage`/`ServerMessage`). Never redefine them per-app.
- **Authz once:** `getMembership`/`roleAtLeast`/`ROLE_RANK` live in `@sketchsync/db`; api + realtime both import them.
- **Client role checks are UX, never security.** `canEdit` in the canvas store stops a VIEWER
  rendering work the server will refuse; the gateway's `canWrite` is the authority and must stay.
  The web app cannot import `ROLE_RANK` (Prisma-backed, server-only), so it re-states the rank
  comparison inline — that duplication is deliberate and is called out at both sites.
- **Token logic once:** `AUTH_COOKIE`/`signToken`/`verifyToken` live in `@sketchsync/auth`. NOT in
  `shared` (browser-imported — would ship `jsonwebtoken` to the client), NOT in `db` (would make
  token checks depend on Prisma). `verifyToken(token, secret)` takes a RAW STRING and is
  transport-agnostic on purpose: cookie today, `Sec-WebSocket-Protocol` ticket in 3b, same call.
  Reasoning is in `packages/auth/README.md` so it isn't "simplified" back. Browser-facing protocol
  constants (e.g. `WS_TICKET_PROTOCOL`) go in `shared`, never in `auth`.
- **The socket never authenticates with a cookie.** Ticket only, verified at the upgrade, with an
  Origin allowlist. No fallback path — see Phase 4.3b.
- **Browser talks only to its own origin** for HTTP (`/api/*` rewrite). Never reintroduce a
  direct-to-API base URL, in dev or prod — that divergence is what hid the cross-site cookie bug.
- **No new WS message types:** new element state (e.g. zIndex) rides on `elementUpdate`.
- **Ephemeral cursors:** never persisted, never in the scene array, never in undo history.
- **Undo is local-only and id-scoped:** command-based history records only the ids the local user changed,
  so undo never reverts a remote edit (and it does not broadcast — a re-sync restores server truth).
- **Optimistic:** the drawing user never waits on the network to see their own stroke.
- **Auth state is server-verified, not response-derived.** Signin/signup still `setUser()`
  optimistically (no round trip, no flash) but immediately fire `refresh()`, so a session that
  didn't actually stick self-corrects within one round trip instead of rendering an authenticated
  shell full of 401s. In `AuthProvider`, **only a 401 clears the user**; any other failure sets
  `error` and leaves the session intact, and `Protected` renders a "Can't reach SketchSync" panel
  with a Try again button rather than bouncing to `/signin` — where the user would try to log in
  against the same dead API.

## Testing / verification

**Vitest** is wired at the repo root (`pnpm test` → `turbo run test`). Checked-in suites (**143 tests**)
cover the security- and correctness-relevant logic:
- `apps/realtime/src/upgradeAuth.test.ts` — the Origin allowlist (scheme/port/trailing-slash/`null`
  all rejected; absent allowed for non-browser clients) and the `Sec-WebSocket-Protocol` parser
  (marker order enforced, no ticket leaked into the hash).
- `apps/api/src/auth/ticketLimiter.test.ts` — issuance burst/refill, per-user isolation, a realistic
  reconnect flurry passing, and a hostile loop bounded to the refill rate.
- `apps/realtime/src/zlock.test.ts` — the advisory-lock key string is pinned against the
  migration's, so create and renormalize can never end up on different locks.
- `apps/realtime/src/zorder.test.ts` — renormalization trigger threshold (strict `<`, anchored so
  the float boundary is exact), order preserved exactly across a rewrite, only-changed-rows
  emitted, 400-element board, and `resolveZ` collision re-placement (direction preserved, never
  returns a colliding value, the two-client same-gap race).
- `apps/realtime/src/syncChunks.test.ts` — chunk boundary math, order across boundaries,
  over-budget element emitted alone, every chunk under the 1 MiB cap.
- `apps/web/lib/canvas/store.test.ts` — **undo survives renormalization** (the acceptance
  criterion), a full sync still clears it, a layer action emits exactly one outbound op, the
  style preview/commit split (a whole colour drag = one history entry, one emit, one version bump),
  and the **read-only role gate**: with `canEdit=false` every mutating action is a no-op across
  scene, history AND the outbound sink, only `select`/`pan` are reachable, and remote deltas still
  apply (read-only is not disconnected).
- `apps/web/lib/roomName.test.ts` — the shared board-name bounds (trim-then-measure, 1..80).
- `apps/web/lib/canvas/export.test.ts` — arrowhead geometry pinned against the pre-extraction
  formula (so the refactor is provably visual-no-op), ink/union bounds incl. empty and zero-area
  cases, SVG viewBox in world units, stroke-width passthrough, and the PNG size guard.
- `apps/realtime/src/rateLimit.test.ts` — refill math on a synthetic clock, burst-then-sustain,
  bucket independence, the global bucket, misclassification, size-weighted cost, refund clamping,
  cost>capacity, violation decay, the `KNOWN_CLIENT_TYPES` drift guard, and the `lastWarnMs`
  sentinel regression.
- `apps/realtime/src/messages.test.ts` — the real `handleMessage` pipeline against a stub socket.
  Every path it exercises (bad JSON, bad schema, "join a room first") stops before authz touches
  Prisma, so **no DB is needed** — which is exactly where the refund policy lives. The key pair:
  a 450-frame *class-rejected* flood leaves global untouched, while a 450-frame *unparseable*
  flood depletes it.

Pure helpers are the right thing to pin here; add to these suites rather than writing throwaway
scripts for them.

Integration checks that need live servers + Neon (WS floods, oversized frames, socket-state
release) are still scripted `tsx` throwaways, run then deleted — they can't run in CI as-is.

## End-to-end browser suite (`pnpm test:e2e`)

**MANUAL BROWSER VERIFICATION IS RETIRED.** This suite is the gate. 27 tests,
**~4.4-7.4 min**, Playwright + headless Chromium, `workers: 1` (the tests share one database
and one gateway). Was 21 tests / 3.2-5.7 min before 4.7.

**KNOWN FLAKE, not yet explained — do not assume a red run is a real regression until you
have re-run.** Across three unperturbed full runs at 4.7 (7.4 min pass, 7.1 min fail, 4.4 min
pass) one run failed with `waitForCanvas`'s **30 s `page.waitForSelector("canvas")` ceiling**
expiring in a `beforeAll`. The failure snapshot shows the board **fully rendered**, and both
affected files pass in isolation, so it is the harness running out of patience under load
rather than a product defect. The timeout has deliberately **NOT** been raised: bumping a
number until a symptom stops is how a suite quietly stops testing. If it recurs, find out why
the page load exceeded 30 s — the run-to-run spread (4.4 vs 7.4 min for identical work)
suggests machine load, not the app.

- **Two browser CONTEXTS**, never two tabs — tabs share a cookie jar and cannot represent two users.
- **Fixtures** (`fixtures/seed.ts`) hit the API and DB directly, never the UI. Users are created
  through the web origin's `/api` proxy so the cookie is attributed exactly as a browser's is;
  elements are seeded by calling the **same `sketchsync_insert_element` plpgsql function the gateway
  uses**, keeping the advisory-lock zIndex invariants identical and bypassing a rate limiter that is
  irrelevant to seeding. `addMember(user, room, role)` writes the `RoomMember` row directly —
  **there is no HTTP route that grants VIEWER**, since the only join path is the open share link
  and it always grants EDITOR.
- **`globalSetup` absorbs cold start** — Neon wake (~850 ms), the proxied API path, and Next's
  per-route dev compile (**board route ~7-12 s**). Paying that in setup is what stops the suite
  failing only on the first run of the day.
- **Runtime control:** contexts and pages are created once per file and reused. A board load costs
  4-6 s, so per-test loads dominated the first draft.
- Assertions read a **build-gated, read-only hook** (`NEXT_PUBLIC_E2E=1`, `lib/canvas/testHook.ts`).
  The scene lives in a module-scoped Zustand store and never reaches the DOM, so there is no other
  way to assert "did this element arrive in the other client". The hook exposes getters plus one
  deliberate exception, `dropSocket()`, because Chromium's CDP offline emulation does **not** tear
  down an established WebSocket.

**THREE FIXED DELAYS ARE LOAD-BEARING. Do not "clean them up" into waits.**
- **Gap test holds `/auth/ws-ticket` open for 3 s** (`page.route`). The real connect window is
  63-227 ms — shorter than Playwright's own navigation overhead — so without the hold the draw
  always lands *after* the socket opens and the test passes while never exercising the condition
  it exists to check. It first shipped in exactly that vacuous state. The test now also asserts
  `socketOpen() === false` at draw time, so it can never silently regress to that again.
- **Deferral test waits 5 s before asserting absence.** It is proving something does NOT arrive,
  and there is no event for that; 5 s is ~10x observed propagation. It also blocks ticket issuance
  for the whole draw and asserts the socket is down at commit time — reconnect backoff is 500 ms
  while a multi-step drag takes longer, so otherwise the shape can commit after the socket is
  already back and the test races itself into a false pass. It also uses its OWN room, because
  other tests in that file draw while disconnected and whether those land is timing-dependent.
- **Test 18 (20 max-legal strokes) allows 180 s per download and 300 s for the test.** Seeding
  200k points and serializing them is genuinely slow; the point is to MEASURE it, and a tighter
  timeout would hide the number rather than reveal a regression.

**Harness traps found the hard way** — each cost a debugging cycle:
- **React keeps its own value tracker.** Assigning `input.value = x` then dispatching `input`
  does NOT fire React's `onChange` — React sees no change and skips it. Go through
  `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set`, as a real
  interaction does. This silently made a colour-drag test measure nothing.
- **CDP offline emulation does not tear down an ESTABLISHED WebSocket.**
  `Network.emulateNetworkConditions({offline:true})` affects new requests only, so reconnect
  tests hung. Hence `dropSocket()` on the test hook — the one deliberate non-getter.
- **`waitForScene` returns its last value instead of throwing on timeout.** A failed draw
  therefore looks like a passing wait, and the failure surfaces later as a confusing `undefined`.
  Assert the returned length explicitly after calling it.
- **Locator ambiguity in the export panel:** `getByRole("button", {name:"SVG"})` matches both the
  format toggle and the "Export SVG" run button. The panel uses `data-testid` throughout.

**What the suite does NOT cover** — assume these are unverified:
- **No screenshot/visual regression.** Canvas AA and text metrics are platform-dependent, and the
  board renders a live zoom/world readout plus rAF-animated cursors, so full-frame baselines would
  be platform-locked and permanently noisy. Rendering is only asserted indirectly (element present
  in the store). A shape could render *wrongly* and pass.
- **Chromium only.** No Firefox, no WebKit, no mobile/touch input.
- **Cross-origin is not exercised here.** The suite runs everything on `localhost`; the
  genuinely-cross-origin socket path was verified by throwaway script in 4.3b.
- **No load/soak.** Rate limiters, oversized frames, renormalization bursts, and the 200-concurrent-
  create race are covered by unit tests and throwaway scripts, not here.
- **No real service kill.** API/gateway failure is simulated with `page.route`/`dropSocket`, not by
  stopping processes — they are shared across the run.
- **Multi-tab same-user** is untested. (VIEWER restrictions and the rooms-list UI are covered as
  of 4.7 — see `07-states.spec.ts`.)
- **No keyboard-layout coverage.** The bracket-label resolution
  (`navigator.keyboard.getLayoutMap()`) is exercised only on the runner's US layout, so the
  non-US path and the Firefox/Safari fallback are unverified by test.
- **`role="alert"` is asserted as an attribute, never as an announcement.** No screen reader
  is driven; the live-region behaviour is assumed, not measured.

`apps/e2e/tests/07-states.spec.ts` covers the 4.7 states: a VIEWER is told why and commits
nothing (draw AND move), a dropped socket shows the indicator and clears when it returns, an
offline mutation raises a toast whose count agrees with `dropped.disconnected`, Escape closes
the export panel **without** clearing the selection (and `r` does not reach the canvas while it
is open, and focus returns to the trigger), and a failed `/rooms` load renders as a failure
rather than as an empty account.

Baseline gate: `pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm test:e2e`.
Collaboration is verified by the e2e suite, not by hand.

**Windows note:** `prisma generate` (run by `db`'s typecheck) fails with `EPERM … query_engine`
while `pnpm dev` is running — the running servers hold the DLL open. Stop dev servers before a
full `pnpm typecheck`, or typecheck `db` with `pnpm exec tsc --noEmit` directly.

## What's next

- ~~No web auth/room UI~~ **done (Phase 3.5)** — `/signup`, `/signin` (with `?next=` deep-link
  return), `/rooms`, and `/room/[slug]` with a join screen for non-members. `/canvas` redirects
  to `/rooms`. Auth state comes from one `GET /auth/me` via `AuthProvider`; `Protected` gates
  the app routes; all HTTP goes through `lib/api/client.ts`.
- **Phase 4:** ~~step 1 — gateway hardening (rate limits + payload caps)~~ **done**. Next:
  performance — batch/coalesce WS writes (currently persisted immediately, one row per edit).
  Coalescing would also shrink the renormalization burst the mutation bucket is sized for.
- ~~Phase 4 step 3b — WebSocket ticket auth~~ **done.** Cross-origin sockets verified end to end.
- ~~Phase 4 step 7 — connection status, VIEWER role, keyboard collisions~~ **done (4.7).**
  **Phase 4 is complete.**
- **Phase 5:** deployment — switch Neon to a pooled connection (`?pgbouncer=true` + Prisma `directUrl`
  for migrations); deploy near ap-southeast-1.
- **Phase 5, deferred from 4.7 (deliberately out of scope, not forgotten):** select-all,
  copy/paste, duplicate, arrow-key nudge, zoom-to-fit, a `?` shortcuts overlay, and Shift
  shape constraints (Shift currently reaches `EditSession` only — `DrawSession.begin` is
  called without mods, so there is no square/circle/45°-line constraint).
- **Known limitations (flagged):**
  - Simultaneous same-version edits of the *same* element can briefly diverge (needs a
    tiebreaker/server-monotonic versions — no CRDT by design).
  - **Mutations made while DISCONNECTED are dropped, not replayed** on reconnect. The connect-window
    queue is initial-connect only; replaying across a re-sync needs version reconciliation. Pinned
    by an e2e test so it cannot be "fixed" accidentally.
  - Undo doesn't propagate to other clients. It's also id-scoped and stores whole elements, so
    undoing a local command after a remote renormalization can momentarily restore a stale
    zIndex; undo never broadcasts, so the next server update corrects it.
  - ~~Concurrent creates can tie on zIndex; `createdAt` breaks it but clock skew means brief
    disagreement~~ **FIXED, not merely accepted.** Creates are serialized by a per-room
    `pg_advisory_xact_lock` inside a plpgsql function (4.2b), and zIndex-changing updates are
    validated and re-placed under the same lock (4.2c). 200 fully-concurrent creates yield 200
    distinct values; two clients targeting the same gap end up distinct and stably ordered.
    Historical damage (302 rows across 5 rooms) was repaired once by migration `20260806120000`.
    **Ordering therefore no longer depends on the `createdAt` tiebreak for correctness** — zIndex
    alone is now unique per room in practice. `compareZ` keeps `(zIndex, createdAt, id)` as a
    total order so sorting is deterministic regardless, and so renormalization has a defined
    result if a tie ever does appear, but no clock is load-bearing.
  - Renormalization broadcasts N updates when gaps collapse. With the create race fixed, N is
    now **1** in practice (only the displaced element moves) — the old 149/399-element bursts
    were duplicate-zIndex damage being repaired, not normal behaviour.
  - **There is no true no-access state for a board.** `GET /rooms/:slug` returns 403 for any
    non-member, and the client renders that as "Join this board?" — so *every* 403 is treated
    as an invitation, and `POST /rooms/:slug/join` always grants **EDITOR**. A private board is
    therefore not expressible: anyone with the slug can join and edit. VIEWER exists in the
    schema and is now honoured by the UI (4.7), but nothing can *create* one except a direct DB
    write. Flagged deliberately in 4.7 rather than fixed — proper sharing (invite-only rooms,
    role on invite, a real 403 screen) is its own piece of work.
  - **Toasts are not persisted or queued.** A drop that happens while the tab is hidden shows a
    toast that may auto-dismiss unseen; the connection pill is the durable signal, the toast is
    the interrupt.

## Conventions

- **TypeScript strict everywhere.** No `any` escape hatches. ESLint 9 flat config.
- **Zod for ALL input validation** (HTTP bodies, WS messages, env). Derive TS types with `z.infer`.
- Keep the socket layer separate from the render engine (socket dispatches state; renderer draws).
  Hit-testing/geometry/ordering are pure functions. Don't collapse modules into a god-class.
- Commit `.env.example`, never `.env`. Run migrations with `migrate deploy` (never `migrate dev`) against Neon.
