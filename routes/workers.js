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

// GET /api/workers — retired. In the closed-loop model BeyondX selects the
// Xpert, so there is no list of Xperts for employers or the public. The
// Xpert records themselves are kept; staff see them via /admin/workers.
router.get('/', (req, res) => {
  res.status(410).json({ error: 'Xpert listings are no longer available. Request an Xpert and BeyondX will assign one.' });
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
        photoUrl: true, homeArea: true, hasTools: true,
        experienceEntries: true, certifications: true,
        role: true, coordinatorApplication: true, coordinatorTeam: true,
        coordinatorDisputes: true, coordinatorQuotes: true, coordinatorPayoutSplits: true,
        accountStatus: true, applicationNote: true, idType: true, idDocumentUrl: true,
        referenceName: true, referencePhone: true, referenceRelationship: true,
        skillEvidenceUrls: true, experienceSummary: true, activatedAt: true, idVerified: true,
        guarantorOutcome: true, evidenceOutcome: true, referenceOutcome: true, certificationUrls: true,
        reviewsReceived: {
          where: { fromRole: 'employer' },
          select: { rating: true, skillsRating: true, professionalismRating: true, createdAt: true },
          orderBy: { createdAt: 'desc' }
        }
      }
    });
    if (!worker) return res.status(404).json({ error: 'Worker not found' });
    // Plain-language verification steps. Xperts never see internal status names.
    const step = (outcome, map) => map[outcome] || map.default;
    const { guarantorOutcome, evidenceOutcome, referenceOutcome, ...rest } = worker;
    const verificationSteps = [
      { key: 'id', label: 'ID check', state: worker.idVerified ? 'done' : worker.idDocumentUrl ? 'in_progress' : 'needed',
        detail: worker.idVerified ? 'Verified' : worker.idDocumentUrl ? 'We are checking your ID' : 'Upload a photo of your ID' },
      { key: 'guarantor', label: 'Guarantor', ...step(guarantorOutcome, {
        yes: { state: 'done', detail: 'Confirmed' },
        no: { state: 'needed', detail: 'Your guarantor did not confirm. Contact BeyondX.' },
        no_response: { state: 'needed', detail: 'We could not reach your guarantor. Ask them to expect our call.' },
        default: { state: 'in_progress', detail: 'We will call your guarantor to confirm' } }) },
      { key: 'evidence', label: 'Work evidence', ...step(evidenceOutcome, {
        pass: { state: 'done', detail: 'Approved' },
        fail: { state: 'needed', detail: 'Not approved. Contact BeyondX to send new evidence.' },
        default: worker.skillEvidenceUrls?.length ? { state: 'in_progress', detail: 'We are reviewing your work photos' } : { state: 'needed', detail: 'Add photos or a video of your work' } }) },
      { key: 'reference', label: 'Reference', ...step(referenceOutcome, {
        confirmed: { state: 'done', detail: 'Confirmed' },
        unreachable: { state: 'needed', detail: 'We could not reach your reference. Contact BeyondX.' },
        inconclusive: { state: 'in_progress', detail: 'We are following up with your reference' },
        default: { state: 'in_progress', detail: 'We will call your reference' } }) },
    ];
    res.json({ worker: { ...rest, verificationSteps } });
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
  const { skills, bio, photoUrl, homeArea, hasTools, experienceEntries, certifications, coordinatorApplication, ...rest } = req.body;
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
  if (hasTools !== undefined) {
    data.hasTools = Boolean(hasTools);
  }
  if (coordinatorApplication !== undefined) {
    const json = asJsonString(coordinatorApplication, 20000);
    if (json === undefined) return res.status(400).json({ error: 'Invalid coordinator application.' });
    data.coordinatorApplication = json;
  }
  if (experienceEntries !== undefined) {
    const json = asJsonString(experienceEntries, 20000);
    if (json === undefined) return res.status(400).json({ error: 'Invalid work experience.' });
    data.experienceEntries = json;
  }
  if (certifications !== undefined) {
    const json = asJsonString(certifications, 20000);
    if (json === undefined) return res.status(400).json({ error: 'Invalid certifications.' });
    data.certifications = json;
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
