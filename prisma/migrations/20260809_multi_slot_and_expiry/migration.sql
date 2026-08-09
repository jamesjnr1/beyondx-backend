-- Multi-worker job slots + offer expiry timer

ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'expired';

ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "groupId" TEXT;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "slotsNeeded" INTEGER;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "offerExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Task_groupId_idx" ON "Task"("groupId");
