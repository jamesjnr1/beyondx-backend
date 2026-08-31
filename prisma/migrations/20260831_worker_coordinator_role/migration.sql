-- Worker coordinator role + JSON-in-a-field coordinator state
-- (see beyondx-website src/lib/coordinator.ts for the shapes stored here)
ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'worker';
ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "coordinatorApplication" TEXT;
ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "coordinatorTeam" TEXT;
ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "coordinatorDisputes" TEXT;
ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "coordinatorQuotes" TEXT;
ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "coordinatorPayoutSplits" TEXT;
