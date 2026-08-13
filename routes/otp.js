const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { sendSMS } = require('../utils/sms');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const CODE_TTL_MS      = 15 * 60 * 1000;  // 15 minutes
const RESEND_COOLDOWN  = 15 * 1000;        // 15 seconds

function normalisePhone(raw) {
  let p = String(raw || '').replace(/[\s\-]/g, '').replace(/^\+/, '');
  if (p.startsWith('0')) p = '233' + p.slice(1);
  if (!p.startsWith('233')) p = '233' + p;
  return p;
}

// GET /api/otp/health
router.get('/health', async (req, res) => {
  try {
    await prisma.phoneOtp.count();
    res.json({ ok: true, message: 'OTP route is live and database table exists.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/otp/send  { phone }
router.post('/send', async (req, res) => {
  const rawPhone = req.body?.phone;
  if (!rawPhone) return res.status(400).json({ error: 'Phone number is required.' });

  const phone = normalisePhone(rawPhone);
  if (!/^233\d{9}$/.test(phone)) {
    return res.status(400).json({ error: 'Enter a valid Ghana number (e.g. 024XXXXXXX).' });
  }

  try {
    // Cooldown check
    const existing = await prisma.phoneOtp.findUnique({ where: { phone } });
    if (existing) {
      const age = Date.now() - new Date(existing.createdAt).getTime();
      if (age < RESEND_COOLDOWN) {
        const wait = Math.ceil((RESEND_COOLDOWN - age) / 1000);
        return res.status(429).json({ error: `Wait ${wait}s then try again.` });
      }
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);

    await prisma.phoneOtp.upsert({
      where:  { phone },
      update: { code, expiresAt, createdAt: new Date() },
      create: { phone, code, expiresAt },
    });

    // Send SMS — fire and forget, never block or fail the response on this
    const displayPhone = '0' + phone.slice(3);
    sendSMS(displayPhone, `BeyondX code: ${code}\nValid 15 mins.`).catch(() => null);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[otp/send]', err.message);
    return res.status(500).json({ error: 'Could not send a code. Please try again.' });
  }
});

// POST /api/otp/verify  { phone, code }
router.post('/verify', async (req, res) => {
  const phone = normalisePhone(req.body?.phone);
  const code  = String(req.body?.code || '').trim();
  if (!phone || !code) return res.status(400).json({ error: 'Phone and code required.' });

  try {
    const row = await prisma.phoneOtp.findUnique({ where: { phone } });
    if (!row)                                         return res.status(400).json({ error: 'No code found. Please request a new one.' });
    if (new Date(row.expiresAt) < new Date())         { await prisma.phoneOtp.delete({ where: { phone } }).catch(() => null); return res.status(400).json({ error: 'Code expired. Request a new one.' }); }
    if (row.code !== code)                            return res.status(400).json({ error: 'Incorrect code. Check and try again.' });
    await prisma.phoneOtp.delete({ where: { phone } }).catch(() => null);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[otp/verify]', err.message);
    return res.status(500).json({ error: 'Could not verify. Please try again.' });
  }
});

module.exports = router;
