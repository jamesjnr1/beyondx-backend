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
        employer: { select: { orgName: true, phone: true } },
        reviews: true
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
    if (task.workerId) {
      await prisma.worker.update({
        where: { id: task.workerId },
        data: {
          tasksCompleted: { increment: 1 },
          totalEarned: { increment: task.pay }
        }
      });
    }
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /admin/clear-data — wipe all tasks, dispatches, and payments (revenue/transactions).
// Workers and Employers themselves are kept, but each worker's cumulative
// tasksCompleted / totalEarned / rating counters are reset to zero since
// those are derived from the transactions being cleared.
router.delete('/clear-data', adminAuth, async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const payments = await tx.payment.deleteMany({});
      const dispatches = await tx.dispatch.deleteMany({});
      const tasks = await tx.task.deleteMany({});
      await tx.worker.updateMany({
        data: { tasksCompleted: 0, totalEarned: 0, rating: 0 }
      });
      return { payments: payments.count, dispatches: dispatches.count, tasks: tasks.count };
    });
    res.json({ success: true, cleared: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /admin/clear-employers — permanently delete ALL employer accounts,
// and everything that references them (their tasks, dispatches, payments,
// and any reviews about them or written by them). Workers themselves are
// NOT deleted, but any worker stats derived from these tasks (tasksCompleted,
// totalEarned) are reset to zero since the underlying transactions are gone.
router.delete('/clear-employers', adminAuth, async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Reviews reference tasks (and optionally employers/workers directly),
      // so clear those first to avoid foreign key errors.
      const reviews = await tx.review.deleteMany({});
      const payments = await tx.payment.deleteMany({});
      const dispatches = await tx.dispatch.deleteMany({});
      const tasks = await tx.task.deleteMany({});
      const employers = await tx.employer.deleteMany({});
      await tx.worker.updateMany({
        data: { tasksCompleted: 0, totalEarned: 0, rating: 0 }
      });
      return {
        employers: employers.count,
        tasks: tasks.count,
        dispatches: dispatches.count,
        payments: payments.count,
        reviews: reviews.count
      };
    });
    res.json({ success: true, cleared: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
