// routes/coordinators.js
// Coordinator account type — distinct from individual workers.
// Coordinators submit custom rates; GH₵20/worker commission still applies.

const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const prisma  = require('../lib/prisma');

const COMMISSION = 20; // GH₵20 flat per worker dispatched

function authCoordinator(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const d = jwt.verify(token, process.env.JWT_SECRET);
    if (d.role !== 'coordinator') return res.status(403).json({ error: 'Not a coordinator' });
    req.coordinatorId = d.id;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// POST /api/coordinators/register
router.post('/register', async (req, res) => {
  const { fullName, phone, pin, orgName, email } = req.body;
  if (!fullName || !phone || !pin) return res.status(400).json({ error: 'fullName, phone and pin required' });
  try {
    const exists = await prisma.coordinator.findUnique({ where: { phone }, select: { id: true } });
    if (exists) return res.status(409).json({ error: 'A coordinator account already exists for this phone number' });
    const pinHash = await bcrypt.hash(String(pin), 12);
    const coordinator = await prisma.coordinator.create({ data: { fullName, phone, pinHash, orgName, email } });
    const token = jwt.sign({ id: coordinator.id, role: 'coordinator' }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, coordinator: { id: coordinator.id, fullName, phone, orgName } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/coordinators/login
router.post('/login', async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ error: 'phone and pin required' });
  try {
    const coordinator = await prisma.coordinator.findUnique({
      where: { phone },
      select: { id: true, isActive: true, pinHash: true, fullName: true, orgName: true },
    });
    if (!coordinator || !coordinator.isActive) return res.status(401).json({ error: 'Account not found or inactive' });
    if (typeof coordinator.pinHash !== 'string' || !coordinator.pinHash) {
      console.error(`[coordinator-login] coordinator ${coordinator.id} has no valid pinHash`);
      return res.status(401).json({ error: 'Incorrect PIN' });
    }
    const valid = await bcrypt.compare(String(pin), coordinator.pinHash);
    if (!valid) return res.status(401).json({ error: 'Incorrect PIN' });
    const token = jwt.sign({ id: coordinator.id, role: 'coordinator' }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, coordinator: { id: coordinator.id, fullName: coordinator.fullName, phone, orgName: coordinator.orgName } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/coordinators/dispatch — coordinator creates a job at a custom rate
router.post('/dispatch', authCoordinator, async (req, res) => {
  const { taskId, workersDispatched, negotiatedRate } = req.body;
  if (!taskId || !workersDispatched || !negotiatedRate) {
    return res.status(400).json({ error: 'taskId, workersDispatched and negotiatedRate required' });
  }
  try {
    const commission = COMMISSION * parseInt(workersDispatched, 10);
    const dispatch = await prisma.coordinatorDispatch.create({
      data: {
        coordinatorId:   req.coordinatorId,
        taskId,
        workersDispatched: parseInt(workersDispatched, 10),
        negotiatedRate:  parseFloat(negotiatedRate),
        commission,
      }
    });
    // Update coordinator totals
    await prisma.coordinator.update({
      where: { id: req.coordinatorId },
      data: {
        totalJobs:      { increment: 1 },
        totalWorkers:   { increment: parseInt(workersDispatched, 10) },
        totalCommission: { increment: commission },
      }
    });
    res.status(201).json({ dispatch });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/coordinators/me — coordinator's own analytics
router.get('/me', authCoordinator, async (req, res) => {
  try {
    const coordinator = await prisma.coordinator.findUnique({ where: { id: req.coordinatorId } });
    const dispatches  = await prisma.coordinatorDispatch.findMany({
      where: { coordinatorId: req.coordinatorId },
      orderBy: { createdAt: 'desc' }
    });
    const avgJobValue = dispatches.length
      ? dispatches.reduce((s, d) => s + d.negotiatedRate * d.workersDispatched, 0) / dispatches.length
      : 0;
    res.json({ coordinator, dispatches, avgJobValue });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
