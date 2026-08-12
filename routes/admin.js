const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { sendSMS } = require('../utils/sms');
const { expireStaleOffers } = require('./tasks');
const { calcProximity } = require('../utils/proximity');

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
    await expireStaleOffers();
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
// PATCH /admin/tasks/:id/status — set task status directly (used by verify-payments flow)
router.patch('/tasks/:id/status', adminAuth, async (req, res) => {
  const { status, adminNote, workerId } = req.body;
  const allowed = ['offered', 'payment_pending', 'payment_rejected', 'accepted', 'completed', 'pending_confirmation', 'employer_confirmed', 'open', 'cancelled', 'expired'];
  if (!status || !allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  try {
    // Auto-compute transport allowance when assigning a worker to a task.
    let transportAllowance = undefined;
    if (status === 'offered' && workerId) {
      const [existingTask, worker] = await Promise.all([
        prisma.task.findUnique({ where: { id: req.params.id }, select: { location: true } }),
        prisma.worker.findUnique({ where: { id: workerId }, select: { homeArea: true } }),
      ]);
      if (existingTask && worker) {
        const prox = calcProximity(worker.homeArea, existingTask.location);
        if (prox.available) transportAllowance = prox.transportAllowance;
      }
    }
    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: {
        status,
        ...(adminNote ? { adminNote } : {}),
        ...(workerId ? { workerId } : {}),
        ...(transportAllowance !== undefined ? { transportAllowance } : {}),
      },
      include: {
        acceptedBy: { select: { fullName: true, phone: true } },
        employer: { select: { orgName: true, contactPerson: true, phone: true } }
      }
    });

    // When payment is verified and status advances to 'offered',
    // send the worker a full job offer SMS with all details.
    if (status === 'offered' && task.acceptedBy?.phone) {
      const firstName = (task.acceptedBy.fullName || '').split(' ')[0] || 'there';
      const workerCut = Number(task.pay || 0).toFixed(0);
      const emp = task.employer || {};
      const lines = [
        `Hi ${firstName}! You have a new job offer from BeyondX.`,
        '',
        `Job: ${task.taskType}`,
        task.description ? `Details: ${task.description}` : null,
        task.location   ? `Location: ${task.location}` : null,
        task.duration   ? `Duration: ${task.duration}` : null,
        `Your pay: GH\u20b5 ${workerCut}`,
        '',
        `Employer: ${emp.orgName || 'BeyondX employer'}`,
        emp.contactPerson ? `Contact: ${emp.contactPerson}` : null,
        emp.phone         ? `Phone: ${emp.phone}` : null,
        '',
        'Open your BeyondX Worker Dashboard at beyondxco.com to accept or decline.',
        '',
        '- The BeyondX Team',
      ].filter(Boolean).join('\n');
      sendSMS(task.acceptedBy.phone, lines);
    }

    res.json({ ok: true, task });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Task not found.' });
    // Surface the real cause — a hidden generic message here has cost hours
    // of debugging before (e.g. the TaskStatus enum missing a value in the
    // live database after a migration was never applied).
    console.error('[admin] status update failed:', err.message);
    res.status(500).json({ error: err.message || 'Server error', code: err.code });
  }
});

// POST /admin/tasks/dispatch-multi — offer a job to several candidate
// workers at once for a posting that needs more than one person.
// Creates one Task row per worker, all sharing a groupId + slotsNeeded, each
// sent the same job-offer SMS. The first `slotsNeeded` to accept fill the
// job; remaining offers auto-withdraw (see accept-offer in routes/tasks.js).
//
// Body: {
//   sourceTaskId?: string,       // an existing 'open' task to copy details from
//   taskType, description, location, duration, pay, employerId,  // OR provide these directly
//   workerIds: string[],         // candidates to offer it to (can exceed slotsNeeded)
//   slotsNeeded: number,
//   offerHours?: number,         // optional — offer expires after this many hours
// }
router.post('/tasks/dispatch-multi', adminAuth, async (req, res) => {
  const { sourceTaskId, workerIds, slotsNeeded, offerHours } = req.body;
  let { taskType, description, location, duration, pay, employerId } = req.body;

  if (!Array.isArray(workerIds) || workerIds.length === 0) {
    return res.status(400).json({ error: 'workerIds must be a non-empty array.' });
  }
  if (!slotsNeeded || slotsNeeded < 1) {
    return res.status(400).json({ error: 'slotsNeeded must be at least 1.' });
  }
  if (workerIds.length < slotsNeeded) {
    return res.status(400).json({ error: `You are offering to ${workerIds.length} worker(s) but need ${slotsNeeded} — offer to at least ${slotsNeeded}.` });
  }

  try {
    if (sourceTaskId) {
      const source = await prisma.task.findUnique({ where: { id: sourceTaskId } });
      if (!source) return res.status(404).json({ error: 'Source task not found.' });
      taskType = taskType || source.taskType;
      description = description ?? source.description;
      location = location || source.location;
      duration = duration || source.duration;
      pay = pay || source.pay;
      employerId = employerId || source.employerId;
    }
    if (!taskType || !location || !duration || !pay || !employerId) {
      return res.status(400).json({ error: 'taskType, location, duration, pay, and employerId are required (directly, or via sourceTaskId).' });
    }

    const groupId = require('crypto').randomUUID();
    const offerExpiresAt = offerHours ? new Date(Date.now() + offerHours * 3600 * 1000) : null;

    const created = await prisma.$transaction(
      workerIds.map(workerId => prisma.task.create({
        data: {
          employerId, taskType, description: description || '', location, duration,
          pay: parseFloat(pay), status: 'offered', workerId,
          groupId, slotsNeeded: parseInt(slotsNeeded, 10), offerExpiresAt,
        },
        include: {
          acceptedBy: { select: { fullName: true, phone: true } },
          employer: { select: { orgName: true, contactPerson: true, phone: true } },
        },
      }))
    );

    // If this fanned out from an existing 'open' posting, retire that
    // original row so it doesn't sit around duplicating the group.
    if (sourceTaskId) {
      await prisma.task.update({ where: { id: sourceTaskId }, data: { status: 'cancelled', adminNote: 'Superseded by multi-worker dispatch.' } }).catch(() => null);
    }

    // Notify every candidate worker — same template as the single-worker offer.
    for (const task of created) {
      if (!task.acceptedBy?.phone) continue;
      const firstName = (task.acceptedBy.fullName || '').split(' ')[0] || 'there';
      const workerCut = Number(task.pay || 0).toFixed(0);
      const emp = task.employer || {};
      const lines = [
        `Hi ${firstName}! You have a new job offer from BeyondX.`,
        '',
        `Job: ${task.taskType}`,
        task.description ? `Details: ${task.description}` : null,
        task.location   ? `Location: ${task.location}` : null,
        task.duration   ? `Duration: ${task.duration}` : null,
        `Your pay: GH\u20b5 ${workerCut}`,
        offerExpiresAt  ? `This offer expires ${offerExpiresAt.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}.` : null,
        '',
        `Employer: ${emp.orgName || 'BeyondX employer'}`,
        emp.contactPerson ? `Contact: ${emp.contactPerson}` : null,
        emp.phone         ? `Phone: ${emp.phone}` : null,
        '',
        'This job needs multiple workers — first to accept get it. Open your BeyondX Worker Dashboard at beyondxco.com now to accept or decline.',
        '',
        '- The BeyondX Team',
      ].filter(Boolean).join('\n');
      sendSMS(task.acceptedBy.phone, lines);
    }

    res.json({ ok: true, groupId, tasksCreated: created.length });
  } catch (err) {
    console.error('[admin] dispatch-multi failed:', err.message);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

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
        homeArea:       true,
        homeLat:        true,
        homeLng:        true,
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
// GET /admin/leads — everyone captured at events, newest first
router.get('/leads', adminAuth, async (req, res) => {
  try {
    const leads = await prisma.lead.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ leads });
  } catch (err) {
    console.error('[admin] fetch leads failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/leads/:id — mark a lead as followed up (or un-mark it)
router.patch('/leads/:id', adminAuth, async (req, res) => {
  const { followedUp } = req.body;
  try {
    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: { followedUp: !!followedUp },
    });
    res.json({ lead });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Lead not found.' });
    res.status(500).json({ error: 'Server error' });
  }
});

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

// GET /admin/visitor-stats — self-hosted visitor -> signup conversion funnel.
// Replaces Vercel Analytics for this specific question: how many people
// look at the site, and how many of those actually register. Query param
// ?days=N restricts to the last N days (default 30); omit or use 0 for all-time.
router.get('/visitor-stats', adminAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 0;
    const since = days > 0 ? new Date(Date.now() - days * 86400000) : null;
    const dateFilter = since ? { firstSeenAt: { gte: since } } : {};

    const [totalVisitors, converted, workerSignups, employerSignups, recent] = await Promise.all([
      prisma.visitor.count({ where: dateFilter }),
      prisma.visitor.count({ where: { ...dateFilter, convertedAt: { not: null } } }),
      prisma.visitor.count({ where: { ...dateFilter, convertedAs: 'worker' } }),
      prisma.visitor.count({ where: { ...dateFilter, convertedAs: 'employer' } }),
      prisma.visitor.findMany({
        where: dateFilter,
        orderBy: { lastSeenAt: 'desc' },
        take: 50,
        select: {
          visitorId: true, firstPath: true, referrer: true, firstSeenAt: true,
          lastSeenAt: true, pageViews: true, convertedAt: true, convertedAs: true,
        },
      }),
    ]);

    const conversionRate = totalVisitors > 0 ? (converted / totalVisitors * 100) : 0;

    res.json({
      totalVisitors, converted, notConverted: totalVisitors - converted,
      workerSignups, employerSignups, conversionRate,
      recent,
    });
  } catch (err) {
    console.error('[admin] visitor-stats failed:', err.message);
    res.status(500).json({ error: err.message || 'Server error' });
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
