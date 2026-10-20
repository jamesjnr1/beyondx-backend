// lib/xpertStatus.js — the single place an Xpert's pipeline status changes.
// Keeps accountStatus (what gates site access) in step with xpertStatus and
// writes every move to XpertStatusHistory. Records are never deleted: a
// Removed Xpert keeps their history, with the reason and who decided it.
const prisma = require('./prisma');
const { XPERT_STATUSES, REASON_REQUIRED, ACTIVE_STATUSES, accountStatusFor } = require('./closedLoopConfig');

class StatusError extends Error {}

async function setXpertStatus(workerId, newStatus, { by = 'BeyondX admin', reason = '', note } = {}) {
  if (!XPERT_STATUSES.includes(newStatus)) throw new StatusError(`Unknown status: ${newStatus}`);
  const current = await prisma.worker.findUnique({
    where: { id: workerId },
    select: { xpertStatus: true, activatedAt: true },
  });
  if (!current) throw new StatusError('Xpert not found.');
  const old = current.xpertStatus;
  if (old === newStatus) return prisma.worker.findUnique({ where: { id: workerId } });
  const reasonText = String(reason || '').trim().slice(0, 1000);
  if ((REASON_REQUIRED.includes(newStatus) || REASON_REQUIRED.includes(old)) && !reasonText) {
    throw new StatusError('A reason is required to move an Xpert into or out of Under Review, Suspended or Removed.');
  }
  const becomingActive = ACTIVE_STATUSES.includes(newStatus) && !ACTIVE_STATUSES.includes(old);
  const [worker] = await prisma.$transaction([
    prisma.worker.update({
      where: { id: workerId },
      data: {
        xpertStatus: newStatus,
        accountStatus: accountStatusFor(newStatus),
        ...(becomingActive ? { activatedAt: new Date(), activatedBy: by } : {}),
        ...(note !== undefined ? { applicationNote: note || null } : {}),
      },
    }),
    prisma.xpertStatusHistory.create({
      data: { workerId, oldStatus: old, newStatus, changedBy: by, reason: reasonText || null },
    }),
  ]);
  return worker;
}

module.exports = { setXpertStatus, StatusError };
