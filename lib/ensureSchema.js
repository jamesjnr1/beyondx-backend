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

module.exports = { ensureWorkerColumns };
