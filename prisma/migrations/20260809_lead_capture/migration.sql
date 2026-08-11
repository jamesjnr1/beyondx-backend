-- Event lead capture (market days, expos)

CREATE TABLE IF NOT EXISTS "Lead" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "interest" TEXT NOT NULL,
  "category" TEXT,
  "location" TEXT,
  "notes" TEXT,
  "source" TEXT NOT NULL DEFAULT 'market_day',
  "followedUp" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Lead_createdAt_idx" ON "Lead"("createdAt");
CREATE INDEX IF NOT EXISTS "Lead_followedUp_idx" ON "Lead"("followedUp");
