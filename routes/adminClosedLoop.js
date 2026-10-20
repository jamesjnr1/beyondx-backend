// routes/adminClosedLoop.js — admin endpoints for the closed-loop model
// (Version 4 spec, Part 5): quotes and sign-off, benchmarks, change orders,
// job board, matching, live monitoring and replacement, recurring services,
// Xpert screening queues and statuses, flags, price bands, coordinator
// metrics and structured feedback. Mounted under /admin next to routes/admin.js.
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { sendSMS } = require('../utils/sms');
const { calcProximity } = require('../utils/proximity');
const { sendPushToUser } = require('../lib/push');
const { setXpertStatus, StatusError } = require('../lib/xpertStatus');
const {
  applyChangeOrderRule, defaultPricingType, CHANGE_ORDER_RULES,
  GUARANTOR_TIMEOUT_DAYS, REFERENCE_MAX_ATTEMPTS, XPERT_STATUSES, REASON_REQUIRED,
} = require('../lib/closedLoopConfig');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'beyondx2026';
function adminAuth(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
router.use(adminAuth);

const by = (req) => (req.body?.by ? String(req.body.by).trim().slice(0, 100) : '') || 'BeyondX admin';
const text = (v, max = 1000) => (v == null ? '' : String(v).trim().slice(0, max));
const num = (v) => (v === '' || v == null ? null : Number(v));
function fail(res, err, where) {
  if (err instanceof StatusError) return res.status(400).json({ error: err.message });
  if (err.code === 'P2025') return res.status(404).json({ error: 'Not found.' });
  console.error(`[admin/${where}]`, err.message);
  res.status(500).json({ error: err.message || 'Server error' });
}

// ── CONFIG ─────────────────────────────────────────────────────────────────
router.get('/closed-loop-config', (req, res) => {
  res.json({
    pricingTypeDefaults: { one_time: defaultPricingType('one_time'), recurring: defaultPricingType('recurring') },
    changeOrderRules: Object.fromEntries(Object.entries(CHANGE_ORDER_RULES).map(([k, r]) => [k, r.label])),
    guarantorTimeoutDays: GUARANTOR_TIMEOUT_DAYS,
    referenceMaxAttempts: REFERENCE_MAX_ATTEMPTS,
    xpertStatuses: XPERT_STATUSES,
    reasonRequired: REASON_REQUIRED,
  });
});

// ── BENCHMARK RATES ────────────────────────────────────────────────────────
router.get('/benchmarks', async (req, res) => {
  try { res.json({ benchmarks: await prisma.benchmarkRate.findMany({ orderBy: { taskType: 'asc' } }) }); }
  catch (err) { fail(res, err, 'benchmarks'); }
});

// PUT /admin/benchmarks — body { taskType, rate, unit: job|hour|day, notes?, by? }
router.put('/benchmarks', async (req, res) => {
  const taskType = text(req.body.taskType, 100);
  const rate = Number(req.body.rate);
  const unit = ['job', 'hour', 'day'].includes(req.body.unit) ? req.body.unit : 'job';
  if (!taskType || !(rate > 0)) return res.status(400).json({ error: 'Task type and a rate above 0 are required.' });
  try {
    const benchmark = await prisma.benchmarkRate.upsert({
      where: { taskType },
      create: { taskType, rate, unit, notes: text(req.body.notes) || null, updatedBy: by(req) },
      update: { rate, unit, notes: text(req.body.notes) || null, updatedBy: by(req) },
    });
    res.json({ benchmark });
  } catch (err) { fail(res, err, 'benchmarks'); }
});

// Highest band ceiling among active Xperts who do this kind of work — the
// limit a quote's per-Xpert pay is checked against before sign-off.
async function bandFor(taskType) {
  const xperts = await prisma.worker.findMany({
    where: { accountStatus: 'active', skills: { has: taskType }, priceCeiling: { not: null } },
    select: { priceFloor: true, priceCeiling: true },
  });
  if (!xperts.length) return null;
  return {
    floor: Math.min(...xperts.map(x => x.priceFloor ?? x.priceCeiling)),
    ceiling: Math.max(...xperts.map(x => x.priceCeiling)),
    xperts: xperts.length,
  };
}
router.bandFor = bandFor;

// ── REQUEST INBOX ──────────────────────────────────────────────────────────
// GET /admin/requests?view=new|signoff|sent|accepted|declined
router.get('/requests', async (req, res) => {
  const view = req.query.view || 'new';
  const where = {
    new: { status: 'awaiting_invoice', signoffStatus: { not: 'pending' } },
    signoff: { status: 'awaiting_invoice', signoffStatus: 'pending' },
    sent: { status: 'invoice_sent' },
    accepted: { quoteResponse: 'accepted' },
    declined: { quoteResponse: 'declined' },
  }[view];
  if (!where) return res.status(400).json({ error: 'Unknown view' });
  try {
    const [tasks, benchmarks] = await Promise.all([
      prisma.task.findMany({
        where: { ...where, groupId: null },
        include: { employer: { select: { orgName: true, contactPerson: true, phone: true, email: true } } },
        orderBy: { createdAt: view === 'new' || view === 'signoff' ? 'asc' : 'desc' },
        take: 200,
      }),
      prisma.benchmarkRate.findMany(),
    ]);
    const byType = Object.fromEntries(benchmarks.map(b => [b.taskType, b]));
    const bands = {};
    for (const t of tasks) if (!(t.taskType in bands)) bands[t.taskType] = await bandFor(t.taskType);
    res.json({ tasks: tasks.map(t => ({ ...t, benchmark: byType[t.taskType] || null, band: bands[t.taskType] })) });
  } catch (err) { fail(res, err, 'requests'); }
});

async function sendQuoteToEmployer(task) {
  sendPushToUser({ employerId: task.employerId }, {
    title: 'Your quote is ready',
    body: `"${task.taskType}" — GHS ${Number(task.invoiceAmount).toFixed(2)}. Accept or decline in your dashboard.`,
    url: '/',
  });
  const emp = await prisma.employer.findUnique({ where: { id: task.employerId }, select: { phone: true, contactPerson: true } });
  if (emp?.phone) {
    const first = (emp.contactPerson || '').split(' ')[0] || 'there';
    sendSMS(emp.phone, `BeyondX: Hi ${first}, your quote for "${task.taskType}" is GHS ${Number(task.invoiceAmount).toFixed(2)}. Accept or decline in your dashboard: beyondxco.com`);
  }
}
router.sendQuoteToEmployer = sendQuoteToEmployer;

// ── PRICING SIGN-OFF ───────────────────────────────────────────────────────
// PATCH /admin/signoffs/:id — body { action: approve|reject, note?, by }
router.patch('/signoffs/:id', async (req, res) => {
  const action = req.body.action;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be approve or reject' });
  try {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (task.signoffStatus !== 'pending') return res.status(409).json({ error: 'This quote is not waiting for sign-off.' });
    if (action === 'reject') {
      const updated = await prisma.task.update({
        where: { id: task.id },
        data: { signoffStatus: 'rejected', signedOffBy: by(req), adminNote: text(req.body.note) || task.adminNote },
      });
      return res.json({ task: updated });
    }
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: { signoffStatus: 'approved', signedOffBy: by(req), status: 'invoice_sent', invoiceSentAt: new Date(), quoteResponse: 'pending' },
    });
    res.json({ task: updated });
    sendQuoteToEmployer(updated);
  } catch (err) { fail(res, err, 'signoffs'); }
});

// ── CHANGE ORDERS ──────────────────────────────────────────────────────────
router.get('/change-orders', async (req, res) => {
  try {
    const orders = await prisma.changeOrder.findMany({
      where: req.query.taskId ? { taskId: String(req.query.taskId) } : {},
      orderBy: { createdAt: 'desc' }, take: 200,
    });
    const tasks = await prisma.task.findMany({
      where: { id: { in: [...new Set(orders.map(o => o.taskId))] } },
      select: { id: true, taskType: true, location: true, employer: { select: { orgName: true } }, acceptedBy: { select: { fullName: true } } },
    });
    const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
    res.json({ orders: orders.map(o => ({ ...o, task: byId[o.taskId] || null })) });
  } catch (err) { fail(res, err, 'change-orders'); }
});

// POST /admin/tasks/:id/change-orders — body { reason, percent, by }
router.post('/tasks/:id/change-orders', async (req, res) => {
  const reason = text(req.body.reason);
  if (reason.length < 5) return res.status(400).json({ error: 'Describe what changed on site.' });
  try {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    const originalAmount = Number(task.invoiceAmount ?? task.pay ?? 0);
    if (!(originalAmount > 0)) return res.status(400).json({ error: 'This job has no amount to adjust yet.' });
    let result;
    try { result = applyChangeOrderRule({ originalAmount, percent: req.body.percent }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const originalPay = Number(task.pay || 0);
    const newPay = originalPay > 0 ? Math.round(originalPay * (result.newAmount / originalAmount) * 100) / 100 : null;
    const order = await prisma.changeOrder.create({
      data: {
        taskId: task.id, reason,
        adjustmentRule: `${result.rule} (${result.appliedPercent > 0 ? '+' : ''}${result.appliedPercent}%)`,
        originalAmount, newAmount: result.newAmount, originalPay: originalPay || null, newPay,
        loggedBy: by(req),
      },
    });
    res.status(201).json({ order });
  } catch (err) { fail(res, err, 'change-orders'); }
});

// PATCH /admin/change-orders/:id — body { confirm: employer|xpert, by }.
// Confirmations are collected over WhatsApp; the job amount and Xpert pay
// only change once both sides have confirmed.
router.patch('/change-orders/:id', async (req, res) => {
  const side = req.body.confirm;
  if (!['employer', 'xpert'].includes(side)) return res.status(400).json({ error: 'confirm must be employer or xpert' });
  try {
    let order = await prisma.changeOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: 'Change order not found.' });
    if (order.appliedAt) return res.status(409).json({ error: 'This change order is already applied.' });
    order = await prisma.changeOrder.update({
      where: { id: order.id },
      data: side === 'employer' ? { employerConfirmedAt: new Date() } : { xpertConfirmedAt: new Date() },
    });
    if (order.employerConfirmedAt && order.xpertConfirmedAt) {
      const task = await prisma.task.findUnique({ where: { id: order.taskId }, select: { invoiceAmount: true } });
      await prisma.task.update({
        where: { id: order.taskId },
        data: {
          ...(task?.invoiceAmount != null ? { invoiceAmount: order.newAmount } : {}),
          ...(order.newPay != null ? { pay: order.newPay } : {}),
        },
      });
      order = await prisma.changeOrder.update({ where: { id: order.id }, data: { appliedAt: new Date() } });
    }
    res.json({ order });
  } catch (err) { fail(res, err, 'change-orders'); }
});

// ── JOB BOARD, MATCHING, MONITORING ────────────────────────────────────────
const LIVE = ['awaiting_invoice', 'invoice_sent', 'payment_pending', 'open', 'offered', 'accepted', 'pending_confirmation', 'employer_confirmed', 'expired'];

router.get('/job-board', async (req, res) => {
  try {
    const tasks = await prisma.task.findMany({
      where: { status: { in: LIVE } },
      include: {
        acceptedBy: { select: { fullName: true, workerId: true, phone: true } },
        employer: { select: { orgName: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' }, take: 300,
    });
    const ids = tasks.map(t => t.id);
    const workerIds = [...new Set(tasks.map(t => t.backupWorkerId).filter(Boolean))];
    const [assignments, backups, services] = await Promise.all([
      prisma.assignment.findMany({ where: { taskId: { in: ids } }, orderBy: { createdAt: 'asc' } }),
      prisma.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, fullName: true, workerId: true } }),
      prisma.recurringService.findMany({ where: { id: { in: tasks.map(t => t.recurringServiceId).filter(Boolean) } } }),
    ]);
    const names = await prisma.worker.findMany({
      where: { id: { in: [...new Set(assignments.map(a => a.workerId))] } }, select: { id: true, fullName: true },
    });
    const nameOf = Object.fromEntries([...names, ...backups].map(w => [w.id, w.fullName]));
    const svc = Object.fromEntries(services.map(s => [s.id, s]));
    res.json({
      tasks: tasks.map(t => ({
        ...t,
        backup: t.backupWorkerId ? { id: t.backupWorkerId, fullName: nameOf[t.backupWorkerId] || '—' } : null,
        assignments: assignments.filter(a => a.taskId === t.id).map(a => ({ ...a, fullName: nameOf[a.workerId] || '—' })),
        recurringService: t.recurringServiceId ? svc[t.recurringServiceId] || null : null,
      })),
    });
  } catch (err) { fail(res, err, 'job-board'); }
});

// GET /admin/tasks/:id/matches — eligible, available Xperts with the
// signals staff sort on: status, price band, attendance, task experience
// and proximity.
router.get('/tasks/:id/matches', async (req, res) => {
  try {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    const xperts = await prisma.worker.findMany({
      where: { accountStatus: 'active', isActive: true, skills: { has: task.taskType } },
      select: {
        id: true, workerId: true, fullName: true, homeArea: true, xpertStatus: true, verificationSource: true,
        priceFloor: true, priceCeiling: true, rating: true, tasksCompleted: true, role: true,
        tasks: { where: { status: { in: ['offered', 'accepted', 'pending_confirmation'] } }, select: { id: true } },
      },
    });
    const ids = xperts.map(x => x.id);
    const [sameType, assignments, flags] = await Promise.all([
      prisma.task.groupBy({ by: ['workerId'], where: { workerId: { in: ids }, taskType: task.taskType, status: 'completed' }, _count: true }),
      prisma.assignment.findMany({ where: { workerId: { in: ids }, role: 'primary' }, select: { workerId: true, arrivedAt: true, status: true, confirmedAt: true } }),
      prisma.flag.groupBy({ by: ['againstId'], where: { againstType: 'xpert', againstId: { in: ids } }, _count: true }),
    ]);
    const exp = Object.fromEntries(sameType.map(r => [r.workerId, r._count]));
    const flagCount = Object.fromEntries(flags.map(r => [r.againstId, r._count]));
    const perXpertPay = Number(task.pay || 0) / Math.max(1, task.slotsNeeded || 1);
    res.json({
      task: { id: task.id, taskType: task.taskType, location: task.location, pay: task.pay, slotsNeeded: task.slotsNeeded || 1 },
      xperts: xperts.map(x => {
        const mine = assignments.filter(a => a.workerId === x.id && a.confirmedAt);
        const noShows = mine.filter(a => a.status === 'replaced' && !a.arrivedAt).length;
        const prox = calcProximity(x.homeArea, task.location);
        const { tasks, ...rest } = x;
        return {
          ...rest,
          available: tasks.length === 0,
          taskExperience: exp[x.id] || 0,
          attendance: { assignments: mine.length, noShows, rate: mine.length ? Math.round(((mine.length - noShows) / mine.length) * 100) : null },
          flags: flagCount[x.id] || 0,
          distanceKm: prox.available ? prox.roadKm : null,
          withinBand: x.priceCeiling == null || perXpertPay <= x.priceCeiling,
        };
      }),
    });
  } catch (err) { fail(res, err, 'matches'); }
});

async function offerToXpert(task, workerId) {
  const w = await prisma.worker.findUnique({ where: { id: workerId }, select: { fullName: true, phone: true } });
  const pay = Number(task.pay || 0).toFixed(0);
  sendPushToUser({ workerId }, { title: 'New job offer', body: `${task.taskType} at ${task.location || 'TBD'} — GHS ${pay}`, url: '/' });
  if (w?.phone) {
    const first = (w.fullName || '').split(' ')[0] || 'there';
    sendSMS(w.phone, `BeyondX: Hi ${first}, new job! ${task.taskType} at ${task.location || 'TBD'}, ${task.duration || ''}. Pay: GH${pay}. Accept/decline: beyondxco.com`);
  }
}

// POST /admin/tasks/:id/assign — body { primaryWorkerId, backupWorkerId?, by }.
// Single-Xpert jobs; for several Xperts use Dispatch (dispatch-multi).
router.post('/tasks/:id/assign', async (req, res) => {
  const { primaryWorkerId, backupWorkerId } = req.body;
  if (!primaryWorkerId) return res.status(400).json({ error: 'Choose a primary Xpert.' });
  if (backupWorkerId && backupWorkerId === primaryWorkerId) return res.status(400).json({ error: 'The backup must be a different Xpert.' });
  try {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if ((task.slotsNeeded || 1) > 1) return res.status(400).json({ error: 'This job needs several Xperts. Use Dispatch to offer it to a group.' });
    if (!['open', 'expired', 'offered'].includes(task.status)) return res.status(409).json({ error: `A ${task.status} job cannot be assigned.` });
    const primary = await prisma.worker.findUnique({ where: { id: primaryWorkerId }, select: { homeArea: true, accountStatus: true } });
    if (!primary || primary.accountStatus !== 'active') return res.status(400).json({ error: 'That Xpert is not active.' });
    const prox = calcProximity(primary.homeArea, task.location);
    if (task.workerId && task.workerId !== primaryWorkerId) {
      await prisma.assignment.updateMany({ where: { taskId: task.id, workerId: task.workerId, status: 'active' }, data: { status: 'released' } });
    }
    await prisma.assignment.updateMany({ where: { taskId: task.id, role: 'backup', status: 'active' }, data: { status: 'released' } });
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        status: 'offered', workerId: primaryWorkerId, backupWorkerId: backupWorkerId || null,
        ...(prox.available ? { transportAllowance: prox.transportAllowance } : {}),
      },
    });
    const existing = await prisma.assignment.findFirst({ where: { taskId: task.id, workerId: primaryWorkerId, status: 'active' } });
    if (existing) await prisma.assignment.update({ where: { id: existing.id }, data: { role: 'primary' } });
    else await prisma.assignment.create({ data: { taskId: task.id, workerId: primaryWorkerId, role: 'primary', assignedBy: by(req) } });
    if (backupWorkerId) await prisma.assignment.create({ data: { taskId: task.id, workerId: backupWorkerId, role: 'backup', assignedBy: by(req) } });
    res.json({ task: updated });
    offerToXpert(updated, primaryWorkerId);
  } catch (err) { fail(res, err, 'assign'); }
});

// POST /admin/tasks/:id/replace — body { workerId?, reason, by }. Promotes
// the backup (or the Xpert given), records the replacement and tells the
// employer BeyondX is arranging it.
router.post('/tasks/:id/replace', async (req, res) => {
  const reason = text(req.body.reason);
  if (!reason) return res.status(400).json({ error: 'Give a reason for the replacement.' });
  try {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (!['offered', 'accepted', 'expired', 'open'].includes(task.status)) return res.status(409).json({ error: `A ${task.status} job cannot be replaced.` });
    const newWorkerId = req.body.workerId || task.backupWorkerId;
    if (!newWorkerId) return res.status(400).json({ error: 'There is no backup on this job. Choose an Xpert.' });
    if (newWorkerId === task.workerId) return res.status(400).json({ error: 'Choose a different Xpert.' });
    const newAssignment = await prisma.assignment.create({
      data: { taskId: task.id, workerId: newWorkerId, role: 'primary', assignedBy: by(req) },
    });
    if (task.workerId) {
      const current = await prisma.assignment.findFirst({ where: { taskId: task.id, workerId: task.workerId, status: 'active' } });
      if (current) await prisma.assignment.update({ where: { id: current.id }, data: { status: 'replaced', replacedByAssignmentId: newAssignment.id } });
      else await prisma.assignment.create({ data: { taskId: task.id, workerId: task.workerId, role: 'primary', status: 'replaced', replacedByAssignmentId: newAssignment.id, assignedBy: 'unrecorded' } });
    }
    await prisma.assignment.updateMany({ where: { taskId: task.id, workerId: newWorkerId, role: 'backup', status: 'active' }, data: { status: 'released' } });
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        status: 'offered', workerId: newWorkerId, replacementInProgress: true,
        backupWorkerId: task.backupWorkerId === newWorkerId ? null : task.backupWorkerId,
        arrivedAt: null, startedAt: null,
        adminNote: `Replacement: ${reason}`.slice(0, 1000),
      },
    });
    res.json({ task: updated });
    offerToXpert(updated, newWorkerId);
    sendPushToUser({ employerId: task.employerId }, { title: 'Arranging a replacement', body: `BeyondX is arranging a replacement Xpert for "${task.taskType}".`, url: '/' });
  } catch (err) { fail(res, err, 'replace'); }
});

// ── RECURRING SERVICES ─────────────────────────────────────────────────────
router.get('/recurring', async (req, res) => {
  try {
    const services = await prisma.recurringService.findMany({ orderBy: { createdAt: 'desc' } });
    const [employers, xperts] = await Promise.all([
      prisma.employer.findMany({ where: { id: { in: services.map(s => s.employerId) } }, select: { id: true, orgName: true } }),
      prisma.worker.findMany({ where: { id: { in: services.flatMap(s => s.preferredXpertIds) } }, select: { id: true, fullName: true, workerId: true } }),
    ]);
    const emp = Object.fromEntries(employers.map(e => [e.id, e.orgName]));
    const xp = Object.fromEntries(xperts.map(x => [x.id, x]));
    res.json({ services: services.map(s => ({ ...s, orgName: emp[s.employerId] || '—', preferredTeam: s.preferredXpertIds.map(id => xp[id]).filter(Boolean) })) });
  } catch (err) { fail(res, err, 'recurring'); }
});

// PATCH /admin/recurring/:id — body { preferredWorkerIds?: string[] (BX ids or uuids), nextServiceDate?, active? }
router.patch('/recurring/:id', async (req, res) => {
  try {
    const data = {};
    if (Array.isArray(req.body.preferredWorkerIds)) {
      const keys = req.body.preferredWorkerIds.map(String).map(s => s.trim()).filter(Boolean);
      const found = await prisma.worker.findMany({ where: { OR: [{ id: { in: keys } }, { workerId: { in: keys } }] }, select: { id: true } });
      if (found.length !== keys.length) return res.status(400).json({ error: 'One or more Xpert IDs were not found.' });
      data.preferredXpertIds = found.map(w => w.id);
    }
    if (req.body.nextServiceDate !== undefined) data.nextServiceDate = text(req.body.nextServiceDate, 20) || null;
    if (req.body.active !== undefined) data.active = !!req.body.active;
    const service = await prisma.recurringService.update({ where: { id: req.params.id }, data });
    res.json({ service });
  } catch (err) { fail(res, err, 'recurring'); }
});

// POST /admin/recurring/:id/next-job — creates the next visit as a request
// (awaiting a quote) on nextServiceDate.
router.post('/recurring/:id/next-job', async (req, res) => {
  try {
    const s = await prisma.recurringService.findUnique({ where: { id: req.params.id } });
    if (!s || !s.active) return res.status(404).json({ error: 'Active recurring service not found.' });
    let tpl = {};
    try { tpl = JSON.parse(s.template); } catch { /* keep empty */ }
    const task = await prisma.task.create({
      data: {
        employerId: s.employerId, taskType: s.taskType, location: s.location,
        description: tpl.description || '', duration: tpl.duration || '1 day', durationHours: tpl.durationHours || null,
        pay: 0, status: 'awaiting_invoice', recurrence: 'recurring', schedulePattern: s.schedulePattern,
        recurringServiceId: s.id, pricingType: defaultPricingType('recurring'),
        scheduledDate: s.nextServiceDate || null, scheduledTime: tpl.scheduledTime || null,
        ...(tpl.workersNeeded > 1 ? { slotsNeeded: tpl.workersNeeded } : {}),
        requiredSkills: tpl.requiredSkills || null, specialRequirements: tpl.specialRequirements || null,
        equipmentNotes: tpl.equipmentNotes || null, siteNotes: tpl.siteNotes || null, photoUrls: tpl.photoUrls || [],
        adminNote: s.preferredXpertIds.length ? 'Recurring: offer to the preferred team first.' : null,
      },
    });
    res.status(201).json({ task });
  } catch (err) { fail(res, err, 'recurring'); }
});

// ── XPERT STATUS QUEUE ─────────────────────────────────────────────────────
const XPERT_SELECT = {
  id: true, workerId: true, fullName: true, phone: true, skills: true, homeArea: true,
  xpertStatus: true, accountStatus: true, verificationSource: true, role: true,
  idType: true, idCardNumber: true, idDocumentUrl: true, idVerified: true,
  guarantorName: true, guarantorPhone: true, guarantorRelationship: true,
  guarantorExplainerSentAt: true, guarantorCallbackAt: true, guarantorOutcome: true,
  referenceName: true, referencePhone: true, referenceRelationship: true,
  referenceOutcome: true, referenceAttempts: true, referenceCalledBy: true, referenceCalledAt: true,
  skillEvidenceUrls: true, certificationUrls: true, evidenceTaskType: true, evidenceOutcome: true,
  evidenceReviewedBy: true, evidenceReviewedAt: true, experienceSummary: true,
  priceFloor: true, priceCeiling: true, priceBandAdjustedAt: true, priceBandAdjustedBy: true, priceBandReason: true,
  applicationNote: true, activatedAt: true, activatedBy: true, createdAt: true, tasksCompleted: true, rating: true,
};
router.XPERT_SELECT = XPERT_SELECT;

router.get('/xperts', async (req, res) => {
  const status = req.query.status;
  try {
    const [xperts, counts] = await Promise.all([
      prisma.worker.findMany({
        where: status && status !== 'all' ? { xpertStatus: status } : {},
        select: XPERT_SELECT, orderBy: { createdAt: 'desc' }, take: 500,
      }),
      prisma.worker.groupBy({ by: ['xpertStatus'], _count: true }),
    ]);
    res.json({ xperts, counts: Object.fromEntries(counts.map(c => [c.xpertStatus, c._count])) });
  } catch (err) { fail(res, err, 'xperts'); }
});

router.get('/xperts/:id/history', async (req, res) => {
  try {
    const [statuses, bands] = await Promise.all([
      prisma.xpertStatusHistory.findMany({ where: { workerId: req.params.id }, orderBy: { createdAt: 'desc' } }),
      prisma.priceBandHistory.findMany({ where: { workerId: req.params.id }, orderBy: { createdAt: 'desc' } }),
    ]);
    res.json({ statuses, bands });
  } catch (err) { fail(res, err, 'history'); }
});

// PATCH /admin/xperts/:id/status — body { status, reason?, by }
router.patch('/xperts/:id/status', async (req, res) => {
  try {
    const worker = await setXpertStatus(req.params.id, req.body.status, { by: by(req), reason: req.body.reason, note: req.body.note });
    res.json({ worker: { id: worker.id, xpertStatus: worker.xpertStatus, accountStatus: worker.accountStatus } });
  } catch (err) { fail(res, err, 'status'); }
});

// PATCH /admin/xperts/:id/verification-source — body { source: direct_beyondx|coordinator }
router.patch('/xperts/:id/verification-source', async (req, res) => {
  const source = req.body.source === 'coordinator' ? 'coordinator' : 'direct_beyondx';
  try {
    await prisma.worker.update({ where: { id: req.params.id }, data: { verificationSource: source } });
    res.json({ ok: true, verificationSource: source });
  } catch (err) { fail(res, err, 'verification-source'); }
});

// ── SCREENING QUEUES ───────────────────────────────────────────────────────
const SCREENING = ['applied', 'guarantor_pending', 'guarantor_confirmed', 'skill_verification'];

// Applicants whose guarantor gave no valid confirmation within the time
// limit are closed. Run lazily when the queue is opened (no cron here).
async function closeExpiredGuarantors() {
  const cutoff = new Date(Date.now() - GUARANTOR_TIMEOUT_DAYS * 86400000);
  const stale = await prisma.worker.findMany({
    where: {
      xpertStatus: { in: ['applied', 'guarantor_pending'] },
      OR: [{ guarantorOutcome: null }, { guarantorOutcome: 'no_response' }],
      // The clock starts when the explainer message went out.
      guarantorExplainerSentAt: { lt: cutoff },
    },
    select: { id: true },
  });
  for (const w of stale) {
    await setXpertStatus(w.id, 'blocked_closed', { by: 'system', reason: `No valid guarantor confirmation within ${GUARANTOR_TIMEOUT_DAYS} days` }).catch(() => null);
  }
  return stale.length;
}

router.get('/queues/guarantor', async (req, res) => {
  try {
    const closed = await closeExpiredGuarantors();
    const xperts = await prisma.worker.findMany({
      where: { xpertStatus: { in: ['applied', 'guarantor_pending'] }, OR: [{ guarantorOutcome: null }, { guarantorOutcome: 'no_response' }] },
      select: XPERT_SELECT, orderBy: { createdAt: 'asc' },
    });
    res.json({ xperts, closedForTimeout: closed, timeoutDays: GUARANTOR_TIMEOUT_DAYS });
  } catch (err) { fail(res, err, 'queue-guarantor'); }
});

// Once guarantor, evidence and reference are all through, the applicant is
// ready for the approval decision (status skill_verification = screening done).
async function advanceScreening(workerId, actor) {
  const w = await prisma.worker.findUnique({ where: { id: workerId }, select: { xpertStatus: true, guarantorOutcome: true, evidenceOutcome: true, referenceOutcome: true } });
  if (!w || !SCREENING.includes(w.xpertStatus)) return;
  if (w.guarantorOutcome === 'yes' && ['applied', 'guarantor_pending'].includes(w.xpertStatus)) {
    await setXpertStatus(workerId, 'guarantor_confirmed', { by: actor, reason: 'Guarantor confirmed by callback' });
  }
  const after = await prisma.worker.findUnique({ where: { id: workerId }, select: { xpertStatus: true } });
  if (w.guarantorOutcome === 'yes' && after.xpertStatus === 'guarantor_confirmed') {
    await setXpertStatus(workerId, 'skill_verification', { by: actor, reason: 'Moved to skill verification' });
  }
}

function screeningComplete(w) {
  return w.guarantorOutcome === 'yes' && w.evidenceOutcome === 'pass' && w.referenceOutcome === 'confirmed';
}

// POST /admin/xperts/:id/guarantor-explainer — (re)send the explainer SMS
// and restart the confirmation clock.
router.post('/xperts/:id/guarantor-explainer', async (req, res) => {
  try {
    const w = await prisma.worker.findUnique({ where: { id: req.params.id }, select: { id: true, fullName: true, guarantorName: true, guarantorPhone: true, xpertStatus: true } });
    if (!w || !w.guarantorPhone) return res.status(400).json({ error: 'This Xpert has no guarantor phone on file.' });
    const applicant = (w.fullName || 'An applicant').split(' ')[0];
    const first = (w.guarantorName || '').split(' ')[0] || 'there';
    sendSMS(w.guarantorPhone,
      `BeyondX: Hi ${first}, ${applicant} named you as their guarantor to work through BeyondX. ` +
      `This is a character reference only - you are not responsible for any money or legal matters. ` +
      `A BeyondX team member will call you to confirm.`);
    await prisma.worker.update({ where: { id: w.id }, data: { guarantorExplainerSentAt: new Date() } });
    if (w.xpertStatus === 'applied') await setXpertStatus(w.id, 'guarantor_pending', { by: by(req), reason: 'Guarantor explainer message sent' });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'guarantor-explainer'); }
});

// PATCH /admin/xperts/:id/guarantor — body { outcome: yes|no|no_response, by }
router.patch('/xperts/:id/guarantor', async (req, res) => {
  const outcome = req.body.outcome;
  if (!['yes', 'no', 'no_response'].includes(outcome)) return res.status(400).json({ error: 'outcome must be yes, no or no_response' });
  try {
    await prisma.worker.update({ where: { id: req.params.id }, data: { guarantorOutcome: outcome, guarantorCallbackAt: new Date() } });
    if (outcome === 'no') await setXpertStatus(req.params.id, 'blocked_closed', { by: by(req), reason: 'Guarantor declined to confirm' });
    else if (outcome === 'yes') await advanceScreening(req.params.id, by(req));
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'guarantor'); }
});

// Per-category evidence checklist shown beside the evidence. Kept short and
// generic so it applies to the existing categories without changing them.
const EVIDENCE_CHECKLIST = [
  'The work shown matches the category applied for',
  'The work looks finished to a standard an employer would accept',
  'The photos or video look like the applicant\'s own work, not taken from the internet',
  'Tools and safety practice look appropriate for the task',
];

router.get('/queues/evidence', async (req, res) => {
  try {
    const xperts = await prisma.worker.findMany({
      where: { evidenceOutcome: 'pending', xpertStatus: { in: SCREENING } },
      select: XPERT_SELECT, orderBy: { createdAt: 'asc' },
    });
    res.json({ xperts, checklist: EVIDENCE_CHECKLIST });
  } catch (err) { fail(res, err, 'queue-evidence'); }
});

// PATCH /admin/xperts/:id/evidence — body { outcome: pass|fail, by }. Pass or fail only.
router.patch('/xperts/:id/evidence', async (req, res) => {
  const outcome = req.body.outcome;
  if (!['pass', 'fail'].includes(outcome)) return res.status(400).json({ error: 'outcome must be pass or fail' });
  try {
    await prisma.worker.update({ where: { id: req.params.id }, data: { evidenceOutcome: outcome, evidenceReviewedBy: by(req), evidenceReviewedAt: new Date() } });
    await advanceScreening(req.params.id, by(req));
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'evidence'); }
});

const REFERENCE_SCRIPT = [
  'How do you know the applicant, and for how long?',
  'What work have you seen them do?',
  'Did they arrive on time and finish what they started?',
  'Would you hire or work with them again? Why or why not?',
  'Confirm you are not related to the applicant.',
];

router.get('/queues/reference', async (req, res) => {
  try {
    const xperts = await prisma.worker.findMany({
      where: { xpertStatus: { in: SCREENING }, OR: [{ referenceOutcome: null }, { referenceOutcome: 'inconclusive' }] },
      select: XPERT_SELECT, orderBy: { createdAt: 'asc' },
    });
    res.json({ xperts, script: REFERENCE_SCRIPT, maxAttempts: REFERENCE_MAX_ATTEMPTS });
  } catch (err) { fail(res, err, 'queue-reference'); }
});

// PATCH /admin/xperts/:id/reference — body { outcome: confirmed|inconclusive|unreachable|no_answer, by }.
// no_answer logs a failed attempt; after the maximum it becomes unreachable.
router.patch('/xperts/:id/reference', async (req, res) => {
  const outcome = req.body.outcome;
  if (!['confirmed', 'inconclusive', 'unreachable', 'no_answer'].includes(outcome)) return res.status(400).json({ error: 'Unknown outcome' });
  try {
    const w = await prisma.worker.findUnique({ where: { id: req.params.id }, select: { referenceAttempts: true } });
    if (!w) return res.status(404).json({ error: 'Xpert not found.' });
    const attempts = w.referenceAttempts + 1;
    const final = outcome === 'no_answer' ? (attempts >= REFERENCE_MAX_ATTEMPTS ? 'unreachable' : null) : outcome;
    await prisma.worker.update({
      where: { id: req.params.id },
      data: { referenceAttempts: attempts, referenceCalledBy: by(req), referenceCalledAt: new Date(), ...(final ? { referenceOutcome: final } : {}) },
    });
    await advanceScreening(req.params.id, by(req));
    res.json({ ok: true, attempts, referenceOutcome: final });
  } catch (err) { fail(res, err, 'reference'); }
});

// ── ONBOARDING APPROVAL ────────────────────────────────────────────────────
// PATCH /admin/xperts/:id/approve — only once screening is complete. Moves
// the applicant to provisional_active, which activates their account.
router.patch('/xperts/:id/approve', async (req, res) => {
  try {
    const w = await prisma.worker.findUnique({ where: { id: req.params.id }, select: { xpertStatus: true, guarantorOutcome: true, evidenceOutcome: true, referenceOutcome: true, fullName: true, phone: true } });
    if (!w) return res.status(404).json({ error: 'Xpert not found.' });
    if (!screeningComplete(w)) return res.status(409).json({ error: 'Screening is not complete. The guarantor, work evidence and reference must all be confirmed first.' });
    await setXpertStatus(req.params.id, 'provisional_active', { by: by(req), reason: 'Screening complete; approved', note: '' });
    res.json({ ok: true });
    if (w.phone) {
      const first = (w.fullName || '').split(' ')[0] || 'there';
      sendSMS(w.phone, `BeyondX: Hi ${first}, your application is approved. You are now a BeyondX Xpert. Log in to see available jobs: beyondxco.com`);
    }
  } catch (err) { fail(res, err, 'approve'); }
});

// ── FLAGS ──────────────────────────────────────────────────────────────────
router.get('/flags', async (req, res) => {
  const status = req.query.status || 'open';
  try {
    const flags = await prisma.flag.findMany({
      where: status === 'all' ? {} : status === 'active' ? { status: { in: ['open', 'under_review'] } } : { status },
      orderBy: { createdAt: 'desc' }, take: 300,
    });
    const workerIds = flags.flatMap(f => [f.raisedByType === 'xpert' ? f.raisedById : null, f.againstType === 'xpert' ? f.againstId : null]).filter(Boolean);
    const employerIds = flags.flatMap(f => [f.raisedByType === 'employer' ? f.raisedById : null, f.againstType === 'employer' ? f.againstId : null]).filter(Boolean);
    const [workers, employers, tasks] = await Promise.all([
      prisma.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, fullName: true, workerId: true, xpertStatus: true } }),
      prisma.employer.findMany({ where: { id: { in: employerIds } }, select: { id: true, orgName: true } }),
      prisma.task.findMany({ where: { id: { in: flags.map(f => f.taskId).filter(Boolean) } }, select: { id: true, taskType: true, location: true } }),
    ]);
    const w = Object.fromEntries(workers.map(x => [x.id, x]));
    const e = Object.fromEntries(employers.map(x => [x.id, x]));
    const t = Object.fromEntries(tasks.map(x => [x.id, x]));
    const who = (type, id) => (type === 'xpert' ? (w[id] ? `${w[id].fullName} (${w[id].workerId})` : 'Xpert') : (e[id]?.orgName || 'Employer'));
    res.json({
      flags: flags.map(f => ({
        ...f, raisedBy: who(f.raisedByType, f.raisedById), against: who(f.againstType, f.againstId),
        againstXpertStatus: f.againstType === 'xpert' ? w[f.againstId]?.xpertStatus : null, task: t[f.taskId] || null,
      })),
    });
  } catch (err) { fail(res, err, 'flags'); }
});

// PATCH /admin/flags/:id — body { status?: under_review|resolved, decision?: clear|suspend|remove, notes, by }
router.patch('/flags/:id', async (req, res) => {
  const decision = req.body.decision;
  const notes = text(req.body.notes);
  if (decision && !['clear', 'suspend', 'remove'].includes(decision)) return res.status(400).json({ error: 'decision must be clear, suspend or remove' });
  if (decision && !notes) return res.status(400).json({ error: 'Write the reason for the decision.' });
  try {
    const flag = await prisma.flag.findUnique({ where: { id: req.params.id } });
    if (!flag) return res.status(404).json({ error: 'Flag not found.' });
    if (decision && decision !== 'clear' && flag.againstType === 'xpert' && flag.againstId) {
      await setXpertStatus(flag.againstId, decision === 'suspend' ? 'suspended' : 'removed', { by: by(req), reason: `Flag decision: ${notes}` });
    }
    const updated = await prisma.flag.update({
      where: { id: flag.id },
      data: decision
        ? { status: 'resolved', decision, resolvedBy: by(req), resolutionNotes: notes, resolvedAt: new Date() }
        : { status: req.body.status === 'resolved' ? 'resolved' : 'under_review', ...(notes ? { resolutionNotes: notes } : {}) },
    });
    res.json({ flag: updated });
  } catch (err) { fail(res, err, 'flags'); }
});

// ── PRICE BANDS ────────────────────────────────────────────────────────────
// PATCH /admin/xperts/:id/price-band — body { floor, ceiling, reason, by }
router.patch('/xperts/:id/price-band', async (req, res) => {
  const floor = num(req.body.floor);
  const ceiling = num(req.body.ceiling);
  const reason = text(req.body.reason);
  if (floor == null || ceiling == null || !(floor > 0) || !(ceiling >= floor)) return res.status(400).json({ error: 'Floor and ceiling must be numbers, with the ceiling at or above the floor.' });
  if (!reason) return res.status(400).json({ error: 'Give a reason for the adjustment.' });
  try {
    const [worker] = await prisma.$transaction([
      prisma.worker.update({
        where: { id: req.params.id },
        data: { priceFloor: floor, priceCeiling: ceiling, priceBandAdjustedAt: new Date(), priceBandAdjustedBy: by(req), priceBandReason: reason },
        select: { id: true, priceFloor: true, priceCeiling: true },
      }),
      prisma.priceBandHistory.create({ data: { workerId: req.params.id, floor, ceiling, reason, adjustedBy: by(req) } }),
    ]);
    res.json({ worker });
  } catch (err) { fail(res, err, 'price-band'); }
});

// ── COORDINATOR METRICS ────────────────────────────────────────────────────
// Rates are computed from underlying records: complaints = flags raised
// against the coordinator, no-shows = replaced assignments with no arrival,
// disputes = scope disputes they raised. Each is per assigned job.
router.get('/coordinator-metrics', async (req, res) => {
  try {
    const coords = await prisma.worker.findMany({
      where: { role: 'coordinator' },
      select: { id: true, workerId: true, fullName: true, coordinatorTeam: true, coordinatorApplication: true, verificationSource: true, xpertStatus: true },
    });
    const ids = coords.map(c => c.id);
    const [jobs, flags, assignments, disputes] = await Promise.all([
      prisma.task.groupBy({ by: ['workerId'], where: { workerId: { in: ids }, status: { in: ['accepted', 'pending_confirmation', 'employer_confirmed', 'completed'] } }, _count: true }),
      prisma.flag.groupBy({ by: ['againstId'], where: { againstType: 'xpert', againstId: { in: ids } }, _count: true }),
      prisma.assignment.findMany({ where: { workerId: { in: ids }, status: 'replaced', arrivedAt: null }, select: { workerId: true } }),
      prisma.scopeDispute.groupBy({ by: ['flaggedBy'], where: { flaggedBy: { in: ids } }, _count: true }),
    ]);
    const count = (rows, key) => Object.fromEntries(rows.map(r => [r[key], r._count]));
    const j = count(jobs, 'workerId'), f = count(flags, 'againstId'), d = count(disputes, 'flaggedBy');
    const ns = assignments.reduce((m, a) => ({ ...m, [a.workerId]: (m[a.workerId] || 0) + 1 }), {});
    const rate = (n, total) => (total ? Math.round((n / total) * 1000) / 10 : null);
    res.json({
      coordinators: coords.map(c => {
        let team = [];
        try { team = JSON.parse(c.coordinatorTeam || '[]').filter(m => m.status !== 'removed'); } catch { /* none */ }
        let business = {};
        try { business = JSON.parse(c.coordinatorApplication || '{}'); } catch { /* none */ }
        const total = j[c.id] || 0;
        return {
          id: c.id, workerId: c.workerId, fullName: c.fullName, xpertStatus: c.xpertStatus, verificationSource: c.verificationSource,
          businessName: business.businessName || business.orgName || null,
          team: team.map(m => ({ name: m.name, categories: m.categories, jobsCompleted: m.jobsCompleted || 0 })),
          jobs: total,
          complaintRate: rate(f[c.id] || 0, total), noShowRate: rate(ns[c.id] || 0, total), disputeRate: rate(d[c.id] || 0, total),
        };
      }),
    });
  } catch (err) { fail(res, err, 'coordinator-metrics'); }
});

// ── FEEDBACK VIEW ──────────────────────────────────────────────────────────
router.get('/feedback', async (req, res) => {
  try {
    const reviews = await prisma.review.findMany({
      orderBy: { createdAt: 'desc' }, take: 300,
      include: {
        task: { select: { taskType: true, location: true, acceptedBy: { select: { fullName: true, workerId: true } }, employer: { select: { orgName: true } } } },
      },
    });
    res.json({ reviews });
  } catch (err) { fail(res, err, 'feedback'); }
});

module.exports = router;
