require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcryptjs');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function updatePin() {
  const pinHash = await bcrypt.hash('1234', 10);
  const worker = await prisma.worker.update({
    where: { workerId: 'BX-00143' },
    data: { pinHash }
  });
  console.log('Updated pinHash:', worker.pinHash);
  await prisma.$disconnect();
}

updatePin();