-- One-off data repair for duplicate zIndex values.
--
-- Cause: `elementCreate` assigned zIndex with a non-atomic aggregate-then-insert
-- (`SELECT max(zIndex)` then `INSERT max+1`). Concurrent creates read the same
-- max and wrote the same value. Fixed going forward by taking a per-room
-- pg_advisory_xact_lock around the read+write (apps/realtime/src/messages.ts).
--
-- Server-side renormalization repairs a room, but only when a zIndex-CHANGING
-- update arrives — and in an affected room "send backward" is a silent no-op,
-- because the midpoint of two equal neighbours is that same value. So rooms
-- already damaged would never self-heal. This pass repairs them once.
--
-- Renumbers each room's live elements to a clean 1..N using EXACTLY the render
-- order (zIndex, createdAt, id) shared by apps/realtime/src/zorder.ts and
-- apps/web/lib/canvas/layers.ts, so no board is visually reordered. The version
-- bump makes connected clients accept the new values under LWW.

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "roomId"
      ORDER BY "zIndex" ASC, "createdAt" ASC, "id" ASC
    ) AS rn
  FROM "Element"
  WHERE "deleted" = false
)
UPDATE "Element" AS e
SET "zIndex"    = ranked.rn,
    "version"   = e."version" + 1,
    "updatedAt" = NOW()
FROM ranked
WHERE e."id" = ranked."id"
  AND e."zIndex" <> ranked.rn;
