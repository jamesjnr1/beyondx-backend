-- Add adminNote column to Task — stores the reason when an admin rejects
-- a payment (or any other admin-facing note on a task).
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "adminNote" TEXT;
