-- DropIndex
DROP INDEX "Element_roomId_idx";

-- AlterTable
ALTER TABLE "Element" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "Element_roomId_createdAt_idx" ON "Element"("roomId", "createdAt");

