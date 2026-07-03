const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma  = new PrismaClient({ adapter });
const router  = express.Router();
// ── WORKER LOGIN ──────────────────────────────
// POST /api/auth/worker-login
// Body: { workerId, pin }
router.post('/worker-login', async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ error: 'Phone and PIN are required' });

  try {
    const worker = await prisma.worker.findFirst({ where: { phone } });
    if (!worker) return res.status(401).json({ error: 'No account found with that phone number.' });

    const valid = await bcrypt.compare(pin, worker.pinHash);
    if (!valid) return res.status(401).json({ error: 'Incorrect PIN.' });

    const token = jwt.sign(
      { id: worker.id, workerId: worker.workerId, role: 'worker' },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

  res.json({
  token,
  worker: {
    workerId: worker.workerId,
    fullName: worker.fullName,
    phone: worker.phone,
    tasksCompleted: worker.tasksCompleted,
    totalEarned: worker.totalEarned,
    rating: worker.rating,
    skills: worker.skills
  }
});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
// ── EMPLOYER LOGIN ────────────────────────────
// POST /api/auth/employer-login
// Body: { email, password }
router.post('/employer-login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const employer = await prisma.employer.findUnique({
      where: { email: email.toLowerCase().trim() }
    });

    if (!employer) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, employer.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: employer.id, role: 'employer' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      employer: {
        orgName:       employer.orgName,
        contactPerson: employer.contactPerson,
        isVerified:    employer.isVerified,
        acknowledgedAt: employer.acknowledgedAt
      }
    });

  } catch (err) {
    console.error('Employer login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── EMPLOYER REGISTER ─────────────────────────
// POST /api/auth/employer-register
// Body: { email, password, orgName, contactPerson, phone, address, region }
router.post('/employer-register', async (req, res) => {
  const { email, password, orgName, contactPerson, phone, address, region } = req.body;

  if (!email || !password || !orgName) {
    return res.status(400).json({ error: 'Email, password and organisation name are required' });
  }

  try {
    const existing = await prisma.employer.findUnique({
      where: { email: email.toLowerCase().trim() }
    });

    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const employer = await prisma.employer.create({
      data: {
        email:         email.toLowerCase().trim(),
        passwordHash,
        orgName,
        contactPerson,
        phone,
        address,
        region
      }
    });

    const token = jwt.sign(
      { id: employer.id, role: 'employer' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      token,
      employer: {
        orgName:    employer.orgName,
        isVerified: employer.isVerified
      }
    });

  } catch (err) {
    console.error('Employer register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/worker-register
router.post('/worker-register', async (req, res) => {
  const { fullName, phone, prisonFacility, skills, pin, guarantorName, guarantorPhone, guarantorRelationship } = req.body;

  if (!fullName || !pin) {
    return res.status(400).json({ error: 'Full name and PIN are required' });
  }
  if (!guarantorName || !guarantorPhone) {
    return res.status(400).json({ error: 'Guarantor name and phone are required' });
  }

  try {
    // Generate unique worker ID
    const count = await prisma.worker.count();
    const workerId = `BX-${String(count + 1).padStart(5, '0')}`;

    const pinHash = await bcrypt.hash(pin, 10);

    const worker = await prisma.worker.create({
      data: {
        workerId,
        fullName,
        pinHash,
        phone,
        prisonFacility,
        skills:        skills || [],
        isActive:      true,
        gpsVerified:   false,
        dailyCharge:   80,
        rating:        0,
        tasksCompleted: 0,
        totalEarned:   0,
        guarantorName,
        guarantorPhone,
        guarantorRelationship: guarantorRelationship || null
      }
    });

    const token = jwt.sign(
      { id: worker.id, workerId: worker.workerId, role: 'worker' },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.status(201).json({
  token,
  worker: {
    workerId:       worker.workerId,
    fullName:       worker.fullName,
    phone:          worker.phone,
    tasksCompleted: worker.tasksCompleted,
    totalEarned:    worker.totalEarned,
    rating:         worker.rating,
    gpsVerified:    worker.gpsVerified,
    skills:         worker.skills
  }
});

  } catch (err) {
    console.error('Worker register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;