-- Self-hosted visitor tracking (replaces Vercel Analytics for the
-- visit -> registration conversion funnel)

CREATE TABLE IF NOT EXISTS "Visitor" (
  "id" TEXT NOT NULL,
  "visitorId" TEXT NOT NULL,
  "firstPath" TEXT,
  "referrer" TEXT,
  "userAgent" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "pageViews" INTEGER NOT NULL DEFAULT 1,
  "convertedAt" TIMESTAMP(3),
  "convertedAs" TEXT,
  CONSTRAINT "Visitor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Visitor_visitorId_key" ON "Visitor"("visitorId");
CREATE INDEX IF NOT EXISTS "Visitor_firstSeenAt_idx" ON "Visitor"("firstSeenAt");
CREATE INDEX IF NOT EXISTS "Visitor_convertedAt_idx" ON "Visitor"("convertedAt");
