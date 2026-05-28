require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function updateWorkers() {
  // Update Kofi Asante
  await prisma.worker.update({
    where: { workerId: 'BX-00142' },
    data: {
      skills: ['Facility & Cleaning', 'Community Services'],
      bio: 'Hardworking and reliable. Experienced in facility maintenance and community work.',
      prisonFacility: 'Nsawam Medium Security Prison',
      offenseLevel: 'minor',
      gpsVerified: true,
      dailyCharge: 85
    }
  });
  console.log('Updated BX-00142');

  // Update Jonathan James Duah Jr.
  await prisma.worker.update({
    where: { workerId: 'BX-00143' },
    data: {
      skills: ['Logistics & Delivery', 'Retail & Trade'],
      bio: 'Punctual and detail-oriented. Strong background in logistics and stock management.',
      prisonFacility: 'Kumasi Central Prison',
      offenseLevel: 'none',
      gpsVerified: true,
      dailyCharge: 90
    }
  });
  console.log('Updated BX-00143');

  await prisma.$disconnect();
  console.log('Done!');
}

updateWorkers();