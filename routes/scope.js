// routes/scope.js
// Scope form (pre-quote), tiered pricing engine, and scope dispute flow.

const express = require('express');
const router  = express.Router();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg }    = require('@prisma/adapter-pg');
const { sendSMS }     = require('../utils/sms');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma  = new PrismaClient({ adapter });

const COMMISSION = 20; // GH₵20 flat per worker dispatched
const DISPUTE_AUTO_ESCALATE_THRESHOLD = 0.20; // 20% above original price

function authEmployer(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const jwt = require('jsonwebtoken');
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
    const jwt = require('jsonwebtoken');
    const d = jwt.verify(token, process.env.JWT_SECRET);
    if (d.role !== 'worker') return res.status(403).json({ error: 'Not a worker' });
    req.workerId = d.id;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── PRICE TIERS ──────────────────────────────────────────────────────────

// GET /api/scope/tiers — public, returns all price tiers for the frontend
router.get('/tiers', async (req, res) => {
  try {
    const tiers = await prisma.priceTier.findMany({ orderBy: [{ category: 'asc' }, { tier: 'asc' }] });
    res.json({ tiers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── QUOTE CALCULATION ────────────────────────────────────────────────────

function calcQuote({ basePrice, materialsSurcharge, materialsProvided, workersNeeded = 1 }) {
  const materialsCost = materialsProvided ? 0 : (materialsSurcharge || 0);
  const workerCost    = basePrice + materialsCost;
  const commission    = COMMISSION * workersNeeded;
  return {
    workerRate:    workerCost,
    commission:    commission,
    totalPerWorker: workerCost + COMMISSION,
    total:         workerCost * workersNeeded + commission,
    breakdown: {
      basePrice,
      materialsSurcharge: materialsProvided ? 0 : (materialsSurcharge || 0),
      commissionPerWorker: COMMISSION,
      workersNeeded,
    }
  };
}

// POST /api/scope/quote — calculate a price quote without saving
// Body: { category, tier, materialsProvided, workersNeeded }
router.post('/quote', authEmployer, async (req, res) => {
  const { category, tier, materialsProvided, workersNeeded = 1 } = req.body;
  if (!category || !tier) return res.status(400).json({ error: 'category and tier required' });
  try {
    const priceTier = await prisma.priceTier.findUnique({ where: { category_tier: { category, tier } } });
    if (!priceTier) return res.status(404).json({ error: `No price tier found for ${category} / ${tier}` });
    const quote = calcQuote({ ...priceTier, materialsProvided, workersNeeded });
    res.json({ quote, tier: priceTier });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SCOPE FORM ───────────────────────────────────────────────────────────

// POST /api/scope — employer submits scope form, gets a quote back
router.post('/', authEmployer, async (req, res) => {
  const { category, tier, estimatedHours, materialsProvided, notes, photoUrls, workersNeeded = 1 } = req.body;
  if (!category || !tier || !estimatedHours) {
    return res.status(400).json({ error: 'category, tier and estimatedHours are required' });
  }
  try {
    const priceTier = await prisma.priceTier.findUnique({ where: { category_tier: { category, tier } } });
    if (!priceTier) return res.status(404).json({ error: `No pricing found for ${category} / ${tier}. Contact BeyondX.` });

    const quote = calcQuote({ ...priceTier, materialsProvided: materialsProvided ?? false, workersNeeded });

    const scope = await prisma.taskScope.create({
      data: {
        employerId:       req.employerId,
        category,
        tier,
        estimatedHours:   parseFloat(estimatedHours),
        materialsProvided: materialsProvided ?? false,
        notes:            notes || null,
        photoUrls:        photoUrls || [],
        quotedPrice:      quote.total,
      }
    });

    res.status(201).json({ scope, quote });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/scope/:id — get a scope record
router.get('/:id', authEmployer, async (req, res) => {
  try {
    const scope = await prisma.taskScope.findUnique({ where: { id: req.params.id } });
    if (!scope || scope.employerId !== req.employerId) return res.status(404).json({ error: 'Not found' });
    res.json({ scope });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/scope/:id/link-task — link a scope to the task created from it
router.patch('/:id/link-task', authEmployer, async (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });
  try {
    const scope = await prisma.taskScope.update({ where: { id: req.params.id }, data: { taskId } });
    res.json({ scope });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SCOPE DISPUTES ───────────────────────────────────────────────────────

// POST /api/scope/dispute — worker flags scope escalation mid-task
router.post('/dispute', authWorker, async (req, res) => {
  const { taskId, reason, requestedPrice } = req.body;
  if (!taskId || !reason || !requestedPrice) {
    return res.status(400).json({ error: 'taskId, reason and requestedPrice are required' });
  }
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: { employer: { select: { phone: true, contactPerson: true } } }
    });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.workerId !== req.workerId) return res.status(403).json({ error: 'Not your task' });

    const originalPrice = Number(task.pay);
    const priceIncrease = (requestedPrice - originalPrice) / originalPrice;
    const requiresEmployerConfirm = priceIncrease > DISPUTE_AUTO_ESCALATE_THRESHOLD;

    const dispute = await prisma.scopeDispute.create({
      data: {
        taskId,
        flaggedBy:              req.workerId,
        reason,
        originalPrice,
        requestedPrice:         parseFloat(requestedPrice),
        status:                 'pending',
        requiresEmployerConfirm,
      }
    });

    // Notify admin via SMS (not employer) — keep it short
    const adminPhone = process.env.ADMIN_PHONE;
    if (adminPhone) {
      sendSMS(adminPhone,
        `BeyondX: Scope dispute on task ${taskId.slice(-6)}. Requested GH${requestedPrice} (was GH${originalPrice}). ${requiresEmployerConfirm ? 'AUTO-ESCALATED (>20%).' : 'Review in console.'}`
      ).catch(() => null);
    }

    res.status(201).json({ dispute, requiresEmployerConfirm });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/scope/disputes/task/:taskId — get disputes for a task
router.get('/disputes/task/:taskId', authWorker, async (req, res) => {
  try {
    const disputes = await prisma.scopeDispute.findMany({
      where: { taskId: req.params.taskId },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ disputes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
