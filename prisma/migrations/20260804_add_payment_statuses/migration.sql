-- Add payment_pending and payment_rejected to TaskStatus enum
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'payment_pending';
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'payment_rejected';
