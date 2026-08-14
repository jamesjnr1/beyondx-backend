// utils/reminders.js
// Checks every 5 minutes for scheduled tasks and fires two SMS reminders:
//   1. Morning-of: between 07:00–07:30 on the day of the job
//   2. One-hour-before: when the job start is within the next 60 minutes
// No cron needed — runs as a setInterval inside the Railway server process.

const { sendSMS } = require('./sms');

let prisma = null;

function formatTime(time) {
  // '08:00' -> '8:00 AM', '14:30' -> '2:30 PM'
  if (!time) return '';
  try {
    const [h, m] = time.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
  } catch { return time; }
}

function formatDate(date) {
  if (!date) return '';
  try {
    const d = new Date(`${date}T12:00:00`); // noon to avoid day-boundary issues
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  } catch { return date; }
}

async function checkReminders() {
  if (!prisma) return;
  try {
    const now = new Date();
    const nowHour = now.getUTCHours();   // Ghana is UTC+0
    const nowMin  = now.getUTCMinutes();
    const todayStr = now.toISOString().split('T')[0]; // 'YYYY-MM-DD'

    // Fetch all accepted tasks with a scheduled date that haven't had both reminders sent
    const tasks = await prisma.task.findMany({
      where: {
        status: { in: ['accepted', 'payment_pending'] },
        scheduledDate: { not: null },
        OR: [
          { reminderSentAt: null },
          { morningReminderSentAt: null },
        ],
      },
      include: {
        acceptedBy: { select: { fullName: true, phone: true } },
        employer:   { select: { orgName: true } },
      },
    });

    for (const task of tasks) {
      if (!task.scheduledDate || !task.acceptedBy?.phone) continue;

      const firstName = (task.acceptedBy.fullName || 'there').split(' ')[0];
      const phone     = task.acceptedBy.phone;
      const startTime = task.scheduledTime || '08:00';
      const startDt   = new Date(`${task.scheduledDate}T${startTime}:00`);

      // ── 1. Morning-of reminder (07:00–07:30 on the job day) ──────────────
      if (!task.morningReminderSentAt && task.scheduledDate === todayStr) {
        // Only fire between 07:00 and 07:30 UTC (Ghana local time)
        const inMorningWindow = (nowHour === 7 && nowMin < 30);
        if (inMorningWindow) {
          const timeLabel = formatTime(task.scheduledTime);
          const msg = `BeyondX: Hi ${firstName}, your "${task.taskType}" job at ${task.location} is today at ${timeLabel}. Get ready!`;

          await prisma.task.update({
            where: { id: task.id },
            data: { morningReminderSentAt: new Date() },
          });

          await sendSMS(phone, msg);
          console.log(`[reminder] morning SMS sent to ${phone} for task ${task.id}`);
        }
      }

      // ── 2. One-hour-before reminder ───────────────────────────────────────
      if (!task.reminderSentAt) {
        const soon = new Date(now.getTime() + 60 * 60 * 1000);
        if (startDt >= now && startDt <= soon) {
          const timeLabel = formatTime(task.scheduledTime);
          const dateLabel = formatDate(task.scheduledDate);
          const msg = `BeyondX: Hi ${firstName}, reminder — your "${task.taskType}" job at ${task.location} starts in 1 hour at ${timeLabel} (${dateLabel}). Be on time!`;

          await prisma.task.update({
            where: { id: task.id },
            data: { reminderSentAt: new Date() },
          });

          await sendSMS(phone, msg);
          console.log(`[reminder] 1hr SMS sent to ${phone} for task ${task.id}`);
        }
      }
    }
  } catch (err) {
    console.error('[reminder] check failed:', err.message);
  }
}

function startReminders(prismaClient) {
  prisma = prismaClient;
  checkReminders();
  setInterval(checkReminders, 5 * 60 * 1000);
  console.log('[reminder] background reminder job started (checks every 5 minutes)');
}

module.exports = { startReminders };
