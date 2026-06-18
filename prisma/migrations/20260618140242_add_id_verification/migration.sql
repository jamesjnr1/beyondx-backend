-- AlterTable
ALTER TABLE "Worker" ADD COLUMN     "idCardNumber" TEXT,
ADD COLUMN     "idType" TEXT,
ADD COLUMN     "idVerificationRef" TEXT,
ADD COLUMN     "idVerified" BOOLEAN NOT NULL DEFAULT false;
