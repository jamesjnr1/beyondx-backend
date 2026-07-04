const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const jwt = require('jsonwebtoken');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Sends an SMS via Arkesel. Requires ARKESEL_API_KEY (and optionally
// ARKESEL_SENDER_ID, defaults to 'BeyondX') set in the environment.
// Never throws — a failed SMS should never break the task/dispatch flow.
async function sendArkeselSMS(phone, message) {
  if (!process.env.ARKESEL_API_KEY) {
    console.error('ARKESEL_API_KEY is not set — SMS skipped.');
    return;
  }
  if (!phone) {
    console.error('No phone number on file — SMS skipped.');
    return;
  }
  const recipient = phone.replace(/\s+/g, '').replace(/^0/, '233');
  try {
    const resp = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
      method: 'POST',
      headers: {
        'api-key': process.env.ARKESEL_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: process.env.ARKESEL_SENDER_ID || 'BeyondX',
        message,
        recipients: [recipient]
      })
    });
    const data = await resp.json();
    if (data.code !== 'ok') {
      console.error('Arkesel SMS failed:', data);
    }
  } catch (err) {
    console.error('Arkesel SMS error:', err);
  }
}

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
  const { taskType, description, location, duration, pay, workerId } = req.body;
  if (!taskType || !location || !pay) return res.status(400).json({ error: 'taskType, location and pay are required' });
  try {
    if (workerId) {
      const activeTask = await prisma.task.findFirst({
        where: { workerId, status: { in: ['accepted', 'pending_confirmation'] } }
      });
      if (activeTask) {
        return res.status(409).json({ error: 'This worker is already on a job and is not available to dispatch right now.' });
      }
    }

    const data = {
      employerId: req.employerId,
      taskType,
      description: description || '',
      location,
      duration: duration || '1 day',
      pay: parseFloat(pay)
    };
    if (workerId) {
      data.workerId = workerId;
      data.status = 'accepted';
    }

    const task = await prisma.task.create({
      data,
      include: {
        acceptedBy: { select: { fullName: true, phone: true } },
        employer: { select: { orgName: true } }
      }
    });

    if (workerId && task.acceptedBy) {
      const firstName = (task.acceptedBy.fullName || '').split(' ')[0] || 'there';
      const message = `Hi ${firstName}, BeyondX here. You've been dispatched to a new task: ${taskType} at ${location} for ${task.employer.orgName}. Pay: GHS ${task.pay}. Check your BeyondX dashboard for full details.`;
      // Fire-and-forget: don't make the employer wait on a third-party SMS
      // API call before their dispatch confirmation comes back. Errors are
      // still logged inside sendArkeselSMS itself.
      sendArkeselSMS(task.acceptedBy.phone, message);
    }

    res.status(201).json({ task });
  } catch (err) {
    console.error(err);
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
    const tasks = await prisma.task.findMany({
      where: { workerId: req.workerId, status: { in: ['accepted', 'pending_confirmation', 'employer_confirmed'] } },
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
    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: { status: 'accepted', workerId: req.workerId }
    });
    res.json({ task });
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
      sendArkeselSMS(task.employer.phone, message);
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
