require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/workers', require('./routes/workers'));
app.use('/admin', require('./routes/admin'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/verification', require('./routes/verification'));

app.get('/', (req, res) => {
  res.json({ status: 'BeyondX API is running' });
});

// Public, unauthenticated aggregate stats — no personal data, safe to expose.
// Used to show live numbers on the admin login screen.
const statsAdapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const statsPrisma = new PrismaClient({ adapter: statsAdapter });

app.get('/stats', async (req, res) => {
  try {
    const [workers, completed, tasks] = await Promise.all([
      statsPrisma.worker.count(),
      statsPrisma.task.count({ where: { status: 'completed' } }),
      statsPrisma.task.findMany({ where: { status: 'completed' }, select: { pay: true } }),
    ]);
    const revenue = tasks.reduce((sum, t) => sum + Number(t.pay || 0), 0);
    res.json({ workers, completed, revenue });
  } catch (err) {
    res.json({ workers: 0, completed: 0, revenue: 0 });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BeyondX server running on port ${PORT}`);
});