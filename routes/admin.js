const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'beyondx2026';

// Simple password auth middleware
function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// GET /admin/payouts — tasks pending payment
router.get('/payouts', adminAuth, async (req, res) => {
  try {
    const tasks = await prisma.task.findMany({
      where: { status: 'employer_confirmed' },
      include: {
        acceptedBy: { select: { fullName: true, workerId: true, phone: true } },
        employer: { select: { orgName: true, contactPerson: true, phone: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/all — all tasks overview
router.get('/all', adminAuth, async (req, res) => {
  try {
    const tasks = await prisma.task.findMany({
      include: {
        acceptedBy: { select: { fullName: true, workerId: true, phone: true } },
        employer: { select: { orgName: true, phone: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/tasks/:id/paid — mark worker as paid
router.patch('/tasks/:id/paid', adminAuth, async (req, res) => {
  try {
    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: { status: 'completed' }
    });
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
