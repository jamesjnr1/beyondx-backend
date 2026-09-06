// lib/ensureSchema.js
//
// Deploys here run `prisma generate` but never `prisma migrate deploy` (see
// PR #3) — nothing in the pipeline actually applies pending migrations to
// the live database. The columns below were added to schema.prisma in the
// coordinator-application work and have had no opportunity yet for anyone
// to sync them to the live database by hand (the way this repo's older
// features evidently were — several much older Worker columns, and even a
// whole Review table, exist in schema.prisma with no migration file at all,
// meaning they were pushed straight to the database outside the migration
// system at the time they shipped). These six are the ones genuinely at
// risk of being missing right now.
//
// Self-heals them at startup with plain idempotent `ADD COLUMN IF NOT
// EXISTS` statements — a no-op wherever a column already exists, and a
// correct, non-destructive addition wherever it doesn't (every one here is
// nullable or has a default, so it can never fail or lose data). Non-fatal:
// if this doesn't have ALTER TABLE privileges for some reason, log it and
// keep booting rather than take the server down over it.
const WORKER_COLUMNS = [
  `ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'worker'`,
  `ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "coordinatorApplication" TEXT`,
  `ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "coordinatorTeam" TEXT`,
  `ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "coordinatorDisputes" TEXT`,
  `ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "coordinatorQuotes" TEXT`,
  `ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "coordinatorPayoutSplits" TEXT`,
];

async function ensureWorkerColumns(prisma) {
  for (const sql of WORKER_COLUMNS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      console.error('[ensureSchema] failed to apply:', sql, err.message);
    }
  }
}

// morningReminderSentAt was added to schema.prisma when the morning-of
// reminder SMS shipped (utils/reminders.js), but — same story as the Worker
// columns above — never synced to the live database by hand. Without it,
// checkReminders()'s query 500s on every 5-minute tick (caught and logged,
// never surfaced), which means it silently never sends the 1-hour-before
// reminder either, since both reminders are fetched by the same query.
const TASK_COLUMNS = [
  `ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "morningReminderSentAt" TIMESTAMP(3)`,
];

async function ensureTaskColumns(prisma) {
  for (const sql of TASK_COLUMNS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      console.error('[ensureSchema] failed to apply:', sql, err.message);
    }
  }
}

// Same story as above, but a whole table this time: CoordinatorJobRequest
// (employer -> coordinator quote -> admin approval -> Task) is brand new,
// so there's been no opportunity for anyone to sync it to the live database
// by hand yet either. CREATE TABLE/INDEX IF NOT EXISTS are naturally
// idempotent; the two ADD CONSTRAINT statements aren't, so each runs in its
// own try/catch — "already exists" on a later boot is expected and ignored,
// same as every statement here.
const COORDINATOR_JOB_REQUEST_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "CoordinatorJobRequest" (
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
  )`,
  `CREATE INDEX IF NOT EXISTS "CoordinatorJobRequest_coordinatorId_idx" ON "CoordinatorJobRequest"("coordinatorId")`,
  `CREATE INDEX IF NOT EXISTS "CoordinatorJobRequest_employerId_idx" ON "CoordinatorJobRequest"("employerId")`,
  `ALTER TABLE "CoordinatorJobRequest" ADD CONSTRAINT "CoordinatorJobRequest_employerId_fkey"
    FOREIGN KEY ("employerId") REFERENCES "Employer"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
  `ALTER TABLE "CoordinatorJobRequest" ADD CONSTRAINT "CoordinatorJobRequest_coordinatorId_fkey"
    FOREIGN KEY ("coordinatorId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
];

async function ensureCoordinatorJobRequestsTable(prisma) {
  for (const sql of COORDINATOR_JOB_REQUEST_STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      console.error('[ensureSchema] failed to apply:', sql.split('\n')[0], err.message);
    }
  }
}

async function ensureSchema(prisma) {
  await ensureWorkerColumns(prisma);
  await ensureTaskColumns(prisma);
  await ensureCoordinatorJobRequestsTable(prisma);
}

module.exports = { ensureWorkerColumns, ensureTaskColumns, ensureCoordinatorJobRequestsTable, ensureSchema };
