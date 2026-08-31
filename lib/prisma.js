require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

// Every route/util used to create its own PrismaClient — each one opens its
// own pg connection pool (default max 10). With a dozen of those loaded into
// one process, the server could open 100+ connections to Postgres, which
// exceeds what a small hosted instance allows and surfaces as random
// "Server error" 500s (including on login) once enough pools fill up.
// One shared client/pool for the whole process fixes that.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

module.exports = prisma;
