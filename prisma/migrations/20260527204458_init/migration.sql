-- CreateEnum
CREATE TYPE "OffenseLevel" AS ENUM ('none', 'minor', 'major');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('pending_payment', 'confirmed', 'active', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "PayMethod" AS ENUM ('mtn_momo', 'voda_cash', 'airteltigo', 'bank_card');

-- CreateEnum
CREATE TYPE "PayStatus" AS ENUM ('pending', 'success', 'failed', 'reversed');

-- CreateTable
CREATE TABLE "Worker" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "phone" TEXT,
    "prisonFacility" TEXT,
    "releaseDate" TIMESTAMP(3),
    "offenseLevel" "OffenseLevel" NOT NULL DEFAULT 'none',
    "offenseNotes" TEXT,
    "skills" TEXT[],
    "bio" TEXT,
    "dailyCharge" DECIMAL(65,30) NOT NULL DEFAULT 80,
    "rating" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "tasksCompleted" INTEGER NOT NULL DEFAULT 0,
    "totalEarned" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "gpsVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employer" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "orgName" TEXT NOT NULL,
    "contactPerson" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "region" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Employer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispatch" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "employerId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "taskDescription" TEXT,
    "location" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "durationDays" DECIMAL(65,30) NOT NULL,
    "workerRate" DECIMAL(65,30) NOT NULL,
    "platformFee" DECIMAL(65,30) NOT NULL,
    "totalAmount" DECIMAL(65,30) NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'pending_payment',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "paystackRef" TEXT NOT NULL,
    "employerId" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "method" "PayMethod" NOT NULL,
    "status" "PayStatus" NOT NULL DEFAULT 'pending',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UssdSession" (
    "sessionId" TEXT NOT NULL,
    "msisdn" TEXT NOT NULL,
    "workerId" TEXT,
    "step" TEXT NOT NULL DEFAULT 'main',
    "data" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UssdSession_pkey" PRIMARY KEY ("sessionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Worker_workerId_key" ON "Worker"("workerId");

-- CreateIndex
CREATE UNIQUE INDEX "Employer_email_key" ON "Employer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Dispatch_reference_key" ON "Dispatch"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_paystackRef_key" ON "Payment"("paystackRef");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_dispatchId_key" ON "Payment"("dispatchId");

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_employerId_fkey" FOREIGN KEY ("employerId") REFERENCES "Employer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_employerId_fkey" FOREIGN KEY ("employerId") REFERENCES "Employer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "Dispatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UssdSession" ADD CONSTRAINT "UssdSession_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE SET NULL ON UPDATE CASCADE;
