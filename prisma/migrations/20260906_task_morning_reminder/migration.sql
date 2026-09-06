-- schema.prisma has had Task.morningReminderSentAt since the morning-of
-- reminder feature was added to utils/reminders.js, but no migration ever
-- created the column — the background reminder job (checkReminders, run
-- every 5 minutes) has been crashing on every tick as a result, silently
-- swallowed by its own try/catch, so no morning-of or hourly SMS reminders
-- were ever going out.
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "morningReminderSentAt" TIMESTAMP(3);
