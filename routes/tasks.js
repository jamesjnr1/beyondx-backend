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

// POST /api/tasks — employer posts a task.
// If workerId is included (the employer picked a specific worker and paid
// for them via the dispatch flow), the task is assigned directly to that
// worker instead of being left open, and the worker gets a confirmation SMS.
router.post('/', authEmployer, async (req, res) => {
  const { taskType, description, location, duration, pay, workerId } = req.body;
  if (!taskType || !location || !pay) return res.status(400).json({ error: 'taskType, location and pay are required' });
  try {
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
      await sendArkeselSMS(task.acceptedBy.phone, message);
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
      include: { acceptedBy: { select: { fullName: true, workerId: true, phone: true } } },
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
      include: { employer: { select: { orgName: true, contactPerson: true, phone: true, address: true } } },
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
      data: { status: 'pending_confirmation' }
    });
    res.json({ task });
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

module.exports = router;

// GET /api/tasks/worker-history — worker's completed tasks
router.get('/worker-history', authWorker, async (req, res) => {
  try {
    const tasks = await prisma.task.findMany({
      where: { workerId: req.workerId, status: 'completed' },
      include: { employer: { select: { orgName: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ tasks });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});
