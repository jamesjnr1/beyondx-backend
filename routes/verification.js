const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const jwt = require('jsonwebtoken');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

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

// GET /api/verification/credentials — returns ONLY the public client_id to the frontend
// The secret key NEVER leaves the backend
router.get('/credentials', (req, res) => {
  if (!process.env.METRIC_CLIENT_ID) {
    return res.status(503).json({ error: 'ID verification is not configured yet' });
  }
  res.json({ client_id: process.env.METRIC_CLIENT_ID });
});

// POST /api/verification/save-result — worker submits the result after Metric SDK verification completes
router.post('/save-result', authWorker, async (req, res) => {
  const { idType, idCardNumber, transaction_number, session_status } = req.body;
  if (!idType || !idCardNumber || !transaction_number) {
    return res.status(400).json({ error: 'Missing verification details' });
  }
  try {
    const worker = await prisma.worker.update({
      where: { id: req.workerId },
      data: {
        idVerified: session_status === 'success' || session_status === 'completed',
        idVerificationRef: transaction_number,
        idType,
        idCardNumber
      }
    });
    res.json({ success: true, idVerified: worker.idVerified });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save verification result' });
  }
});

module.exports = router;
