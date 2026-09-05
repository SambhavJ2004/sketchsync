-- Atomic, serialized zIndex assignment for element creation.
--
-- The old path was `SELECT max("zIndex")` then `INSERT max+1` as two statements:
-- concurrent creates read the same max and wrote the same value, producing
-- duplicate stacking order. A duplicate lower neighbour also makes the client's
-- midpoint (lo+z)/2 === z, so "send backward" silently does nothing.
--
-- Two approaches were measured and rejected before this one:
--   * An interactive transaction (BEGIN / lock / max / insert / COMMIT) is
--     correct but costs ~5 network round trips, and because the lock serializes
--     creates per room that cost is paid sequentially: ~468ms per create.
--   * A single INSERT ... SELECT with the lock in a MATERIALIZED CTE is fast but
--     UNSOUND — the planner does not guarantee the CTE holding the lock is
--     evaluated before the MAX read. Measured 138 duplicates in 200 creates.
--     (Plain INSERT ... SELECT MAX(...) without a lock is unsound for the same
--     reason it always was: under READ COMMITTED the subquery takes no lock.)
--
-- plpgsql executes its statements in order, so the lock is provably held before
-- the read: correct AND one round trip.

CREATE OR REPLACE FUNCTION "sketchsync_insert_element"(
  p_id      uuid,
  p_room    uuid,
  p_type    text,
  p_data    jsonb,
  p_creator uuid
) RETURNS SETOF "Element"
LANGUAGE plpgsql
AS $$
DECLARE
  v_z double precision;
BEGIN
  -- Serializes only this room; other rooms are unaffected. Released
  -- automatically at the end of the caller's transaction (commit OR rollback),
  -- so there is no cleanup path to get wrong.
  PERFORM pg_advisory_xact_lock(hashtext('sketchsync:zindex:' || p_room::text)::bigint);

  SELECT COALESCE(MAX("zIndex"), 0) + 1 INTO v_z
  FROM "Element"
  WHERE "roomId" = p_room;

  RETURN QUERY
  INSERT INTO "Element" (
    "id", "roomId", "type", "data", "version", "zIndex",
    "createdBy", "createdAt", "updatedAt", "deleted"
  )
  VALUES (p_id, p_room, p_type, p_data, 1, v_z, p_creator, NOW(), NOW(), false)
  RETURNING *;
END;
$$;
