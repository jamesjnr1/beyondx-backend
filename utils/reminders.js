// utils/reminders.js
// Checks every 5 minutes for accepted tasks that start within the next hour
// and haven't had a reminder sent yet, then fires an SMS to the worker.
// No cron needed — runs as a setInterval inside the Railway server process.

const { sendSMS } = require('./sms');

let prisma = null;

function formatDateTime(date, time) {
  if (!date) return null;
  try {
    const d = new Date(`${date}T${time || '08:00'}:00`);
    const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const t = time ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
    return t ? `${day} at ${t}` : day;
  } catch { return date; }
}

async function checkReminders() {
  if (!prisma) return;
  try {
    const now = new Date();
    const soon = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour from now

    // Find accepted tasks that:
    // 1. Have a scheduledDate
    // 2. Haven't had a reminder sent yet
    // 3. Start within the next hour
    const tasks = await prisma.task.findMany({
      where: {
        status: { in: ['accepted', 'payment_pending'] },
        scheduledDate: { not: null },
        reminderSentAt: null,
      },
      include: {
        acceptedBy: { select: { fullName: true, phone: true } },
        employer: { select: { orgName: true } },
      },
    });

    for (const task of tasks) {
      if (!task.scheduledDate || !task.acceptedBy?.phone) continue;

      const startTime = task.scheduledTime || '08:00';
      const startDt = new Date(`${task.scheduledDate}T${startTime}:00`);

      // Fire reminder if start is between now and 1 hour from now
      if (startDt >= now && startDt <= soon) {
        const firstName = (task.acceptedBy.fullName || 'there').split(' ')[0];
        const when = formatDateTime(task.scheduledDate, task.scheduledTime);
        const msg = `BeyondX: Hi ${firstName}, reminder — your "${task.taskType}" job at ${task.location} starts in 1 hour (${when}). Be on time!`;

        // Mark as sent FIRST so a retry loop can't double-send
        await prisma.task.update({
          where: { id: task.id },
          data: { reminderSentAt: new Date() },
        });

        await sendSMS(task.acceptedBy.phone, msg);
        console.log(`[reminder] sent to ${task.acceptedBy.phone} for task ${task.id}`);
      }
    }
  } catch (err) {
    console.error('[reminder] check failed:', err.message);
  }
}

function startReminders(prismaClient) {
  prisma = prismaClient;
  // Run immediately on startup, then every 5 minutes
  checkReminders();
  setInterval(checkReminders, 5 * 60 * 1000);
  console.log('[reminder] background reminder job started (checks every 5 minutes)');
}

module.exports = { startReminders };
