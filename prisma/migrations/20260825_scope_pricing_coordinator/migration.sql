-- Tiered pricing
CREATE TABLE IF NOT EXISTS "PriceTier" (
  "id" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "tier" TEXT NOT NULL,
  "basePrice" DOUBLE PRECISION NOT NULL,
  "materialsSurcharge" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PriceTier_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PriceTier_category_tier_key" UNIQUE ("category", "tier")
);
CREATE INDEX IF NOT EXISTS "PriceTier_category_idx" ON "PriceTier"("category");

-- Scope form
CREATE TABLE IF NOT EXISTS "TaskScope" (
  "id" TEXT NOT NULL,
  "taskId" TEXT,
  "employerId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "tier" TEXT NOT NULL,
  "estimatedHours" DOUBLE PRECISION NOT NULL,
  "materialsProvided" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  "photoUrls" TEXT[] DEFAULT '{}',
  "quotedPrice" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskScope_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskScope_taskId_key" UNIQUE ("taskId")
);
CREATE INDEX IF NOT EXISTS "TaskScope_employerId_idx" ON "TaskScope"("employerId");

-- Scope disputes
CREATE TABLE IF NOT EXISTS "ScopeDispute" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "flaggedBy" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "originalPrice" DOUBLE PRECISION NOT NULL,
  "requestedPrice" DOUBLE PRECISION NOT NULL,
  "adjustedPrice" DOUBLE PRECISION,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "adminNote" TEXT,
  "requiresEmployerConfirm" BOOLEAN NOT NULL DEFAULT false,
  "employerConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "ScopeDispute_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ScopeDispute_taskId_idx" ON "ScopeDispute"("taskId");
CREATE INDEX IF NOT EXISTS "ScopeDispute_status_idx" ON "ScopeDispute"("status");

-- Coordinators
CREATE TABLE IF NOT EXISTS "Coordinator" (
  "id" TEXT NOT NULL,
  "fullName" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "email" TEXT,
  "orgName" TEXT,
  "pinHash" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "totalJobs" INTEGER NOT NULL DEFAULT 0,
  "totalWorkers" INTEGER NOT NULL DEFAULT 0,
  "totalCommission" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Coordinator_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Coordinator_phone_key" UNIQUE ("phone")
);

-- Coordinator dispatches
CREATE TABLE IF NOT EXISTS "CoordinatorDispatch" (
  "id" TEXT NOT NULL,
  "coordinatorId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "workersDispatched" INTEGER NOT NULL DEFAULT 1,
  "negotiatedRate" DOUBLE PRECISION NOT NULL,
  "commission" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CoordinatorDispatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CoordinatorDispatch_taskId_key" UNIQUE ("taskId")
);
CREATE INDEX IF NOT EXISTS "CoordinatorDispatch_coordinatorId_idx" ON "CoordinatorDispatch"("coordinatorId");

-- Seed default price tiers based on existing BeyondX categories
INSERT INTO "PriceTier" ("id","category","tier","basePrice","materialsSurcharge") VALUES
  (gen_random_uuid(),'Facility & Cleaning','small',150,30),
  (gen_random_uuid(),'Facility & Cleaning','medium',250,50),
  (gen_random_uuid(),'Facility & Cleaning','large',400,80),
  (gen_random_uuid(),'General Site Labour','small',100,0),
  (gen_random_uuid(),'General Site Labour','medium',180,0),
  (gen_random_uuid(),'General Site Labour','large',300,0),
  (gen_random_uuid(),'Skilled Trades','small',180,40),
  (gen_random_uuid(),'Skilled Trades','medium',300,60),
  (gen_random_uuid(),'Skilled Trades','large',500,100),
  (gen_random_uuid(),'Painting & Finishing','small',150,60),
  (gen_random_uuid(),'Painting & Finishing','medium',280,100),
  (gen_random_uuid(),'Painting & Finishing','large',480,160),
  (gen_random_uuid(),'Repairs & Maintenance','small',120,30),
  (gen_random_uuid(),'Repairs & Maintenance','medium',220,50),
  (gen_random_uuid(),'Repairs & Maintenance','large',380,80),
  (gen_random_uuid(),'Event & Hospitality','small',150,0),
  (gen_random_uuid(),'Event & Hospitality','medium',250,0),
  (gen_random_uuid(),'Event & Hospitality','large',400,0),
  (gen_random_uuid(),'Logistics & Delivery','small',100,0),
  (gen_random_uuid(),'Logistics & Delivery','medium',180,0),
  (gen_random_uuid(),'Logistics & Delivery','large',300,0),
  (gen_random_uuid(),'Agriculture & Environment','small',100,0),
  (gen_random_uuid(),'Agriculture & Environment','medium',160,0),
  (gen_random_uuid(),'Agriculture & Environment','large',280,0)
ON CONFLICT ("category","tier") DO NOTHING;
