-- Coordinator job requests: employer -> coordinator quote -> admin approval -> Task
CREATE TABLE IF NOT EXISTS "CoordinatorJobRequest" (
  "id" TEXT NOT NULL,
  "employerId" TEXT NOT NULL,
  "coordinatorId" TEXT NOT NULL,
  "taskType" TEXT NOT NULL,
  "description" TEXT,
  "location" TEXT NOT NULL,
  "duration" TEXT NOT NULL,
  "workersNeeded" INTEGER NOT NULL DEFAULT 1,
  "materialsProvided" BOOLEAN NOT NULL DEFAULT false,
  "scheduledDate" TEXT,
  "scheduledTime" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending_coordinator',
  "quotedPrice" DOUBLE PRECISION,
  "quoteNote" TEXT,
  "quotedAt" TIMESTAMP(3),
  "adminNote" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "taskId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CoordinatorJobRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CoordinatorJobRequest_taskId_key" UNIQUE ("taskId")
);
CREATE INDEX IF NOT EXISTS "CoordinatorJobRequest_coordinatorId_idx" ON "CoordinatorJobRequest"("coordinatorId");
CREATE INDEX IF NOT EXISTS "CoordinatorJobRequest_employerId_idx" ON "CoordinatorJobRequest"("employerId");

DO $$ BEGIN
  ALTER TABLE "CoordinatorJobRequest" ADD CONSTRAINT "CoordinatorJobRequest_employerId_fkey"
    FOREIGN KEY ("employerId") REFERENCES "Employer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CoordinatorJobRequest" ADD CONSTRAINT "CoordinatorJobRequest_coordinatorId_fkey"
    FOREIGN KEY ("coordinatorId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
