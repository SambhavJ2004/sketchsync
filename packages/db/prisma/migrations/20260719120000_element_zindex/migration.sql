-- AlterTable: add the float stacking-order column (default 0 for now).
ALTER TABLE "Element" ADD COLUMN "zIndex" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Backfill: assign sequential zIndex per room in existing creation order so no
-- board visually reshuffles. createdAt ASC (id as a stable secondary tiebreak).
UPDATE "Element" AS e
SET "zIndex" = seq.rn
FROM (
  SELECT id,
         row_number() OVER (PARTITION BY "roomId" ORDER BY "createdAt" ASC, id ASC) AS rn
  FROM "Element"
) AS seq
WHERE e.id = seq.id;

-- Swap the sync index to (roomId, zIndex, createdAt).
DROP INDEX "Element_roomId_createdAt_idx";
CREATE INDEX "Element_roomId_zIndex_createdAt_idx" ON "Element"("roomId", "zIndex", "createdAt");
