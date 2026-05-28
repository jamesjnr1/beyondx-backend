require('dotenv').config();
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma  = new PrismaClient({ adapter });
const router  = express.Router();

// GET /api/workers — get all active workers
router.get('/', async (req, res) => {
  try {
    const workers = await prisma.worker.findMany({
      where: { isActive: true },
      select: {
        id:             true,
        workerId:       true,
        fullName:       true,
        skills:         true,
        bio:            true,
        dailyCharge:    true,
        rating:         true,
        tasksCompleted: true,
        offenseLevel:   true,
        gpsVerified:    true,
        prisonFacility: true
      }
    });
    res.json({ workers });
  } catch (err) {
    console.error('Fetch workers error:', err);
    res.status(500).json({ error: 'Could not fetch workers' });
  }
});

module.exports = router;