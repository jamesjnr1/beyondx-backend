const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// POST /api/track — public, unauthenticated. Called once per site visit from
// the frontend with a client-generated visitorId (a UUID kept in
// localStorage, stable across the same browser/device). Upserts a single
// row per visitor: creates it on first visit, otherwise just bumps
// lastSeenAt and pageViews. This is the whole of our self-hosted visitor
// tracking — no third-party analytics, no cookies beyond the one ID.
router.post('/', async (req, res) => {
  const { visitorId, path, referrer, userAgent } = req.body || {};
  // Never let a malformed tracking call fail loudly — this must never
  // break the page it's called from.
  if (!visitorId || typeof visitorId !== 'string' || visitorId.length > 100) {
    return res.status(204).end();
  }
  try {
    await prisma.visitor.upsert({
      where: { visitorId },
      update: { lastSeenAt: new Date(), pageViews: { increment: 1 } },
      create: {
        visitorId,
        firstPath: typeof path === 'string' ? path.slice(0, 300) : null,
        referrer: typeof referrer === 'string' ? referrer.slice(0, 300) : null,
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 300) : null,
      },
    });
  } catch (err) {
    console.error('[track] failed:', err.message);
  }
  res.status(204).end();
});

module.exports = router;
