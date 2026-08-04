-- Add paymentRef field to Task
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "paymentRef" TEXT;
