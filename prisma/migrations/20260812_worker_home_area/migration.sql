-- Add home area and coordinates to Worker for proximity calculation
ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "homeArea" TEXT;
ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "homeLat" DOUBLE PRECISION;
ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "homeLng" DOUBLE PRECISION;

-- Transport allowance on tasks (for proximity-based travel cost)
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "transportAllowance" INTEGER DEFAULT 0;
