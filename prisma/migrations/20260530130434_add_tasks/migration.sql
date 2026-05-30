-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('open', 'accepted', 'completed', 'cancelled');

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "employerId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT NOT NULL,
    "duration" TEXT NOT NULL,
    "pay" DECIMAL(65,30) NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_employerId_fkey" FOREIGN KEY ("employerId") REFERENCES "Employer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
