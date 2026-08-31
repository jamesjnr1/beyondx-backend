require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const prisma  = require('./lib/prisma');
const { ensureWorkerColumns } = require('./lib/ensureSchema');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/workers', require('./routes/workers'));
app.use('/admin', require('./routes/admin'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/verification', require('./routes/verification'));
app.use('/api/track', require('./routes/track'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/otp', require('./routes/otp'));
app.use('/api/scope', require('./routes/scope'));
app.use('/api/coordinators', require('./routes/coordinators'));

app.get('/', (req, res) => {
  res.json({ status: 'BeyondX API is running' });
});

// Public, unauthenticated aggregate stats — no personal data, safe to expose.
// Used to show live numbers on the admin login screen.
app.get('/stats', async (req, res) => {
  try {
    const [workers, completed, tasks] = await Promise.all([
      prisma.worker.count(),
      prisma.task.count({ where: { status: 'completed' } }),
      prisma.task.findMany({ where: { status: 'completed' }, select: { pay: true } }),
    ]);
    const revenue = tasks.reduce((sum, t) => sum + Number(t.pay || 0), 0);
    res.json({ workers, completed, revenue });
  } catch (err) {
    res.json({ workers: 0, completed: 0, revenue: 0 });
  }
});

const PORT = process.env.PORT || 3000;

// Self-heal the Worker table's columns before accepting traffic — see
// lib/ensureSchema.js for why this exists instead of a real migration step.
ensureWorkerColumns(prisma).finally(() => {
  app.listen(PORT, () => {
    console.log(`BeyondX server running on port ${PORT}`);
    // Start the background reminder job — checks every 5 minutes for tasks
    // starting within the next hour and sends a reminder SMS to the worker.
    const { startReminders } = require('./utils/reminders');
    startReminders(prisma);
  });
});
