import { WebSocket } from "ws";
import {
  ClientMessage,
  PENCIL_POINTS_WARN,
  type Element,
  type ElementData,
  type ElementInput,
  type ServerMessage,
} from "@sketchsync/shared";
import {
  Prisma,
  Role,
  getMembership,
  prismaClient,
  roleAtLeast,
  type Element as ElementRow,
} from "@sketchsync/db";
import type { Conn, RoomRegistry } from "./registry.js";
import { chunkElements } from "./syncChunks.js";
import {
  compareZ,
  needsRenormalize,
  renormalize,
  resolveZ,
  type ZRow,
} from "./zorder.js";
import {
  checkClass,
  checkGlobal,
  classOf,
  penalize,
  refundGlobal,
  type RateLimitDecision,
} from "./rateLimit.js";

// ---------------------------------------------------------------------------
// send helpers
// ---------------------------------------------------------------------------
function send(conn: Conn, message: ServerMessage): void {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  try {
    conn.ws.send(JSON.stringify(message));
  } catch {
    // ignore
  }
}

function sendError(conn: Conn, message: string): void {
  send(conn, { type: "error", message });
}

/** Map a DB row to the shared wire Element shape. */
function toWire(row: ElementRow): Element {
  return {
    id: row.id,
    roomId: row.roomId,
    data: row.data as unknown as ElementData,
    version: row.version,
    createdBy: row.createdBy,
    zIndex: row.zIndex,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deleted: row.deleted,
  };
}

function asJson(data: ElementData): Prisma.InputJsonValue {
  return data as unknown as Prisma.InputJsonValue;
}

/**
 * Serialize every operation that reads-then-writes a room's zIndex space.
 *
 * `pg_advisory_xact_lock` is held for the rest of the transaction and released
 * automatically on commit OR rollback — no cleanup path to get wrong. Keyed on
 * a hash of the roomId, so rooms never block each other.
 *
 * Why a lock and not a counter column on Room: renormalization rewrites every
 * zIndex in the room, which would leave a counter stale (pointing above or
 * below the real max) and require keeping the two in sync on every rewrite.
 * The lock has no such coupling — it orders the operations and stores nothing.
 *
 * Why not fold the aggregate into `INSERT ... SELECT MAX(...)`: under READ
 * COMMITTED the subquery takes no lock, so two concurrent inserts still read
 * the same MAX and still collide. Folding it is not a fix.
 */
export function zLockKey(roomId: string): string {
  return `sketchsync:zindex:${roomId}`;
}

async function lockRoomZ(tx: Prisma.TransactionClient, roomId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${zLockKey(roomId)})::bigint)`;
}

/** Transaction budget: the lock serializes per room, so allow for a queue. */
const Z_TX_OPTIONS = { timeout: 20_000, maxWait: 15_000 } as const;

/** True if the socket has joined a room AND may write (EDITOR or higher). */
function canWrite(conn: Conn): boolean {
  return conn.roomId !== null && conn.role !== null && roleAtLeast(conn.role, Role.EDITOR);
}

/**
 * An oversized-but-ACCEPTED stroke. Logged (warn, never error — the write still
 * succeeds) so we can tell from production whether point decimation is worth
 * building. A real 3s stroke samples ~180-360 points; this fires far above that.
 */
function warnIfLargePencil(conn: Conn, id: string, data: ElementData): void {
  if (data.type !== "pencil" || data.points.length <= PENCIL_POINTS_WARN) return;
  console.warn(
    `large pencil accepted: ${data.points.length} points ` +
      `(warn>${PENCIL_POINTS_WARN}) element=${id} user=${conn.userId} room=${conn.roomId}`,
  );
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------
async function handleJoin(
  conn: Conn,
  registry: RoomRegistry,
  roomId: string,
): Promise<void> {
  // The socket only CHECKS membership (created via HTTP POST /rooms/:slug/join).
  const role = await getMembership(conn.userId, roomId);
  if (!role) {
    sendError(conn, "You are not a member of this room");
    return;
  }

  // Attach identity for presence (fetch once; the user exists — they're a member).
  const user = await prismaClient.user.findUnique({
    where: { id: conn.userId },
    select: { name: true, avatarUrl: true },
  });
  conn.name = user?.name ?? "Anonymous";
  conn.avatarUrl = user?.avatarUrl ?? null;

  registry.join(roomId, conn);
  conn.role = role;

  const rows = await prismaClient.element.findMany({
    where: { roomId, deleted: false },
    // Controllable stacking order; createdAt is the deterministic tiebreak.
    orderBy: [{ zIndex: "asc" }, { createdAt: "asc" }],
  });

  // CHUNKED: a room can exceed any single-frame budget. Ordered batches, and
  // the client commits the scene once when `done` arrives (no partial swap).
  const chunks = chunkElements(rows.map(toWire));
  if (chunks.length === 0) {
    send(conn, { type: "sync", elements: [], seq: 0, done: true });
  } else {
    chunks.forEach((elements, i) => {
      send(conn, { type: "sync", elements, seq: i, done: i === chunks.length - 1 });
    });
  }

  // Presence: tell everyone (including the joiner) who's now in the room.
  registry.broadcast(roomId, { type: "presence", users: registry.getPresence(roomId) });
}

async function handleCreate(
  conn: Conn,
  registry: RoomRegistry,
  element: ElementInput,
): Promise<void> {
  if (conn.roomId === null) return sendError(conn, "Join a room first");
  if (!canWrite(conn)) return sendError(conn, "You do not have permission to edit");

  warnIfLargePencil(conn, element.id, element.data);

  // Server assigns version = 1 AND zIndex = (room max) + 1 AUTHORITATIVELY;
  // any client-sent version/zIndex is advisory and ignored — the same contract
  // `version` has always had.
  //
  // The read and the write MUST be one atomic unit. Without the advisory lock
  // two concurrent creates both read the same max and both write max+1, giving
  // duplicate stacking order — and a duplicate lower neighbour makes the
  // client's midpoint (lo+z)/2 === z, so "send backward" silently does nothing.
  //
  // Delegated to a plpgsql function (migration 20260806130000) that takes the
  // per-room advisory lock, reads the max, and inserts — IN THAT ORDER, which
  // plpgsql guarantees and a SQL planner does not. One round trip.
  //
  // Two cheaper-looking shapes were measured and rejected; see the migration.
  // In short: an interactive transaction is correct but ~5 round trips (~468ms
  // per create once serialized), and a single INSERT ... SELECT with the lock
  // in a MATERIALIZED CTE is fast but unsound (138 duplicates in 200 creates),
  // because nothing forces the lock CTE to run before the MAX read.
  const roomId = conn.roomId;
  const rows = await prismaClient.$queryRaw<ElementRow[]>`
    SELECT * FROM "sketchsync_insert_element"(
      ${element.id}::uuid,
      ${roomId}::uuid,
      ${element.data.type},
      ${JSON.stringify(element.data)}::jsonb,
      ${conn.userId}::uuid
    )
  `;
  const row = rows[0];
  if (!row) return sendError(conn, "Could not create element");
  registry.broadcast(conn.roomId, { type: "elementCreated", element: toWire(row) }, conn);
}

/**
 * Whole-board z-order repair, run INSIDE the caller's transaction so it shares
 * the per-room advisory lock. Fires when the float gaps have collapsed too far
 * to keep inserting midpoints.
 *
 * The rewrite is one statement, so it is all-or-nothing: a partial renumber
 * would reorder the board for everyone. Versions bump, so LWW and the client's
 * `>=` guard accept it.
 *
 * Callers broadcast the result as N ordinary `elementUpdated` messages, never a
 * re-sync: `applyRemoteSync` CLEARS the client's undo stack while
 * `applyRemoteUpdate` does not touch it, and a routine z-nudge must not destroy
 * anyone's undo history.
 *
 * Returns the rewritten rows, or null when the board is healthy.
 */
async function renormalizeInTx(
  tx: Prisma.TransactionClient,
  roomId: string,
  board: readonly ZRow[],
): Promise<ElementRow[] | null> {
  // `board` is the caller's already-fetched view with the pending change
  // applied, so this costs no extra round trip. Sorted defensively because
  // minGap assumes ordered input.
  const rows = [...board].sort(compareZ);
  if (!needsRenormalize(rows)) return null;

  const assignments = renormalize(rows);
  if (assignments.length === 0) return null;

  const values = Prisma.join(
    assignments.map((a) => Prisma.sql`(${a.id}::uuid, ${a.zIndex}::double precision)`),
  );
  await tx.$executeRaw`
    UPDATE "Element" AS e
    SET "zIndex" = v.z, "version" = e."version" + 1, "updatedAt" = NOW()
    FROM (VALUES ${values}) AS v(id, z)
    WHERE e."id" = v.id
  `;
  return tx.element.findMany({
    where: { id: { in: assignments.map((a) => a.id) } },
    orderBy: [{ zIndex: "asc" }, { createdAt: "asc" }],
  });
}

async function handleUpdate(
  conn: Conn,
  registry: RoomRegistry,
  id: string,
  data: ElementData,
  zIndex: number,
  version: number,
): Promise<void> {
  if (conn.roomId === null) return sendError(conn, "Join a room first");
  if (!canWrite(conn)) return sendError(conn, "You do not have permission to edit");

  const current = await prismaClient.element.findUnique({ where: { id } });
  if (!current || current.roomId !== conn.roomId) {
    return sendError(conn, "Element not found");
  }
  if (current.deleted) return; // gone; ignore
  if (version < current.version) return; // stale write — drop silently

  warnIfLargePencil(conn, id, data);
  const roomId = conn.roomId;

  // Content-only edit (move / resize / restyle): NO lock. Two people dragging
  // different shapes must never serialize against each other.
  if (current.zIndex === zIndex) {
    const row = await prismaClient.element.update({
      where: { id },
      data: { type: data.type, data: asJson(data), zIndex, version },
    });
    registry.broadcast(roomId, { type: "elementUpdated", element: toWire(row) }, conn);
    return;
  }

  // zIndex CHANGED -> placement is server-authoritative, exactly like `version`
  // and like zIndex on create. The client's value is ADVISORY: it is computed
  // as a midpoint from a snapshot that may already be stale, so two clients can
  // propose the same value for different elements. Everything below runs under
  // the SAME per-room advisory lock as create, in ONE transaction: re-place on
  // collision, then the gap check, then renormalization if needed — in that
  // order, so the gap check sees the value we actually stored.
  const result = await prismaClient.$transaction(async (tx) => {
    await lockRoomZ(tx, roomId);

    // ONE read serves all three needs below — the LWW re-check, the collision
    // scan, and the gap check — so the locked section is a single round trip.
    // ids + ordering columns only, served by the (roomId, zIndex, createdAt)
    // index; never the `data` payloads.
    const board = await tx.element.findMany({
      where: { roomId, deleted: false },
      select: { id: true, zIndex: true, createdAt: true, version: true },
      orderBy: [{ zIndex: "asc" }, { createdAt: "asc" }],
    });

    // Re-checked under the lock: another layer action may have landed since the
    // unlocked read above. Absent here means deleted.
    const self = board.find((r) => r.id === id);
    if (!self) return null;
    if (version < self.version) return null; // stale write — drop silently

    const placed = resolveZ(
      board.filter((r) => r.id !== id).map((r) => r.zIndex),
      zIndex,
      self.zIndex,
    );

    const row = await tx.element.update({
      where: { id },
      data: { type: data.type, data: asJson(data), zIndex: placed, version },
    });

    // Gap check runs AFTER re-placement, on the board as it now stands —
    // derived in memory from the read above rather than re-querying.
    const post = board.map((r) => (r.id === id ? { ...r, zIndex: placed } : r));
    const renormalized = await renormalizeInTx(tx, roomId, post);
    return { row, renormalized };
  }, Z_TX_OPTIONS);

  if (!result) return; // stale or deleted
  const { row, renormalized } = result;

  if (renormalized) {
    console.warn(`renormalized room=${roomId}: ${renormalized.length} elements renumbered`);
    // No `exclude`: every client's optimistic zIndex is stale now, the
    // initiator's included.
    for (const r of renormalized) {
      registry.broadcast(roomId, { type: "elementUpdated", element: toWire(r) });
    }
    // The renumber only carries elements whose zIndex CHANGED. If this
    // element's data changed but its zIndex happened to land on its existing
    // slot, it isn't in that burst and others would never see the edit.
    if (!renormalized.some((r) => r.id === row.id)) {
      registry.broadcast(roomId, { type: "elementUpdated", element: toWire(row) }, conn);
    }
    return;
  }
  registry.broadcast(roomId, { type: "elementUpdated", element: toWire(row) }, conn);
}

async function handleDelete(
  conn: Conn,
  registry: RoomRegistry,
  id: string,
  version: number,
): Promise<void> {
  if (conn.roomId === null) return sendError(conn, "Join a room first");
  if (!canWrite(conn)) return sendError(conn, "You do not have permission to edit");

  const current = await prismaClient.element.findUnique({ where: { id } });
  if (!current || current.roomId !== conn.roomId) {
    return sendError(conn, "Element not found");
  }
  if (current.deleted) return; // already deleted
  if (version < current.version) return; // stale — drop silently

  await prismaClient.element.update({
    where: { id },
    data: { deleted: true, version },
  });
  registry.broadcast(conn.roomId, { type: "elementDeleted", id }, conn);
}

function handleCursor(
  conn: Conn,
  registry: RoomRegistry,
  x: number,
  y: number,
): void {
  if (conn.roomId === null) return sendError(conn, "Join a room first");
  // Cursors are ephemeral — never persisted. Viewers may broadcast cursors too.
  registry.broadcast(
    conn.roomId,
    { type: "cursor", userId: conn.userId, x, y },
    conn,
  );
}

/**
 * Leave the current room and refresh presence for the remaining clients. Also
 * used on socket close/disconnect. Presence dedupes by userId, so a user with
 * another tab still open stays listed until their LAST socket leaves.
 */
export function handleLeave(conn: Conn, registry: RoomRegistry): void {
  const roomId = conn.roomId;
  registry.leave(conn);
  if (roomId) {
    registry.broadcast(roomId, {
      type: "presence",
      users: registry.getPresence(roomId),
    });
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------
/**
 * Act on a limiter decision. Returns true when the frame may proceed. Over-limit
 * frames are dropped SILENTLY (consistent with the LWW silent-drop), logged at
 * most once per socket per 5s, and disconnect the socket once the decaying
 * violation score exceeds the ceiling. Shared by all three buckets.
 */
function noteViolation(conn: Conn, decision: RateLimitDecision): void {
  if (decision.warn) {
    console.warn(
      `rate limit: dropped frame(s) from user=${conn.userId} ` +
        `room=${conn.roomId ?? "-"} score=${decision.violations.toFixed(1)}`,
    );
  }
  if (decision.disconnect) conn.ws.close(1008, "policy violation");
}

function applyLimit(conn: Conn, decision: RateLimitDecision): boolean {
  if (decision.allowed) return true;
  noteViolation(conn, decision);
  return false;
}

export async function handleMessage(
  conn: Conn,
  registry: RoomRegistry,
  raw: string,
): Promise<void> {
  // Order: global -> JSON.parse -> classify -> REFUND global (known type only)
  // -> class bucket -> Zod -> authz -> handle.
  //
  // The global charge is unconditional and pre-parse, so garbage floods are
  // bounded. It is refunded the moment the frame yields a known type, because
  // from there the class bucket owns it — and a class-bucket rejection already
  // counts a violation, which closes the socket at 500. Only UNCLASSIFIABLE
  // frames (bad JSON, unknown/non-string type) keep the charge; nothing
  // downstream would otherwise account for them.
  const now = Date.now();
  const bytes = Buffer.byteLength(raw, "utf8");
  if (!applyLimit(conn, checkGlobal(conn.rate, now))) return;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Unparseable is abuse in its own right — count it at full weight rather
    // than waiting for the global bucket to drain first.
    noteViolation(conn, penalize(conn.rate, now));
    // Reply AT MOST ONCE per socket: the first is genuinely useful to a buggy
    // client, every one after that is attacker-driven outbound work.
    if (!conn.parseErrorSent) {
      conn.parseErrorSent = true;
      sendError(conn, "Invalid JSON");
    }
    return; // keeps the global charge
  }

  const cls = classOf((json as { type?: unknown } | null)?.type);
  if (cls === null) {
    // Unknown/non-string type: keeps the global charge, and still pays the
    // stricter mutation bucket before Zod rejects it.
    if (!applyLimit(conn, checkClass(conn.rate, "mutation", now, bytes))) return;
  } else {
    refundGlobal(conn.rate);
    if (!applyLimit(conn, checkClass(conn.rate, cls, now, bytes))) return;
  }

  const parsed = ClientMessage.safeParse(json);
  if (!parsed.success) {
    return sendError(conn, "Invalid message");
  }
  const msg = parsed.data;

  try {
    switch (msg.type) {
      case "join":
        await handleJoin(conn, registry, msg.roomId);
        break;
      case "leave":
        if (conn.roomId === msg.roomId) handleLeave(conn, registry);
        break;
      case "elementCreate":
        await handleCreate(conn, registry, msg.element);
        break;
      case "elementUpdate":
        await handleUpdate(conn, registry, msg.id, msg.data, msg.zIndex, msg.version);
        break;
      case "elementDelete":
        await handleDelete(conn, registry, msg.id, msg.version);
        break;
      case "cursor":
        handleCursor(conn, registry, msg.x, msg.y);
        break;
    }
  } catch (err) {
    // A bad message must never take down the server or other clients.
    console.error("message handler error:", err instanceof Error ? err.message : err);
    sendError(conn, "Internal error");
  }
}
