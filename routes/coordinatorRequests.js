// routes/coordinatorRequests.js
//
// A job an employer wants to send to a Worker whose role is 'coordinator'.
// Unlike a normal direct dispatch (routes/tasks.js POST /), a coordinator
// job isn't instantly priced: the employer describes the scope, the
// coordinator inspects it and quotes a price, and BeyondX staff approve or
// reject that quote (see /admin/coordinator-requests in routes/admin.js)
// before a real Task — and any payment collection — exists at all.
//
// Lifecycle: pending_coordinator -> quoted -> admin_approved (Task created)
//                                           -> admin_rejected
//                                -> declined

const express = require('express');
const jwt     = require('jsonwebtoken');
const router  = express.Router();
const prisma  = require('../lib/prisma');
const { sendSMS } = require('../utils/sms');
const { sendPushToUser } = require('../lib/push');

function authEmployer(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const d = jwt.verify(token, process.env.JWT_SECRET);
    if (d.role !== 'employer') return res.status(403).json({ error: 'Not an employer' });
    req.employerId = d.id;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function authWorker(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const d = jwt.verify(token, process.env.JWT_SECRET);
    if (d.role !== 'worker') return res.status(403).json({ error: 'Not a worker' });
    req.workerId = d.id;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

const REQUEST_SELECT = {
  id: true, employerId: true, coordinatorId: true, taskType: true, description: true,
  location: true, duration: true, workersNeeded: true, materialsProvided: true,
  scheduledDate: true, scheduledTime: true, status: true, quotedPrice: true,
  quoteNote: true, quotedAt: true, adminNote: true, resolvedAt: true, taskId: true,
  createdAt: true,
  employer: { select: { orgName: true, phone: true } },
  coordinator: { select: { fullName: true, phone: true, workerId: true } },
};

// POST /api/coordinator-requests — retired: employers no longer choose a coordinator. Existing requests can
// still be quoted and finished below.
router.post('/', authEmployer, (req, res) => {
  res.status(410).json({ error: 'Employers can no longer choose a coordinator. Request an Xpert and BeyondX will assign the right team.' });
});

// GET /api/coordinator-requests/mine — employer's own requests, newest first
router.get('/mine', authEmployer, async (req, res) => {
  try {
    const requests = await prisma.coordinatorJobRequest.findMany({
      where: { employerId: req.employerId },
      select: REQUEST_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ requests: requests.map(r => ({ ...r, coordinator: r.coordinator ? { fullName: r.coordinator.fullName, workerId: r.coordinator.workerId } : null })) });
  } catch (err) {
    console.error('List coordinator requests (employer) error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/coordinator-requests/for-me — coordinator's own inbox
router.get('/for-me', authWorker, async (req, res) => {
  try {
    const requests = await prisma.coordinatorJobRequest.findMany({
      where: { coordinatorId: req.workerId },
      select: REQUEST_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ requests });
  } catch (err) {
    console.error('List coordinator requests (coordinator) error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/coordinator-requests/:id/quote — coordinator accepts & quotes a price
router.patch('/:id/quote', authWorker, async (req, res) => {
  const { price, note } = req.body;
  const parsedPrice = parseFloat(price);
  if (!parsedPrice || parsedPrice <= 0) return res.status(400).json({ error: 'A valid price is required.' });
  try {
    const existing = await prisma.coordinatorJobRequest.findUnique({ where: { id: req.params.id }, select: { coordinatorId: true, status: true } });
    if (!existing || existing.coordinatorId !== req.workerId) return res.status(404).json({ error: 'Request not found' });
    if (existing.status !== 'pending_coordinator') return res.status(409).json({ error: 'This request has already been responded to.' });

    const request = await prisma.coordinatorJobRequest.update({
      where: { id: req.params.id },
      data: { status: 'quoted', quotedPrice: parsedPrice, quoteNote: note || null, quotedAt: new Date() },
      select: REQUEST_SELECT,
    });
    res.json({ request });

    sendPushToUser({ employerId: request.employerId }, {
      title: 'Quote received',
      body: `Your coordinator quoted GHS ${parsedPrice} for "${request.taskType}". Review it in your dashboard.`,
      url: '/',
    });
    if (request.employer?.phone) {
      sendSMS(request.employer.phone, `BeyondX: Your coordinator quoted GHS ${parsedPrice} for "${request.taskType}". Review it in your Employer Dashboard.`).catch(() => null);
    }
  } catch (err) {
    console.error('Quote coordinator request error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/coordinator-requests/:id/decline — coordinator declines the job
router.patch('/:id/decline', authWorker, async (req, res) => {
  try {
    const existing = await prisma.coordinatorJobRequest.findUnique({ where: { id: req.params.id }, select: { coordinatorId: true, status: true } });
    if (!existing || existing.coordinatorId !== req.workerId) return res.status(404).json({ error: 'Request not found' });
    if (existing.status !== 'pending_coordinator') return res.status(409).json({ error: 'This request has already been responded to.' });

    const request = await prisma.coordinatorJobRequest.update({
      where: { id: req.params.id },
      data: { status: 'declined', resolvedAt: new Date() },
      select: REQUEST_SELECT,
    });
    res.json({ request });

    sendPushToUser({ employerId: request.employerId }, {
      title: 'Coordinator declined',
      body: `Your coordinator declined "${request.taskType}". Try another coordinator or post it as an open job.`,
      url: '/',
    });
    if (request.employer?.phone) {
      sendSMS(request.employer.phone, `BeyondX: Your coordinator declined "${request.taskType}". Try another coordinator or post it as an open job from your dashboard.`).catch(() => null);
    }
  } catch (err) {
    console.error('Decline coordinator request error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
