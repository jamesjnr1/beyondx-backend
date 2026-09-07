-- Worker.hasTools backs the "brings own tools" +15% surcharge (see
-- beyondx-website src/data.ts TOOL_SURCHARGE_RATE / BookWorker.tsx) and the
-- "Has tools" badge in the hire flow. The frontend has sent/read this field
-- for a while (ProfileModal, EmployerDashboard's worker cards), but no
-- column ever existed for it — every read and write of it was a silent
-- no-op, so the field never worked and the surcharge could never apply.
ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "hasTools" BOOLEAN NOT NULL DEFAULT false;

-- Same story for the Work Experience & Certifications card
-- (WorkerDashboard.tsx WorkExperienceCard, and the "Certified Skills" /
-- certifications display employers see in EmployerDashboard's
-- WorkerProfileModal): the frontend has read and written these fields for a
-- while via PATCH /api/workers/me, but no columns ever existed, so every
-- "Saved" here was a silent no-op that reverted on the next full profile load.
ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "experienceEntries" TEXT;
ALTER TABLE "Worker" ADD COLUMN IF NOT EXISTS "certifications" TEXT;
