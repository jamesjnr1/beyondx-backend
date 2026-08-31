require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const { calcProximity, calcProximityAsync } = require('../utils/proximity');
const prisma  = require('../lib/prisma');

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
    const { jobLocation } = req.query; // optional: ?jobLocation=Tema
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
        homeArea:       true,
        tasks: {
          where: { status: { in: ['offered', 'accepted', 'pending_confirmation'] } },
          select: { id: true }
        },
        role:           true,
        coordinatorApplication: true,
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
    const flattened = workers.map(w => {
      const proximity = jobLocation
        ? calcProximity(w.homeArea, jobLocation)
        : { available: false };
      return {
        ...w,
        isBusy: (w.tasks || []).length > 0,
        tasks: undefined,
        proximity,
        reviewsReceived: (w.reviewsReceived || []).map(r => ({
          rating: r.rating,
          comment: r.comment,
          createdAt: r.createdAt,
          taskType: r.task?.taskType || null,
          reviewerName: r.task?.employer?.orgName || 'A BeyondX Employer'
        }))
      };
    });
    // When jobLocation is provided, sort: nearby workers first, then by rating
    if (jobLocation) {
      flattened.sort((a, b) => {
        const da = a.proximity?.roadKm ?? 9999;
        const db = b.proximity?.roadKm ?? 9999;
        if (da !== db) return da - db;
        return (Number(b.rating) || 0) - (Number(a.rating) || 0);
      });
    }
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
        photoUrl: true, homeArea: true,
        role: true, coordinatorApplication: true, coordinatorTeam: true,
        coordinatorDisputes: true, coordinatorQuotes: true, coordinatorPayoutSplits: true,
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

// Coordinator state is stored as JSON-in-a-field (see beyondx-website
// src/lib/coordinator.ts for the shapes). Accept either a pre-stringified
// JSON string or a plain object/array, and store it as text either way.
function asJsonString(value, maxLen) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof str !== 'string' || str.length > maxLen) return undefined;
  try { JSON.parse(str); } catch { return undefined; }
  return str;
}

// Only an approved Coordinator may write team/dispute/quote/payout state.
const COORDINATOR_ONLY_FIELDS = {
  coordinatorTeam: 50000,
  coordinatorDisputes: 50000,
  coordinatorQuotes: 50000,
  coordinatorPayoutSplits: 50000,
};

// PATCH /api/workers/me — a worker updates their own skills/bio, or files/
// manages a Coordinator application. Deliberately limited: workers cannot
// change their name, phone, PIN, or guarantor details here — those go
// through support, to keep identity verification meaningful. Role itself
// (worker -> coordinator) is set by BeyondX staff on approval, not here.
router.patch('/me', authWorker, async (req, res) => {
  const { skills, bio, photoUrl, homeArea, coordinatorApplication, ...rest } = req.body;
  const data = {};
  if (homeArea !== undefined) {
    data.homeArea = typeof homeArea === 'string' ? homeArea.trim().slice(0, 200) : null;
  }
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
  if (coordinatorApplication !== undefined) {
    const json = asJsonString(coordinatorApplication, 20000);
    if (json === undefined) return res.status(400).json({ error: 'Invalid coordinator application.' });
    data.coordinatorApplication = json;
  }

  const coordinatorFieldsRequested = Object.keys(COORDINATOR_ONLY_FIELDS).filter(k => rest[k] !== undefined);
  if (coordinatorFieldsRequested.length) {
    const current = await prisma.worker.findUnique({ where: { id: req.workerId }, select: { role: true } });
    if (!current || current.role !== 'coordinator') {
      return res.status(403).json({ error: 'Only approved Coordinators can update team data.' });
    }
    for (const key of coordinatorFieldsRequested) {
      const json = asJsonString(rest[key], COORDINATOR_ONLY_FIELDS[key]);
      if (json === undefined) return res.status(400).json({ error: `Invalid ${key}.` });
      data[key] = json;
    }
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }
  try {
    // No `select` here on purpose: every caller on the frontend (CoordinatorApply,
    // HomeAreaInline, WorkExperienceCard, ProfileModal) ignores this response body
    // and works off the patch it already has locally, so there's nothing to gain
    // by returning the full row — only a full-row select to break if the database
    // is ever missing a column the current schema declares (see PR #3).
    await prisma.worker.update({ where: { id: req.workerId }, data, select: { id: true } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[workers/me PATCH] update failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

// GET /api/workers/proximity?workerHomeArea=Madina&jobLocation=Tema
// Returns proximity & transport allowance. Uses local table first, then
// falls back to Nominatim geocoding so any Ghana location resolves.
router.get('/proximity', async (req, res) => {
  const { workerHomeArea, jobLocation } = req.query;
  if (!workerHomeArea || !jobLocation) {
    return res.status(400).json({ error: 'workerHomeArea and jobLocation are required' });
  }
  try {
    const result = await calcProximityAsync(workerHomeArea, jobLocation);
    res.json(result);
  } catch (err) {
    console.error('[proximity] failed:', err.message);
    res.status(500).json({ error: 'Could not calculate proximity' });
  }
});
