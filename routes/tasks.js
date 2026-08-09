const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const jwt = require('jsonwebtoken');
const { sendSMS } = require('../utils/sms');

// Maps specific task type strings (from the "Post a Task" dropdown) to the
// broader skill category workers register under, so open-pool task alerts
// only reach workers whose skills are actually relevant.
const TASK_TYPE_TO_CATEGORY = {
  'office cleaning': 'Facility & Cleaning', 'school compound sweeping': 'Facility & Cleaning', 'hospital ward cleaning': 'Facility & Cleaning',
  'warehouse stock sorting': 'Logistics & Delivery', 'goods offloading': 'Logistics & Delivery', 'market porter': 'Logistics & Delivery',
  'painting & touch-up': 'Maintenance & Repairs', 'plumbing support': 'Maintenance & Repairs', 'building site labour': 'Maintenance & Repairs',
  'chair & table setup': 'Event & Hospitality', 'catering assistant': 'Event & Hospitality', 'food serving': 'Event & Hospitality',
  'farm weeding': 'Agriculture & Environment', 'grass cutting': 'Agriculture & Environment', 'tree planting': 'Agriculture & Environment',
  'shop attendant': 'Retail & Trade', 'packing & bagging': 'Retail & Trade', 'loading & offloading': 'Retail & Trade',
  'waste collection': 'Community Services', 'school painting': 'Community Services', 'drain maintenance': 'Community Services'
};
function categoryForTaskType(taskType) {
  const key = (taskType || '').toLowerCase().trim();
  return TASK_TYPE_TO_CATEGORY[key] || null;
}


const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Offer expiry — checked lazily on read rather than via a cron job, since
// none is configured for this project on Railway. Any 'offered' task whose
// offerExpiresAt has passed moves to 'expired' — a distinct, visible status
// rather than silently reverting to 'open', so admin can see exactly which
// offer timed out and to whom, then decide whether to redispatch. Cheap to
// call on every relevant read — it's a single indexed updateMany that does
// nothing when there's nothing to expire.
async function expireStaleOffers() {
  try {
    await prisma.task.updateMany({
      where: { status: 'offered', offerExpiresAt: { lt: new Date() } },
      data: { status: 'expired', workerId: null },
    });
  } catch (err) {
    console.error('[expireStaleOffers] failed:', err.message);
  }
}
router.expireStaleOffers = expireStaleOffers;

function authEmployer(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'employer') return res.status(403).json({ error: 'Not an employer' });
    req.employerId = decoded.id;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function authWorker(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'worker') return res.status(403).json({ error: 'Not a worker' });
    req.workerId = decoded.id;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// Accepts a token from EITHER a worker or an employer — used for the review
// endpoint, since both sides submit through the same route.
function authEitherParty(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'worker' && decoded.role !== 'employer') {
      return res.status(403).json({ error: 'Invalid token role' });
    }
    req.role = decoded.role;
    req.userId = decoded.id;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// POST /api/tasks — employer posts a task.
// If workerId is included (the employer picked a specific worker and paid
// for them via the dispatch flow), the task is assigned directly to that
// worker instead of being left open, and the worker gets a confirmation SMS.
router.post('/', authEmployer, async (req, res) => {
  const { taskType, description, location, duration, pay, workerId, paymentRef, workersNeeded } = req.body;
  if (!taskType || !location || !pay) return res.status(400).json({ error: 'taskType, location and pay are required' });
  try {
    if (workerId) {
      const activeTask = await prisma.task.findFirst({
        where: { workerId, status: { in: ['offered', 'accepted', 'pending_confirmation'] } }
      });
      if (activeTask) {
        return res.status(409).json({ error: activeTask.status === 'offered' ? 'This worker already has a pending offer awaiting their response.' : 'This worker is already on a job and is not available to dispatch right now.' });
      }
    }

    const data = {
      employerId: req.employerId,
      taskType,
      description: description || '',
      location,
      duration: duration || '1 day',
      pay: parseFloat(pay),
      // Recorded here as the employer's stated intent — admin sees this as
      // the default slot count when actually dispatching to candidates via
      // /admin/tasks/dispatch-multi (which creates the real offer group).
      ...(workersNeeded && workersNeeded > 1 ? { slotsNeeded: parseInt(workersNeeded, 10) } : {}),
      ...(paymentRef ? { paymentRef } : {}),
    };
    if (workerId) {
      data.workerId = workerId;
      // If the employer submitted payment details, hold as payment_pending until
      // BeyondX manually verifies the payment before notifying the worker.
      data.status = req.body.status === 'payment_pending' ? 'payment_pending' : 'offered';
    }

    const task = await prisma.task.create({
      data,
      include: {
        acceptedBy: { select: { fullName: true, phone: true } },
        employer: { select: { orgName: true } }
      }
    });

    if (workerId && task.acceptedBy && task.status !== 'payment_pending') {
      // Only notify the worker once payment has been verified by BeyondX.
      // When status is payment_pending, the admin console sends the SMS
      // after manually confirming the payment via Verify Payments.
      const firstName = (task.acceptedBy.fullName || '').split(' ')[0] || 'there';
      const workerCut = (parseFloat(task.pay) * 0.85).toFixed(0);
      const message = `Hi ${firstName}, you've been selected for a job in ${location} paying GHS ${workerCut}. Open your BeyondX dashboard to accept or decline the offer.`;
      sendSMS(task.acceptedBy.phone, message);
    } else if (!workerId) {
      // Open-pool task — notify active, available workers whose skills
      // match this task's category, so it's not silent for everyone.
      const category = categoryForTaskType(taskType);
      if (category) {
        const matchingWorkers = await prisma.worker.findMany({
          where: {
            isActive: true,
            skills: { has: category },
            tasks: { none: { status: { in: ['offered', 'accepted', 'pending_confirmation'] } } }
          },
          select: { phone: true, fullName: true }
        });
        const openWorkerCut = (parseFloat(task.pay) * 0.85).toFixed(0);
        const message = `Hi there, a new task is open in ${location} paying GHS ${openWorkerCut}. Open your BeyondX dashboard to accept it before someone else does.`;
        matchingWorkers.forEach(w => sendSMS(w.phone, message));
      }
    }

    res.status(201).json({ task });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/tasks/:id/cancel — employer cancels their own posted task
// while it's still searching for a worker. Only allowed before anyone has
// actually committed to the job (open, or payment submitted but not yet
// verified) — once a specific worker has been offered or accepted it,
// cancelling needs a human in the loop (support/admin), not a self-serve
// button, since someone may already be acting on it.
router.patch('/:id/cancel', authEmployer, async (req, res) => {
  try {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task || task.employerId !== req.employerId) {
      return res.status(404).json({ error: 'Task not found.' });
    }
    if (!['open', 'payment_pending'].includes(task.status)) {
      return res.status(400).json({ error: 'This job can no longer be cancelled — a worker has already been matched to it. Contact support if you need to stop it.' });
    }
    const updated = await prisma.task.update({
      where: { id: req.params.id },
      data: { status: 'cancelled' },
    });
    res.json({ task: updated });
  } catch (err) {
    console.error('[tasks] cancel failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tasks — fetch open tasks for workers
router.get('/', async (req, res) => {
  try {
    const tasks = await prisma.task.findMany({
      where: { status: 'open' },
      include: { employer: { select: { orgName: true, contactPerson: true, phone: true, address: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ tasks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tasks/all — employer sees all their tasks
router.get('/all', authEmployer, async (req, res) => {
  try {
    await expireStaleOffers();
    const tasks = await prisma.task.findMany({
      where: { employerId: req.employerId },
      include: { acceptedBy: { select: { fullName: true, workerId: true, phone: true } }, reviews: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tasks/mine — worker sees their active task
router.get('/mine', authWorker, async (req, res) => {
  try {
    await expireStaleOffers();
    const tasks = await prisma.task.findMany({
      where: { workerId: req.workerId, status: { in: ['offered', 'accepted', 'pending_confirmation', 'employer_confirmed'] } },
      include: { employer: { select: { orgName: true, contactPerson: true, phone: true, address: true } }, reviews: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/tasks/:id/accept — worker accepts a task
router.patch('/:id/accept', authWorker, async (req, res) => {
  try {
    // Atomic claim: only succeeds if the task is still 'open' at the moment
    // this exact query runs. Now that any worker can browse and accept open
    // tasks, two people tapping Accept on the same job at the same time is
    // a real scenario — updateMany with status in the WHERE clause means
    // whichever request reaches Postgres first wins, and the second one's
    // WHERE simply matches zero rows instead of silently overwriting the
    // first worker's claim.
    const result = await prisma.task.updateMany({
      where: { id: req.params.id, status: 'open' },
      data: { status: 'accepted', workerId: req.workerId }
    });
    if (result.count === 0) {
      return res.status(409).json({ error: 'This job was just taken by another worker.' });
    }
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    res.json({ task });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/tasks/:id/accept-offer — worker accepts a direct dispatch offer
router.patch('/:id/accept-offer', authWorker, async (req, res) => {
  try {
    const existing = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.workerId !== req.workerId || existing.status !== 'offered') {
      return res.status(400).json({ error: 'This offer is no longer available to respond to.' });
    }
    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: { status: 'accepted' },
      include: {
        acceptedBy: { select: { fullName: true } },
        employer: { select: { phone: true, contactPerson: true } }
      }
    });
    res.json({ task });

    if (task.employer?.phone) {
      const workerFirstName = (task.acceptedBy?.fullName || 'The worker').split(' ')[0];
      const contactFirstName = (task.employer.contactPerson || '').split(' ')[0] || 'there';
      sendSMS(task.employer.phone, `Hi ${contactFirstName}, BeyondX here. ${workerFirstName} accepted the "${task.taskType}" task and will be dispatched as planned.`);
    }

    // Multi-worker slots: if this task is part of a group (job needing
    // several people), check whether the group is now fully staffed. If so,
    // withdraw the remaining un-accepted offers so those workers stop seeing
    // it, and let the employer know the job is fully covered.
    if (task.groupId && task.slotsNeeded) {
      const siblings = await prisma.task.findMany({ where: { groupId: task.groupId } });
      const acceptedCount = siblings.filter(s => ['accepted', 'pending_confirmation', 'employer_confirmed', 'completed'].includes(s.status)).length;
      if (acceptedCount >= task.slotsNeeded) {
        const stillOffered = siblings.filter(s => s.status === 'offered');
        if (stillOffered.length) {
          await prisma.task.updateMany({
            where: { id: { in: stillOffered.map(s => s.id) } },
            data: { status: 'cancelled', workerId: null },
          });
        }
        const emp = await prisma.employer.findUnique({ where: { id: task.employerId }, select: { phone: true, contactPerson: true } });
        if (emp?.phone) {
          const contactFirstName = (emp.contactPerson || '').split(' ')[0] || 'there';
          sendSMS(emp.phone, `Hi ${contactFirstName}, BeyondX here. Your "${task.taskType}" job is now fully staffed — all ${task.slotsNeeded} worker${task.slotsNeeded > 1 ? 's have' : ' has'} been confirmed.`);
        }
      }
    }
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/tasks/:id/decline-offer — worker declines a direct dispatch offer.
// The task goes back to the open pool (workerId cleared) so the employer's
// job doesn't just vanish — it becomes available for another worker, and the
// employer is notified so they can dispatch someone else directly if they prefer.
router.patch('/:id/decline-offer', authWorker, async (req, res) => {
  try {
    const existing = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { acceptedBy: { select: { fullName: true } }, employer: { select: { phone: true, contactPerson: true, orgName: true } } }
    });
    if (!existing || existing.workerId !== req.workerId || existing.status !== 'offered') {
      return res.status(400).json({ error: 'This offer is no longer available to respond to.' });
    }
    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: { status: 'open', workerId: null }
    });
    res.json({ task });

    if (existing.employer?.phone) {
      const workerFirstName = (existing.acceptedBy?.fullName || 'The worker').split(' ')[0];
      const contactFirstName = (existing.employer.contactPerson || '').split(' ')[0] || 'there';
      const message = `Hi ${contactFirstName}, BeyondX here. ${workerFirstName} declined the "${existing.taskType}" task. It's back in the open pool, or you can dispatch a different worker directly from your dashboard.`;
      sendSMS(existing.employer.phone, message);
    }
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/tasks/:id/worker-done — worker marks task as done
router.patch('/:id/worker-done', authWorker, async (req, res) => {
  try {
    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: { status: 'pending_confirmation' },
      include: {
        acceptedBy: { select: { fullName: true } },
        employer: { select: { orgName: true, phone: true, contactPerson: true } }
      }
    });
    res.json({ task });

    // Fire-and-forget — don't make the worker wait on this.
    if (task.employer?.phone) {
      const workerFirstName = (task.acceptedBy?.fullName || 'Your worker').split(' ')[0];
      const contactFirstName = (task.employer.contactPerson || '').split(' ')[0] || 'there';
      const message = `Hi ${contactFirstName}, BeyondX here. ${workerFirstName} has marked "${task.taskType}" as done. Please log in to your BeyondX dashboard to confirm the work so payment can proceed.`;
      sendSMS(task.employer.phone, message);
    }
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/tasks/:id/complete — employer confirms work is done (moves to pending_confirmation for admin to pay)
router.patch('/:id/complete', authEmployer, async (req, res) => {
  try {
    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: { status: 'employer_confirmed' }
    });
    res.json({ task });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/tasks/:id/review — either the worker reviews the employer, or the
// employer reviews the worker, once the work has been confirmed done. Each
// party can review a given task exactly once (enforced by a unique
// constraint on taskId+fromRole). Submitting a review recalculates the
// receiving party's average rating across all their reviews.
router.post('/:id/review', authEitherParty, async (req, res) => {
  const numRating = parseInt(req.body.rating, 10);
  const comment = req.body.comment || null;
  if (!numRating || numRating < 1 || numRating > 5) {
    return res.status(400).json({ error: 'Rating must be a number between 1 and 5.' });
  }
  try {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (!['employer_confirmed', 'completed'].includes(task.status)) {
      return res.status(400).json({ error: 'This task has not been confirmed as done yet.' });
    }

    if (req.role === 'worker') {
      if (task.workerId !== req.userId) return res.status(403).json({ error: 'This is not your task.' });
    } else {
      if (task.employerId !== req.userId) return res.status(403).json({ error: 'This is not your task.' });
    }

    const existing = await prisma.review.findUnique({
      where: { taskId_fromRole: { taskId: task.id, fromRole: req.role } }
    });
    if (existing) return res.status(409).json({ error: 'You have already reviewed this task.' });

    const review = await prisma.review.create({
      data: {
        taskId: task.id,
        fromRole: req.role,
        rating: numRating,
        comment,
        // The review is ABOUT whichever party did not write it.
        workerId: req.role === 'employer' ? task.workerId : null,
        employerId: req.role === 'worker' ? task.employerId : null
      }
    });

    if (req.role === 'employer' && task.workerId) {
      const agg = await prisma.review.aggregate({
        where: { workerId: task.workerId },
        _avg: { rating: true }
      });
      await prisma.worker.update({
        where: { id: task.workerId },
        data: { rating: agg._avg.rating || 0 }
      });
    } else if (req.role === 'worker') {
      const agg = await prisma.review.aggregate({
        where: { employerId: task.employerId },
        _avg: { rating: true }
      });
      await prisma.employer.update({
        where: { id: task.employerId },
        data: { rating: agg._avg.rating || 0 }
      });
    }

    res.status(201).json({ review });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

// GET /api/tasks/worker-history — worker's completed tasks
router.get('/worker-history', authWorker, async (req, res) => {
  try {
    const tasks = await prisma.task.findMany({
      where: { workerId: req.workerId, status: 'completed' },
      include: { employer: { select: { orgName: true } }, reviews: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ tasks });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});
