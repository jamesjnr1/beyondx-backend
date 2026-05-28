require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcryptjs');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function addEmployer() {
  const passwordHash = await bcrypt.hash('edwinaaa', 10); // change to their password

  const employer = await prisma.employer.create({
    data: {
      email:         'edwinabakes@company.com',  // their email
      passwordHash,
      orgName:       "Edwina's Treats",       // organisation name
      contactPerson: 'Edwina Abakes',             // contact person
      phone:         '0302000000',                // phone
      address:       '12 Ring Road, Accra',       // address
      region:        'Greater Accra',             // region
      isVerified:    true
    }
  });

  console.log('Employer added:', employer.email);
  await prisma.$disconnect();
}

addEmployer();