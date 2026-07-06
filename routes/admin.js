const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { sendSMS } = require('../utils/sms');

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
      data: { status: 'completed' },
      include: { acceptedBy: { select: { fullName: true, phone: true } } }
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

    if (task.acceptedBy?.phone) {
      const paidAmount = (parseFloat(task.pay) * 0.85).toFixed(0);
      sendSMS(task.acceptedBy.phone, `You're paid! GHS ${paidAmount} has been transferred to your account. Thank you for choosing BeyondX!`);
    }
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

// GET /admin/workers — full worker data for the admin dashboard, including
// sensitive fields (guarantor name/phone/relationship) that must NEVER be
// exposed through the public /api/workers endpoint employers use to browse.
// GET /admin/employers — full employer list, used for the admin dashboard's
// "message all employers" broadcast option among other things.
router.get('/employers', adminAuth, async (req, res) => {
  try {
    const employers = await prisma.employer.findMany({
      select: {
        id: true,
        orgName: true,
        contactPerson: true,
        phone: true,
        email: true,
        isVerified: true,
        createdAt: true
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ employers });
  } catch (err) {
    console.error('Fetch admin employers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/workers', adminAuth, async (req, res) => {
  try {
    const workers = await prisma.worker.findMany({
      select: {
        id:             true,
        workerId:       true,
        fullName:       true,
        phone:          true,
        skills:         true,
        bio:            true,
        dailyCharge:    true,
        rating:         true,
        tasksCompleted: true,
        totalEarned:    true,
        offenseLevel:   true,
        gpsVerified:    true,
        isActive:       true,
        prisonFacility: true,
        photoUrl:       true,
        guarantorName:  true,
        guarantorPhone: true,
        guarantorRelationship: true,
        createdAt:      true,
        tasks: {
          where: { status: { in: ['accepted', 'pending_confirmation'] } },
          select: { id: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    const flattened = workers.map(w => ({
      ...w,
      isBusy: (w.tasks || []).length > 0,
      tasks: undefined
    }));
    res.json({ workers: flattened });
  } catch (err) {
    console.error('Fetch admin workers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/sms-logs — recent SMS send attempts, for the admin dashboard
// to surface delivery problems (especially a depleted Arkesel balance)
// instead of these only being visible in Railway's server logs.
router.get('/sms-logs', adminAuth, async (req, res) => {
  try {
    const logs = await prisma.smsLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    res.json({ logs });
  } catch (err) {
    console.error('Fetch SMS logs error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/send-sms — lets an admin send a one-off custom SMS to any
// phone number directly from the dashboard (e.g. following up with a
// specific worker or employer outside the automated message flow).
router.post('/send-sms', adminAuth, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });
  try {
    await sendSMS(phone, message);
    res.json({ success: true });
  } catch (err) {
    console.error('Custom SMS send error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/send-dormant-reminders — finds workers who haven't logged in
// for 7+ days and texts them a reminder to stay visible to employers.
// Can be triggered manually from the dashboard, or on a schedule via an
// external cron service (e.g. cron-job.org) hitting this endpoint weekly.
router.post('/send-dormant-reminders', adminAuth, async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dormantWorkers = await prisma.worker.findMany({
      where: {
        isActive: true,
        OR: [
          { lastActiveAt: { lt: sevenDaysAgo } },
          { lastActiveAt: null }
        ]
      },
      select: { id: true, fullName: true, phone: true, lastActiveAt: true }
    });

    const message = "We've noticed you haven't been active recently. Log in to BeyondX to stay visible to employers and never miss a job opportunity.";
    dormantWorkers.forEach(w => sendSMS(w.phone, message));

    res.json({ success: true, notified: dormantWorkers.length, workers: dormantWorkers.map(w => ({ fullName: w.fullName, phone: w.phone, lastActiveAt: w.lastActiveAt })) });
  } catch (err) {
    console.error('Send dormant reminders error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
