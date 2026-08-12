const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// POST /api/leads — public, unauthenticated. Used by public/market-day.html
// at events (market days, expos) to capture interest from people who stop
// by a stand. Deliberately minimal validation — a member of staff is
// entering this on someone's behalf in person, not the person themselves,
// so it needs to be fast and forgiving, not strict.
router.post('/', async (req, res) => {
  const { name, phone, interest, category, location, notes, source } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'Phone number is required.' });
  if (!['worker', 'employer', 'partner', 'curious'].includes(interest)) {
    return res.status(400).json({ error: 'interest must be worker, employer, or curious.' });
  }
  try {
    const lead = await prisma.lead.create({
      data: {
        name: String(name).trim().slice(0, 200),
        phone: String(phone).trim().slice(0, 50),
        interest,
        category: category ? String(category).trim().slice(0, 100) : null,
        location: location ? String(location).trim().slice(0, 200) : null,
        notes: notes ? String(notes).trim().slice(0, 1000) : null,
        source: source ? String(source).trim().slice(0, 100) : 'market_day',
      },
    });
    res.status(201).json({ ok: true, id: lead.id });
  } catch (err) {
    console.error('[leads] create failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
