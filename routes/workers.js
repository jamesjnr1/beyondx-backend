require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma  = new PrismaClient({ adapter });
const router  = express.Router();

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

const VALID_SKILLS = [
  'Facility & Cleaning', 'Logistics & Delivery', 'Maintenance & Repairs',
  'Event & Hospitality', 'Agriculture & Environment', 'Retail & Trade',
  'Community Services'
];

// GET /api/workers — get all active workers. Busy workers (currently on a
// job) are still shown, marked via isBusy, rather than hidden entirely —
// employers should be able to see the full pool and when someone frees up.
router.get('/', async (req, res) => {
  try {
    const workers = await prisma.worker.findMany({
      where: { isActive: true },
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
        offenseLevel:   true,
        gpsVerified:    true,
        prisonFacility: true,
        photoUrl:       true,
        tasks: {
          where: { status: { in: ['offered', 'accepted', 'pending_confirmation'] } },
          select: { id: true }
        },
        reviewsReceived: {
          where: { fromRole: 'employer' },
          select: {
            rating: true, comment: true, createdAt: true,
            task: { select: { taskType: true, employer: { select: { orgName: true } } } }
          },
          orderBy: { createdAt: 'desc' }
        }
      }
    });
    // Flatten task->employer.orgName into a simple reviewerName field,
    // and turn the active-task lookup into a simple isBusy flag.
    const flattened = workers.map(w => ({
      ...w,
      isBusy: (w.tasks || []).length > 0,
      tasks: undefined,
      reviewsReceived: (w.reviewsReceived || []).map(r => ({
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
        taskType: r.task?.taskType || null,
        reviewerName: r.task?.employer?.orgName || 'A BeyondX Employer'
      }))
    }));
    res.json({ workers: flattened });
  } catch (err) {
    console.error('Fetch workers error:', err);
    res.status(500).json({ error: 'Could not fetch workers' });
  }
});

// GET /api/workers/me — the logged-in worker's own full profile
router.get('/me', authWorker, async (req, res) => {
  try {
    const worker = await prisma.worker.findUnique({
      where: { id: req.workerId },
      select: {
        workerId: true, fullName: true, phone: true, prisonFacility: true,
        skills: true, bio: true, dailyCharge: true, rating: true,
        tasksCompleted: true, totalEarned: true, gpsVerified: true,
        guarantorName: true, guarantorPhone: true, guarantorRelationship: true,
        photoUrl: true,
        reviewsReceived: {
          where: { fromRole: 'employer' },
          select: { rating: true, comment: true, createdAt: true },
          orderBy: { createdAt: 'desc' }
        }
      }
    });
    if (!worker) return res.status(404).json({ error: 'Worker not found' });
    res.json({ worker });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/workers/me — a worker updates their own skills/bio.
// Deliberately limited: workers cannot change their name, phone, PIN, or
// guarantor details here — those go through support, to keep identity
// verification meaningful.
router.patch('/me', authWorker, async (req, res) => {
  const { skills, bio, photoUrl } = req.body;
  const data = {};
  if (skills !== undefined) {
    if (!Array.isArray(skills) || skills.length === 0) {
      return res.status(400).json({ error: 'Select at least one skill.' });
    }
    const invalid = skills.filter(s => !VALID_SKILLS.includes(s));
    if (invalid.length) {
      return res.status(400).json({ error: `Unrecognized skill(s): ${invalid.join(', ')}` });
    }
    data.skills = skills;
  }
  if (bio !== undefined) {
    data.bio = String(bio).slice(0, 500);
  }
  if (photoUrl !== undefined) {
    if (typeof photoUrl !== 'string' || !photoUrl.startsWith('https://')) {
      return res.status(400).json({ error: 'Invalid photo URL.' });
    }
    data.photoUrl = photoUrl;
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }
  try {
    const worker = await prisma.worker.update({ where: { id: req.workerId }, data });
    res.json({ worker });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
