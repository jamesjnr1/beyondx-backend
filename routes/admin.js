const express = require('express');
const router = express.Router();
const { sendSMS } = require('../utils/sms');
const { expireStaleOffers, notifyMatchingWorkers } = require('./tasks');
const { calcProximity } = require('../utils/proximity');
const { sendPushToAudience, sendPushToUser } = require('../lib/push');
const prisma  = require('../lib/prisma');
const { setXpertStatus, StatusError, approvedFirst } = require('../lib/xpertStatus');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'beyondx2026';

// Simple password auth middleware
function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// GET /admin/payouts — tasks pending payment
router.get('/payouts', adminAuth, async (req, res) => {
  try {
    const tasks = await prisma.task.findMany({
      where: { status: 'employer_confirmed' },
      include: {
        acceptedBy: { select: { fullName: true, workerId: true, phone: true } },
        employer: { select: { orgName: true, contactPerson: true, phone: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/all — all tasks overview
router.get('/all', adminAuth, async (req, res) => {
  try {
    await expireStaleOffers();
    const tasks = await prisma.task.findMany({
      include: {
        acceptedBy: { select: { fullName: true, workerId: true, phone: true } },
        employer: { select: { orgName: true, phone: true } },
        reviews: true
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/tasks/:id/paid — mark worker as paid
// PATCH /admin/tasks/:id/status — set task status directly (used by verify-payments flow)
router.patch('/tasks/:id/status', adminAuth, async (req, res) => {
  const { status, adminNote, workerId } = req.body;
  const allowed = ['awaiting_invoice', 'invoice_sent', 'offered', 'payment_pending', 'payment_rejected', 'accepted', 'completed', 'pending_confirmation', 'employer_confirmed', 'open', 'cancelled', 'expired'];
  if (!status || !allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  try {
    // Verify Payments sends 'offered'. For a paid invoice there's no Xpert
    // assigned yet, so the task opens to matching Xperts instead.
    let finalStatus = status;
    let openedFromInvoice = false;
    if (status === 'offered' && !workerId) {
      const current = await prisma.task.findUnique({ where: { id: req.params.id }, select: { workerId: true, status: true } });
      if (current && !current.workerId) {
        finalStatus = 'open';
        openedFromInvoice = current.status === 'payment_pending';
      }
    }
    // Auto-compute transport allowance when assigning a worker to a task.
    let transportAllowance = undefined;
    if (status === 'offered' && workerId) {
      const [existingTask, worker] = await Promise.all([
        prisma.task.findUnique({ where: { id: req.params.id }, select: { location: true } }),
        prisma.worker.findUnique({ where: { id: workerId }, select: { homeArea: true } }),
      ]);
      if (existingTask && worker) {
        const prox = calcProximity(worker.homeArea, existingTask.location);
        if (prox.available) transportAllowance = prox.transportAllowance;
      }
    }
    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: {
        status: finalStatus,
        ...(adminNote ? { adminNote } : {}),
        ...(workerId ? { workerId } : {}),
        ...(transportAllowance !== undefined ? { transportAllowance } : {}),
      },
      include: {
        acceptedBy: { select: { fullName: true, phone: true } },
        employer: { select: { orgName: true, contactPerson: true, phone: true } }
      }
    });

    res.json({ ok: true, task });

    if (openedFromInvoice) {
      notifyMatchingWorkers(task);
      sendPushToUser({ employerId: task.employerId }, {
        title: 'Payment confirmed',
        body: `We're now matching Xperts to "${task.taskType}".`,
        url: '/',
      });
    }

    // Job offer notification — this is where a payment-verified dispatch
    // actually tells the worker (see the payment_pending comment in
    // routes/tasks.js POST /).
    if (finalStatus === 'offered' && task.workerId) {
      const firstName = (task.acceptedBy?.fullName || '').split(' ')[0] || 'there';
      const workerCut = Number(task.pay || 0).toFixed(0);
      sendPushToUser({ workerId: task.workerId }, {
        title: 'New job offer',
        body: `${task.taskType} at ${task.location || 'TBD'} — GHS ${workerCut}`,
        url: '/',
      });
      if (task.acceptedBy?.phone) {
        const sms = `BeyondX: Hi ${firstName}, new job! ${task.taskType} at ${task.location||'TBD'}, ${task.duration||''}. Pay: GH${workerCut}. Accept/decline: beyondxco.com`;
        sendSMS(task.acceptedBy.phone, sms);
      }
    }
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Task not found.' });
    // Surface the real cause — a hidden generic message here has cost hours
    // of debugging before (e.g. the TaskStatus enum missing a value in the
    // live database after a migration was never applied).
    console.error('[admin] status update failed:', err.message);
    res.status(500).json({ error: err.message || 'Server error', code: err.code });
  }
});

// POST /admin/tasks/dispatch-multi — offer a job to several candidate
// workers at once for a posting that needs more than one person.
// Creates one Task row per worker, all sharing a groupId + slotsNeeded, each
// sent the same job-offer SMS. The first `slotsNeeded` to accept fill the
// job; remaining offers auto-withdraw (see accept-offer in routes/tasks.js).
//
// Body: {
//   sourceTaskId?: string,       // an existing 'open' task to copy details from
//   taskType, description, location, duration, pay, employerId,  // OR provide these directly
//   workerIds: string[],         // candidates to offer it to (can exceed slotsNeeded)
//   slotsNeeded: number,
//   offerHours?: number,         // optional — offer expires after this many hours
// }
router.post('/tasks/dispatch-multi', adminAuth, async (req, res) => {
  const { sourceTaskId, workerIds, slotsNeeded, offerHours } = req.body;
  let { taskType, description, location, duration, pay, employerId } = req.body;

  if (!Array.isArray(workerIds) || workerIds.length === 0) {
    return res.status(400).json({ error: 'workerIds must be a non-empty array.' });
  }
  if (!slotsNeeded || slotsNeeded < 1) {
    return res.status(400).json({ error: 'slotsNeeded must be at least 1.' });
  }
  if (workerIds.length < slotsNeeded) {
    return res.status(400).json({ error: `You are offering to ${workerIds.length} worker(s) but need ${slotsNeeded} — offer to at least ${slotsNeeded}.` });
  }

  try {
    if (sourceTaskId) {
      const source = await prisma.task.findUnique({ where: { id: sourceTaskId } });
      if (!source) return res.status(404).json({ error: 'Source task not found.' });
      taskType = taskType || source.taskType;
      description = description ?? source.description;
      location = location || source.location;
      duration = duration || source.duration;
      pay = pay || source.pay;
      employerId = employerId || source.employerId;
    }
    if (!taskType || !location || !duration || !pay || !employerId) {
      return res.status(400).json({ error: 'taskType, location, duration, pay, and employerId are required (directly, or via sourceTaskId).' });
    }

    const groupId = require('crypto').randomUUID();
    const offerExpiresAt = offerHours ? new Date(Date.now() + offerHours * 3600 * 1000) : null;

    // Fetch homeArea for every candidate worker so we can compute per-worker
    // transport allowance before creating the task rows.
    const workerProfiles = await prisma.worker.findMany({
      where: { id: { in: workerIds } },
      select: { id: true, homeArea: true },
    });
    const homeAreaById = Object.fromEntries(workerProfiles.map(w => [w.id, w.homeArea]));

    const created = await prisma.$transaction(
      workerIds.map(workerId => {
        const prox = calcProximity(homeAreaById[workerId], location);
        const transportAllowance = prox.available ? prox.transportAllowance : 0;
        return prisma.task.create({
          data: {
            employerId, taskType, description: description || '', location, duration,
            pay: parseFloat(pay), status: 'offered', workerId,
            groupId, slotsNeeded: parseInt(slotsNeeded, 10), offerExpiresAt,
            transportAllowance,
          },
          include: {
            acceptedBy: { select: { fullName: true, phone: true } },
            employer: { select: { orgName: true, contactPerson: true, phone: true } },
          },
        });
      })
    );

    // If this fanned out from an existing 'open' posting, retire that
    // original row so it doesn't sit around duplicating the group.
    if (sourceTaskId) {
      await prisma.task.update({ where: { id: sourceTaskId }, data: { status: 'cancelled', adminNote: 'Superseded by multi-worker dispatch.' } }).catch(() => null);
    }

    res.json({ ok: true, groupId, tasksCreated: created.length });

    // Notify every candidate worker — SMS kept to 1 segment max so it
    // delivers on all networks.
    for (const task of created) {
      const workerCut = Number(task.pay || 0).toFixed(0);
      sendPushToUser({ workerId: task.workerId }, {
        title: 'New job available',
        body: `${task.taskType} at ${task.location || 'TBD'} — GHS ${workerCut}. First to accept wins.`,
        url: '/',
      });
      if (!task.acceptedBy?.phone) continue;
      const firstName = (task.acceptedBy.fullName || '').split(' ')[0] || 'there';
      const sms = `BeyondX: Hi ${firstName}, new job! ${task.taskType} at ${task.location||'TBD'}, ${task.duration||''}. Pay: GH${workerCut}. First to accept wins: beyondxco.com`;
      sendSMS(task.acceptedBy.phone, sms);
    }
  } catch (err) {
    console.error('[admin] dispatch-multi failed:', err.message);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

router.patch('/tasks/:id/paid', adminAuth, async (req, res) => {
  try {
    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: { status: 'completed' },
      include: { acceptedBy: { select: { fullName: true, phone: true } } }
    });
    if (task.workerId) {
      await prisma.worker.update({
        where: { id: task.workerId },
        data: {
          tasksCompleted: { increment: 1 },
          totalEarned: { increment: task.pay }
        }
      });
    }
    res.json({ task });

    if (task.workerId) {
      const paidAmount = Math.round(parseFloat(task.pay));
      const workerName = (task.acceptedBy?.fullName || '').split(' ')[0] || 'there';
      sendPushToUser({ workerId: task.workerId }, {
        title: 'Payment sent',
        body: `GHS ${paidAmount} has been sent to your Mobile Money. Well done!`,
        url: '/',
      });
      if (task.acceptedBy?.phone) {
        sendSMS(task.acceptedBy.phone, `BeyondX: Hi ${workerName}, GHS ${paidAmount} has been sent to your Mobile Money. Well done!`);
      }
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /admin/clear-data — wipe all tasks, dispatches, and payments (revenue/transactions).
// Workers and Employers themselves are kept, but each worker's cumulative
// tasksCompleted / totalEarned / rating counters are reset to zero since
// those are derived from the transactions being cleared.
router.delete('/clear-data', adminAuth, async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const payments = await tx.payment.deleteMany({});
      const dispatches = await tx.dispatch.deleteMany({});
      const tasks = await tx.task.deleteMany({});
      await tx.worker.updateMany({
        data: { tasksCompleted: 0, totalEarned: 0, rating: 0 }
      });
      return { payments: payments.count, dispatches: dispatches.count, tasks: tasks.count };
    });
    res.json({ success: true, cleared: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /admin/clear-employers — permanently delete ALL employer accounts,
// and everything that references them (their tasks, dispatches, payments,
// and any reviews about them or written by them). Workers themselves are
// NOT deleted, but any worker stats derived from these tasks (tasksCompleted,
// totalEarned) are reset to zero since the underlying transactions are gone.
router.delete('/clear-employers', adminAuth, async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Reviews reference tasks (and optionally employers/workers directly),
      // so clear those first to avoid foreign key errors.
      const reviews = await tx.review.deleteMany({});
      const payments = await tx.payment.deleteMany({});
      const dispatches = await tx.dispatch.deleteMany({});
      const tasks = await tx.task.deleteMany({});
      const employers = await tx.employer.deleteMany({});
      await tx.worker.updateMany({
        data: { tasksCompleted: 0, totalEarned: 0, rating: 0 }
      });
      return {
        employers: employers.count,
        tasks: tasks.count,
        dispatches: dispatches.count,
        payments: payments.count,
        reviews: reviews.count
      };
    });
    res.json({ success: true, cleared: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/workers — full worker data for the admin dashboard, including
// sensitive fields (guarantor name/phone/relationship) that must NEVER be
// exposed through the public /api/workers endpoint employers use to browse.
// GET /admin/employers — full employer list, used for the admin dashboard's
// "message all employers" broadcast option among other things.
router.get('/employers', adminAuth, async (req, res) => {
  try {
    const employers = await prisma.employer.findMany({
      select: {
        id: true,
        orgName: true,
        contactPerson: true,
        phone: true,
        email: true,
        isVerified: true,
        createdAt: true
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ employers });
  } catch (err) {
    console.error('Fetch admin employers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/workers', adminAuth, async (req, res) => {
  try {
    const workers = await prisma.worker.findMany({
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
        totalEarned:    true,
        offenseLevel:   true,
        gpsVerified:    true,
        isActive:       true,
        prisonFacility: true,
        photoUrl:       true,
        hasTools:       true,
        experienceEntries: true,
        certifications:    true,
        guarantorName:  true,
        guarantorPhone: true,
        homeArea:       true,
        homeLat:        true,
        homeLng:        true,
        guarantorRelationship: true,
        createdAt:      true,
        accountStatus:  true,
        xpertStatus:    true,
        activatedAt:    true,
        reverificationRequired: true,
        role:           true,
        coordinatorApplication: true,
        priority:       true,
        featuredTestimonial:       true,
        featuredTestimonialSource: true,
        tasks: {
          where: { status: { in: ['accepted', 'pending_confirmation'] } },
          select: { id: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    // Most recently approved first (see approvedFirst).
    const flattened = approvedFirst(workers).map(w => ({
      ...w,
      isBusy: (w.tasks || []).length > 0,
      tasks: undefined
    }));
    res.json({ workers: flattened });
  } catch (err) {
    console.error('Fetch admin workers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/workers/:id/featured — set (or clear) a worker's manual
// placement boost and/or a staff-curated client testimonial. Both are
// separate from the rating field, which stays computed only from real
// Review rows — this never touches that.
router.patch('/workers/:id/featured', adminAuth, async (req, res) => {
  const { priority, featuredTestimonial, featuredTestimonialSource } = req.body || {};
  try {
    const worker = await prisma.worker.update({
      where: { id: req.params.id },
      data: {
        ...(priority !== undefined ? { priority: Boolean(priority) } : {}),
        ...(featuredTestimonial !== undefined ? { featuredTestimonial: featuredTestimonial || null } : {}),
        ...(featuredTestimonialSource !== undefined ? { featuredTestimonialSource: featuredTestimonialSource || null } : {}),
      },
      select: { id: true, workerId: true, fullName: true, priority: true, featuredTestimonial: true, featuredTestimonialSource: true },
    });
    res.json({ worker });
  } catch (err) {
    console.error('Set worker featured status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── COORDINATOR APPLICATIONS ──────────────────────────────────────────────
// A worker applies to become a Coordinator from their dashboard (see
// beyondx-website src/components/CoordinatorApply.tsx); the application is
// stored as JSON in Worker.coordinatorApplication. Staff review it here and
// approve/deny — approving flips Worker.role to 'coordinator', which is what
// switches that worker over to the Coordinator dashboard on the frontend.

// GET /admin/coordinator-applications?status=pending — defaults to pending.
// Pass status=all to see every worker who has ever applied.
router.get('/coordinator-applications', adminAuth, async (req, res) => {
  try {
    const workers = await prisma.worker.findMany({
      where: { coordinatorApplication: { not: null } },
      select: {
        id: true, workerId: true, fullName: true, phone: true, role: true,
        coordinatorApplication: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    const statusFilter = req.query.status || 'pending';
    const applications = workers
      .map(w => {
        let application = null;
        try { application = JSON.parse(w.coordinatorApplication); } catch { /* malformed — skip */ }
        return application && { workerId: w.workerId, fullName: w.fullName, phone: w.phone, role: w.role, application };
      })
      .filter(Boolean)
      .filter(a => statusFilter === 'all' || a.application.status === statusFilter);
    res.json({ applications });
  } catch (err) {
    console.error('Fetch coordinator applications error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/coordinator-applications/:workerId  { action: 'approve' | 'deny', reviewNote? }
router.patch('/coordinator-applications/:workerId', adminAuth, async (req, res) => {
  const { action, reviewNote } = req.body;
  if (!['approve', 'deny'].includes(action)) {
    return res.status(400).json({ error: "action must be 'approve' or 'deny'" });
  }
  try {
    const worker = await prisma.worker.findUnique({
      where: { workerId: req.params.workerId },
      select: { id: true, coordinatorApplication: true },
    });
    if (!worker) return res.status(404).json({ error: 'Worker not found' });
    let application;
    try { application = JSON.parse(worker.coordinatorApplication); } catch {
      return res.status(400).json({ error: 'This worker has no valid coordinator application on file.' });
    }
    application.status = action === 'approve' ? 'approved' : 'denied';
    if (reviewNote !== undefined) application.reviewNote = reviewNote || undefined;

    await prisma.worker.update({
      where: { id: worker.id },
      data: {
        coordinatorApplication: JSON.stringify(application),
        ...(action === 'approve' ? { role: 'coordinator' } : {}),
      },
      select: { id: true },
    });
    res.json({ ok: true, application });
  } catch (err) {
    console.error('Update coordinator application error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── COORDINATOR TEAMS (roster / team disputes / quotes / payout splits) ──
// Everything an approved Coordinator manages for their own team — logged
// team disputes, job quotes on bulk/team tasks, payout splits, roster —
// lives as JSON-in-a-field on their Worker row (coordinatorTeam,
// coordinatorDisputes, coordinatorQuotes, coordinatorPayoutSplits; see
// beyondx-website src/lib/coordinator.ts and src/pages/CoordinatorDashboard.tsx).
// Surfaced here so staff can review escalated disputes and approve/deny job
// quotes instead of these only being visible via the coordinator's own PIN.
// Distinct from "Coordinator Job Requests" above (one-on-one employer →
// coordinator dispatch) and the standalone "Coordinator Channel" below
// (the separate Coordinator model).
function parseJSONField(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

router.get('/coordinator-teams', adminAuth, async (req, res) => {
  try {
    const workers = await prisma.worker.findMany({
      where: { role: 'coordinator' },
      select: {
        workerId: true, fullName: true, phone: true,
        coordinatorTeam: true, coordinatorDisputes: true,
        coordinatorQuotes: true, coordinatorPayoutSplits: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    const coordinators = workers.map(w => ({
      workerId: w.workerId,
      fullName: w.fullName,
      phone: w.phone,
      team: parseJSONField(w.coordinatorTeam, []),
      disputes: parseJSONField(w.coordinatorDisputes, []),
      quotes: parseJSONField(w.coordinatorQuotes, {}),
      payoutSplits: parseJSONField(w.coordinatorPayoutSplits, {}),
    }));
    res.json({ coordinators });
  } catch (err) {
    console.error('Fetch coordinator teams error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/coordinator-disputes/:workerId/:disputeId  { status }
router.patch('/coordinator-disputes/:workerId/:disputeId', adminAuth, async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required' });
  try {
    const worker = await prisma.worker.findUnique({
      where: { workerId: req.params.workerId },
      select: { id: true, coordinatorDisputes: true },
    });
    if (!worker) return res.status(404).json({ error: 'Coordinator not found' });
    const disputes = parseJSONField(worker.coordinatorDisputes, []);
    const idx = disputes.findIndex(d => String(d.id) === req.params.disputeId);
    if (idx === -1) return res.status(404).json({ error: 'Dispute not found' });
    disputes[idx] = { ...disputes[idx], status };
    await prisma.worker.update({
      where: { id: worker.id },
      data: { coordinatorDisputes: JSON.stringify(disputes) },
    });
    res.json({ ok: true, dispute: disputes[idx] });
  } catch (err) {
    console.error('Update coordinator dispute error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/coordinator-quotes/:workerId/:taskId  { action: 'approve' | 'deny' }
router.patch('/coordinator-quotes/:workerId/:taskId', adminAuth, async (req, res) => {
  const { action } = req.body;
  if (!['approve', 'deny'].includes(action)) {
    return res.status(400).json({ error: "action must be 'approve' or 'deny'" });
  }
  try {
    const worker = await prisma.worker.findUnique({
      where: { workerId: req.params.workerId },
      select: { id: true, coordinatorQuotes: true },
    });
    if (!worker) return res.status(404).json({ error: 'Coordinator not found' });
    const quotes = parseJSONField(worker.coordinatorQuotes, {});
    const quote = quotes[req.params.taskId];
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    quote.status = action === 'approve' ? 'approved' : 'denied';
    quotes[req.params.taskId] = quote;
    await prisma.worker.update({
      where: { id: worker.id },
      data: { coordinatorQuotes: JSON.stringify(quotes) },
    });
    res.json({ ok: true, quote });
  } catch (err) {
    console.error('Update coordinator quote error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── COORDINATOR JOB REQUESTS ────────────────────────────────────────────
// An employer sends a job to a coordinator (see routes/coordinatorRequests.js);
// once the coordinator quotes a price, staff review it here. Approving
// creates the real Task (payment_pending, no paymentRef yet — the employer
// submits one via PATCH /api/tasks/:id/payment-ref, then the existing
// verify-payment flow below takes over unchanged).

const CJR_SELECT = {
  id: true, employerId: true, coordinatorId: true, taskType: true, description: true,
  location: true, duration: true, workersNeeded: true, materialsProvided: true,
  scheduledDate: true, scheduledTime: true, status: true, quotedPrice: true,
  quoteNote: true, quotedAt: true, adminNote: true, resolvedAt: true, taskId: true,
  createdAt: true,
  employer: { select: { orgName: true, phone: true } },
  coordinator: { select: { fullName: true, phone: true, workerId: true } },
};

// GET /admin/coordinator-requests?status=quoted — defaults to quoted (the
// actionable queue). Pass status=all to see every request ever made.
router.get('/coordinator-requests', adminAuth, async (req, res) => {
  try {
    const statusFilter = req.query.status || 'quoted';
    const requests = await prisma.coordinatorJobRequest.findMany({
      where: statusFilter === 'all' ? {} : { status: statusFilter },
      select: CJR_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ requests });
  } catch (err) {
    console.error('Fetch coordinator requests error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/coordinator-requests/:id  { action: 'approve' | 'reject', adminNote? }
router.patch('/coordinator-requests/:id', adminAuth, async (req, res) => {
  const { action, adminNote } = req.body;
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
  }
  try {
    const existing = await prisma.coordinatorJobRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Request not found' });
    if (existing.status !== 'quoted') return res.status(409).json({ error: 'This request is not awaiting a decision.' });

    if (action === 'reject') {
      const request = await prisma.coordinatorJobRequest.update({
        where: { id: req.params.id },
        data: { status: 'admin_rejected', adminNote: adminNote || null, resolvedAt: new Date() },
        select: CJR_SELECT,
      });
      res.json({ request });
      sendPushToUser({ workerId: request.coordinatorId }, {
        title: 'Quote not approved',
        body: `Your quote for "${request.taskType}" was not approved this time.`,
        url: '/',
      });
      if (request.coordinator?.phone) {
        sendSMS(request.coordinator.phone, `BeyondX: Your quote for "${request.taskType}" was not approved this time. Check your Coordinator Dashboard for details.`).catch(() => null);
      }
      return;
    }

    const task = await prisma.task.create({
      data: {
        employerId: existing.employerId,
        workerId: existing.coordinatorId,
        taskType: existing.taskType,
        description: existing.description || '',
        location: existing.location,
        duration: existing.duration,
        pay: existing.quotedPrice,
        status: 'payment_pending',
        ...(existing.workersNeeded > 1 ? { slotsNeeded: existing.workersNeeded } : {}),
        ...(existing.scheduledDate ? { scheduledDate: existing.scheduledDate } : {}),
        ...(existing.scheduledTime ? { scheduledTime: existing.scheduledTime } : {}),
      },
      select: { id: true },
    });
    const request = await prisma.coordinatorJobRequest.update({
      where: { id: req.params.id },
      data: { status: 'admin_approved', adminNote: adminNote || null, resolvedAt: new Date(), taskId: task.id },
      select: CJR_SELECT,
    });
    res.json({ request });
  } catch (err) {
    console.error('Update coordinator request error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/sms-logs — recent SMS send attempts, for the admin dashboard
// to surface delivery problems (especially a depleted Arkesel balance)
// instead of these only being visible in Railway's server logs.
// GET /admin/leads — everyone captured at events, newest first
// ── SCOPE DISPUTES ───────────────────────────────────────────────────────

router.get('/disputes', adminAuth, async (req, res) => {
  try {
    const disputes = await prisma.scopeDispute.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        task: { select: { taskType: true, location: true, pay: true, employer: { select: { orgName: true } } } },
        worker: { select: { fullName: true, phone: true } }
      }
    });
    res.json({ disputes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/disputes/:id', adminAuth, async (req, res) => {
  const { status, adjustedPrice, adminNote } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' });
  try {
    const dispute = await prisma.scopeDispute.update({
      where: { id: req.params.id },
      data: {
        status,
        adjustedPrice: adjustedPrice ? parseFloat(adjustedPrice) : undefined,
        adminNote:     adminNote || null,
        resolvedAt:    new Date(),
      },
      include: { task: { include: { acceptedBy: { select: { phone: true } }, employer: { select: { phone: true } } } } }
    });
    res.json({ dispute });

    // On approval, notify worker and employer
    if (status === 'approved' && adjustedPrice) {
      const { sendSMS } = require('../utils/sms');
      const workerPhone = dispute.task?.acceptedBy?.phone;
      const empPhone    = dispute.task?.employer?.phone;
      if (dispute.task?.workerId) {
        sendPushToUser({ workerId: dispute.task.workerId }, {
          title: 'Scope change approved',
          body: `Adjusted pay: GHS ${adjustedPrice}. ${dispute.requiresEmployerConfirm ? 'Awaiting employer confirmation before you resume.' : 'Continue work.'}`,
          url: '/',
        });
      }
      if (workerPhone) sendSMS(workerPhone, `BeyondX: Scope change approved. Adjusted pay: GH${adjustedPrice}. ${dispute.requiresEmployerConfirm ? 'Awaiting employer confirmation before you resume.' : 'Continue work.'}`).catch(() => null);
      if (dispute.requiresEmployerConfirm && dispute.task?.employerId) {
        sendPushToUser({ employerId: dispute.task.employerId }, {
          title: 'Scope change on your job',
          body: `New price: GHS ${adjustedPrice}. Confirm in your dashboard.`,
          url: '/',
        });
      }
      if (empPhone && dispute.requiresEmployerConfirm) sendSMS(empPhone, `BeyondX: Scope change on your job. New price: GH${adjustedPrice}. Reply to confirm via your dashboard.`).catch(() => null);
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PRICE TIERS ───────────────────────────────────────────────────────────

router.get('/price-tiers', adminAuth, async (req, res) => {
  try {
    const tiers = await prisma.priceTier.findMany({ orderBy: [{ category: 'asc' }, { tier: 'asc' }] });
    res.json({ tiers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/price-tiers/:id', adminAuth, async (req, res) => {
  const { basePrice, materialsSurcharge } = req.body;
  try {
    const tier = await prisma.priceTier.update({
      where: { id: req.params.id },
      data: { basePrice: parseFloat(basePrice), materialsSurcharge: materialsSurcharge != null ? parseFloat(materialsSurcharge) : null }
    });
    res.json({ tier });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── COORDINATOR CHANNEL ───────────────────────────────────────────────────

router.get('/coordinators', adminAuth, async (req, res) => {
  try {
    const coordinators = await prisma.coordinator.findMany({
      include: {
        dispatches: { orderBy: { createdAt: 'desc' } }
      },
      orderBy: { createdAt: 'desc' }
    });
    const enriched = coordinators.map(c => ({
      ...c,
      pinHash: undefined,
      avgJobValue: c.dispatches.length
        ? c.dispatches.reduce((s, d) => s + d.negotiatedRate * d.workersDispatched, 0) / c.dispatches.length
        : 0
    }));
    res.json({ coordinators: enriched });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/leads', adminAuth, async (req, res) => {
  try {
    const leads = await prisma.lead.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ leads });
  } catch (err) {
    console.error('[admin] fetch leads failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/leads/:id — mark a lead as followed up (or un-mark it)
router.patch('/leads/:id', adminAuth, async (req, res) => {
  const { followedUp } = req.body;
  try {
    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: { followedUp: !!followedUp },
    });
    res.json({ lead });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Lead not found.' });
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/sms-logs', adminAuth, async (req, res) => {
  try {
    const logs = await prisma.smsLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    res.json({ logs });
  } catch (err) {
    console.error('Fetch SMS logs error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/visitor-stats — self-hosted visitor -> signup conversion funnel.
// Replaces Vercel Analytics for this specific question: how many people
// look at the site, and how many of those actually register. Query param
// ?days=N restricts to the last N days (default 30); omit or use 0 for all-time.
router.get('/visitor-stats', adminAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 0;
    const since = days > 0 ? new Date(Date.now() - days * 86400000) : null;
    const dateFilter = since ? { firstSeenAt: { gte: since } } : {};

    const [totalVisitors, converted, workerSignups, employerSignups, recent] = await Promise.all([
      prisma.visitor.count({ where: dateFilter }),
      prisma.visitor.count({ where: { ...dateFilter, convertedAt: { not: null } } }),
      prisma.visitor.count({ where: { ...dateFilter, convertedAs: 'worker' } }),
      prisma.visitor.count({ where: { ...dateFilter, convertedAs: 'employer' } }),
      prisma.visitor.findMany({
        where: dateFilter,
        orderBy: { lastSeenAt: 'desc' },
        take: 50,
        select: {
          visitorId: true, firstPath: true, referrer: true, firstSeenAt: true,
          lastSeenAt: true, pageViews: true, convertedAt: true, convertedAs: true,
        },
      }),
    ]);

    const conversionRate = totalVisitors > 0 ? (converted / totalVisitors * 100) : 0;

    res.json({
      totalVisitors, converted, notConverted: totalVisitors - converted,
      workerSignups, employerSignups, conversionRate,
      recent,
    });
  } catch (err) {
    console.error('[admin] visitor-stats failed:', err.message);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// POST /admin/send-sms — lets an admin send a one-off custom SMS to any
// phone number directly from the dashboard (e.g. following up with a
// specific worker or employer outside the automated message flow).
router.post('/send-sms', adminAuth, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });
  try {
    await sendSMS(phone, message);
    res.json({ success: true });
  } catch (err) {
    console.error('Custom SMS send error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/blast-location-request — sends a one-time SMS to every active
// worker who has NOT yet set their homeArea, asking them to log in and add
// their neighbourhood so the proximity matching system can work for them.
router.post('/blast-location-request', adminAuth, async (req, res) => {
  try {
    const workers = await prisma.worker.findMany({
      where: { isActive: true, OR: [{ homeArea: null }, { homeArea: '' }] },
      select: { id: true, fullName: true, phone: true }
    });
    if (workers.length === 0) {
      return res.json({ sent: 0, message: 'All active workers already have a home area set.' });
    }
    let sent = 0, failed = 0;
    for (const w of workers) {
      if (!w.phone) { failed++; continue; }
      const firstName = (w.fullName || 'there').split(' ')[0];
      const msg = [
        `Hi ${firstName}! BeyondX here.`,
        '',
        `We have a new feature — we now match you to jobs near where you live, and add a transport allowance to your pay when a job is far from you.`,
        '',
        `To get this benefit, please log in to your BeyondX dashboard and add your home area (e.g. "Madina" or "Tema"):`,
        `beyondxco.com`,
        '',
        `- The BeyondX Team`
      ].join('\n');
      try {
        await sendSMS(w.phone, msg);
        sent++;
        // Small delay to avoid hitting Arkesel rate limits
        await new Promise(r => setTimeout(r, 120));
      } catch {
        failed++;
      }
    }
    res.json({ sent, failed, total: workers.length });
  } catch (err) {
    console.error('[blast-location-request] failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/send-dormant-reminders — finds workers who haven't logged in
// for 7+ days and texts them a reminder to stay visible to employers.
// Can be triggered manually from the dashboard, or on a schedule via an
// external cron service (e.g. cron-job.org) hitting this endpoint weekly.
router.post('/send-dormant-reminders', adminAuth, async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dormantWorkers = await prisma.worker.findMany({
      where: {
        isActive: true,
        OR: [
          { lastActiveAt: { lt: sevenDaysAgo } },
          { lastActiveAt: null }
        ]
      },
      select: { id: true, fullName: true, phone: true, lastActiveAt: true }
    });

    const message = "We've noticed you haven't been active recently. Log in to BeyondX to stay visible to employers and never miss a job opportunity.";
    dormantWorkers.forEach(w => sendSMS(w.phone, message));

    res.json({ success: true, notified: dormantWorkers.length, workers: dormantWorkers.map(w => ({ fullName: w.fullName, phone: w.phone, lastActiveAt: w.lastActiveAt })) });
  } catch (err) {
    console.error('Send dormant reminders error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/push-broadcast — send a push notification to every device
// subscribed under the given audience. Called from the website's own
// api/notifications.js (beyondx-website, Vercel) right after it saves an
// admin announcement to Supabase, so the existing "send a notification to
// workers/employers/everyone" admin feature also reaches people as a real
// push, not just the in-app bell. Kept as its own small endpoint (rather
// than exposing prisma/PushSubscription directly to that Vercel function)
// since VAPID keys and PushSubscription storage both live only here.
router.post('/push-broadcast', adminAuth, async (req, res) => {
  const audience = String(req.body?.audience || '').trim();
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  if (!['worker', 'employer', 'all'].includes(audience)) {
    return res.status(400).json({ error: 'audience must be worker, employer or all.' });
  }
  if (!title || !body) return res.status(400).json({ error: 'title and body are required.' });

  try {
    await sendPushToAudience(audience, { title, body, url: '/' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/push-broadcast]', err.message);
    res.status(500).json({ error: 'Could not send push notifications.' });
  }
});


// ── INVOICES ───────────────────────────────────────────────────────────────
// Employer-posted requests wait here ('awaiting_invoice') for staff to review
// and price. Sending an invoice sets what the employer pays (invoiceAmount)
// and what the Xpert receives (pay).

// GET /admin/invoices?status=awaiting_invoice|invoice_sent|all
router.get('/invoices', adminAuth, async (req, res) => {
  const status = req.query.status;
  const where = status && status !== 'all'
    ? { status }
    : { status: { in: ['awaiting_invoice', 'invoice_sent'] } };
  try {
    const tasks = await prisma.task.findMany({
      where: { ...where, groupId: null },
      include: { employer: { select: { orgName: true, contactPerson: true, phone: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ tasks });
  } catch (err) {
    console.error('[admin] invoices failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/tasks/:id/invoice — the quote composer.
// Body { amount, workerPay, note?, benchmarkRate?, scopeAdjustment?, pricingType?, by? }.
// One firm quote; the employer can only accept or decline. If the per-Xpert
// pay is above the relevant Xpert price band ceiling it is held for sign-off
// and not sent until approved.
router.patch('/tasks/:id/invoice', adminAuth, async (req, res) => {
  const amount = parseFloat(req.body.amount);
  const workerPay = parseFloat(req.body.workerPay);
  const note = req.body.note ? String(req.body.note).trim().slice(0, 1000) : null;
  const optNum = (v) => (v === '' || v == null || isNaN(parseFloat(v)) ? null : parseFloat(v));
  if (!(amount > 0)) return res.status(400).json({ error: 'Invoice amount must be greater than 0.' });
  if (!(workerPay > 0) || workerPay > amount) return res.status(400).json({ error: 'Xpert pay must be greater than 0 and no more than the invoice amount.' });
  try {
    const existing = await prisma.task.findUnique({ where: { id: req.params.id }, select: { status: true, taskType: true, slotsNeeded: true, workerId: true, pricingType: true, signoffStatus: true } });
    if (!existing) return res.status(404).json({ error: 'Task not found.' });
    if (!['awaiting_invoice', 'invoice_sent'].includes(existing.status)) {
      return res.status(409).json({ error: 'This task is not awaiting an invoice.' });
    }
    // Above-band check against the assigned Xpert's ceiling, or else the
    // highest ceiling among active Xperts who do this work.
    const perXpert = workerPay / Math.max(1, existing.slotsNeeded || 1);
    let ceiling = null;
    if (existing.workerId) {
      const w = await prisma.worker.findUnique({ where: { id: existing.workerId }, select: { priceCeiling: true } });
      ceiling = w?.priceCeiling ?? null;
    } else {
      const band = await require('./adminClosedLoop').bandFor(existing.taskType);
      ceiling = band?.ceiling ?? null;
    }
    const aboveBand = ceiling != null && perXpert > ceiling;
    const quoteFields = {
      invoiceAmount: amount, pay: workerPay, invoiceNote: note,
      benchmarkRate: optNum(req.body.benchmarkRate), scopeAdjustment: optNum(req.body.scopeAdjustment),
      pricingType: ['fixed', 'hourly'].includes(req.body.pricingType) ? req.body.pricingType : existing.pricingType,
      aboveBand,
    };
    if (aboveBand) {
      const held = await prisma.task.update({
        where: { id: req.params.id },
        data: { ...quoteFields, status: 'awaiting_invoice', signoffStatus: 'pending', signedOffBy: null },
      });
      return res.json({ task: held, heldForSignoff: true, ceiling });
    }
    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: { ...quoteFields, status: 'invoice_sent', invoiceSentAt: new Date(), signoffStatus: 'not_needed', quoteResponse: 'pending' },
      include: { employer: { select: { phone: true, contactPerson: true } } },
    });
    res.json({ task });
    sendPushToUser({ employerId: task.employerId }, {
      title: 'Your quote is ready',
      body: `"${task.taskType}" — GHS ${amount.toFixed(2)}. Accept or decline in your dashboard.`,
      url: '/',
    });
    if (task.employer?.phone) {
      const first = (task.employer.contactPerson || '').split(' ')[0] || 'there';
      sendSMS(task.employer.phone, `BeyondX: Hi ${first}, your quote for "${task.taskType}" is GHS ${amount.toFixed(2)}. Accept or decline in your dashboard: beyondxco.com`);
    }
  } catch (err) {
    console.error('[admin] invoice failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── XPERT APPLICATIONS ─────────────────────────────────────────────────────
const APPLICATION_SELECT = {
  id: true, workerId: true, fullName: true, phone: true, skills: true, homeArea: true,
  idType: true, idCardNumber: true, idDocumentUrl: true, photoUrl: true,
  guarantorName: true, guarantorPhone: true, guarantorRelationship: true,
  referenceName: true, referencePhone: true, referenceRelationship: true,
  skillEvidenceUrls: true, experienceSummary: true, experienceEntries: true, certifications: true,
  accountStatus: true, applicationNote: true, activatedAt: true, activatedBy: true, createdAt: true,
  xpertStatus: true, guarantorOutcome: true, guarantorExplainerSentAt: true, evidenceOutcome: true, evidenceTaskType: true,
  referenceOutcome: true, referenceAttempts: true, certificationUrls: true, verificationSource: true,
  reverificationRequired: true, verificationSubmittedAt: true,
};

// GET /admin/applications?status=under_review|active|suspended|rejected|all
router.get('/applications', adminAuth, async (req, res) => {
  const status = req.query.status || 'under_review';
  try {
    const workers = await prisma.worker.findMany({
      where: status === 'all' ? {} : { accountStatus: status },
      select: APPLICATION_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ workers: approvedFirst(workers) });
  } catch (err) {
    console.error('[admin] applications failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/applications/:id — body { action: approve|reject|suspend|reactivate, note?, by? }
// Goes through the Xpert status pipeline (lib/xpertStatus.js). Approve is
// only possible once screening is complete. Reject, suspend and reactivate
// need a reason; reject and suspend reasons are shown to the applicant.
router.patch('/applications/:id', adminAuth, async (req, res) => {
  const { action } = req.body;
  const note = req.body.note ? String(req.body.note).trim().slice(0, 1000) : '';
  const by = req.body.by ? String(req.body.by).trim().slice(0, 100) : 'BeyondX admin';
  const next = { approve: 'provisional_active', reactivate: 'full_active', reject: 'blocked_closed', suspend: 'suspended' }[action];
  if (!next) return res.status(400).json({ error: 'action must be approve, reject, suspend or reactivate' });
  if (action !== 'approve' && !note) return res.status(400).json({ error: 'A reason is required.' });
  try {
    const current = await prisma.worker.findUnique({ where: { id: req.params.id }, select: { guarantorOutcome: true, evidenceOutcome: true, referenceOutcome: true } });
    if (!current) return res.status(404).json({ error: 'Xpert not found.' });
    if (action === 'approve' && !(current.guarantorOutcome === 'yes' && current.evidenceOutcome === 'pass' && current.referenceOutcome === 'confirmed')) {
      return res.status(409).json({ error: 'Screening is not complete. Confirm the guarantor, pass the work evidence and confirm the reference first.' });
    }
    await setXpertStatus(req.params.id, next, {
      by, reason: note || 'Screening complete; approved',
      note: action === 'reject' || action === 'suspend' ? note : '',
    });
    const worker = await prisma.worker.findUnique({ where: { id: req.params.id }, select: APPLICATION_SELECT });
    res.json({ worker });
    if (worker.phone) {
      const first = (worker.fullName || '').split(' ')[0] || 'there';
      const msg = {
        approve: `BeyondX: Hi ${first}, your application is approved. You are now a BeyondX Xpert. Log in to see available jobs: beyondxco.com`,
        reactivate: `BeyondX: Hi ${first}, your BeyondX account is active again. Log in to see available jobs: beyondxco.com`,
        reject: `BeyondX: Hi ${first}, we could not approve your application at this time. Log in to see the details.`,
        suspend: `BeyondX: Hi ${first}, your BeyondX account has been suspended. Log in to see the details or contact support.`,
      }[action];
      sendSMS(worker.phone, msg);
    }
  } catch (err) {
    if (err instanceof StatusError) return res.status(400).json({ error: err.message });
    if (err.code === 'P2025') return res.status(404).json({ error: 'Xpert not found.' });
    console.error('[admin] application update failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── SITE REPORTS ───────────────────────────────────────────────────────────
// GET /admin/site-reports?status=open|resolved|all
router.get('/site-reports', adminAuth, async (req, res) => {
  const status = req.query.status || 'open';
  try {
    const reports = await prisma.siteReport.findMany({
      where: status === 'all' ? {} : { status },
      include: {
        worker: { select: { fullName: true, workerId: true, phone: true } },
        task: { select: { taskType: true, location: true, employer: { select: { orgName: true, phone: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ reports });
  } catch (err) {
    console.error('[admin] site reports failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/site-reports/:id — body { status: resolved|open, adminNote? }
router.patch('/site-reports/:id', adminAuth, async (req, res) => {
  const status = req.body.status === 'open' ? 'open' : 'resolved';
  try {
    const report = await prisma.siteReport.update({
      where: { id: req.params.id },
      data: {
        status,
        ...(req.body.adminNote ? { adminNote: String(req.body.adminNote).slice(0, 1000) } : {}),
        resolvedAt: status === 'resolved' ? new Date() : null,
      },
    });
    res.json({ report });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Report not found.' });
    console.error('[admin] site report update failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
