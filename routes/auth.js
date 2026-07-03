const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma  = new PrismaClient({ adapter });
const router  = express.Router();

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

// GET /api/auth/employer-profile — the logged-in employer's own profile
router.get('/employer-profile', authEmployer, async (req, res) => {
  try {
    const employer = await prisma.employer.findUnique({
      where: { id: req.employerId },
      select: {
        orgName: true, contactPerson: true, email: true, phone: true,
        region: true, isVerified: true, rating: true, logoUrl: true
      }
    });
    if (!employer) return res.status(404).json({ error: 'Employer not found' });
    res.json({ employer });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/auth/employer-profile — update contact person, phone, or region.
// Org name and email are deliberately not editable here since they're tied
// to login/identity — those go through support if they genuinely need to change.
router.patch('/employer-profile', authEmployer, async (req, res) => {
  const { contactPerson, phone, region, logoUrl } = req.body;
  const data = {};
  if (contactPerson !== undefined) {
    if (!contactPerson.trim()) return res.status(400).json({ error: 'Contact person cannot be empty.' });
    data.contactPerson = contactPerson.trim();
  }
  if (phone !== undefined) {
    if (!/^0[2357]\d{8}$/.test(phone)) return res.status(400).json({ error: 'Please provide a valid Ghana phone number.' });
    data.phone = phone;
  }
  if (region !== undefined) data.region = region;
  if (logoUrl !== undefined) {
    if (typeof logoUrl !== 'string' || !logoUrl.startsWith('https://')) {
      return res.status(400).json({ error: 'Invalid logo URL.' });
    }
    data.logoUrl = logoUrl;
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }
  try {
    const employer = await prisma.employer.update({ where: { id: req.employerId }, data });
    res.json({ employer });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

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
        email:         employer.email,
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
        email:      employer.email,
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
    const pinHash = await bcrypt.hash(pin, 10);

    // Generate a unique worker ID by finding the highest existing BX-##### and
    // incrementing it — count() alone is unsafe here (if any worker was ever
    // deleted, or IDs became non-sequential, count+1 can collide with an
    // existing ID). We also retry on the rare chance of a race condition
    // between two simultaneous registrations.
    let worker;
    let lastError;
    for (let attempt = 0; attempt < 5; attempt++) {
      const lastWorker = await prisma.worker.findFirst({
        orderBy: { workerId: 'desc' },
        select: { workerId: true }
      });
      let nextNum = 1;
      if (lastWorker && lastWorker.workerId) {
        const match = lastWorker.workerId.match(/BX-(\d+)/);
        if (match) nextNum = parseInt(match[1], 10) + 1 + attempt;
      } else {
        nextNum = 1 + attempt;
      }
      const workerId = `BX-${String(nextNum).padStart(5, '0')}`;

      try {
        worker = await prisma.worker.create({
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
        break; // success
      } catch (err) {
        if (err.code === 'P2002') {
          lastError = err;
          continue; // workerId collision — try the next number
        }
        throw err; // some other error — don't swallow it
      }
    }
    if (!worker) {
      throw lastError || new Error('Could not generate a unique worker ID after multiple attempts.');
    }

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
