const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { sendSMS } = require('../utils/sms');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const CODE_TTL_MS = 10 * 60 * 1000;      // 10 minutes
const RESEND_COOLDOWN_MS = 45 * 1000;    // 45 seconds between resends

function normalisePhone(raw) {
  let p = String(raw || '').replace(/[\s-]/g, '').replace(/^\+/, '');
  if (p.startsWith('0')) p = '233' + p.slice(1);
  return p;
}

// GET /api/otp/health — lets you verify the route is reachable and Prisma works
router.get('/health', async (req, res) => {
  try {
    await prisma.phoneOtp.count();
    res.json({ ok: true, message: 'OTP route is live and database table exists.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, hint: 'The PhoneOtp table probably does not exist yet — run the migration SQL in Supabase.' });
  }
});

// POST /api/otp/send  { phone }
router.post('/send', async (req, res) => {
  const rawPhone = req.body?.phone;
  if (!rawPhone) return res.status(400).json({ error: 'Phone number is required.' });

  const phone = normalisePhone(rawPhone);
  if (!/^233\d{9}$/.test(phone)) {
    return res.status(400).json({ error: 'Please enter a valid Ghana phone number (e.g. 024XXXXXXX).' });
  }

  try {
    // Cooldown check — don't burn an SMS every time someone taps Resend
    const existing = await prisma.phoneOtp.findUnique({ where: { phone } }).catch(err => {
      // Table doesn't exist yet — migration not run
      if (err.message.includes('does not exist') || err.code === 'P2021') {
        throw new Error('PhoneOtp table missing — run the migration SQL in Supabase first.');
      }
      throw err;
    });
    if (existing) {
      const age = Date.now() - new Date(existing.createdAt).getTime();
      if (age < RESEND_COOLDOWN_MS) {
        const waitSecs = Math.ceil((RESEND_COOLDOWN_MS - age) / 1000);
        return res.status(429).json({ error: `Please wait ${waitSecs} seconds before requesting another code.` });
      }
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);

    await prisma.phoneOtp.upsert({
      where: { phone },
      update: { code, expiresAt, createdAt: new Date() },
      create: { phone, code, expiresAt },
    });

    await sendSMS(
      // Convert back to 0XX format for sendSMS which normalises its own way
      '0' + phone.slice(3),
      `Your BeyondX verification code is ${code}. It expires in 10 minutes.\n\n- The BeyondX Team`
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[otp/send] error:', err.message);
    return res.status(500).json({ error: 'Could not send a code right now. Please try again.' });
  }
});

// POST /api/otp/verify  { phone, code }
router.post('/verify', async (req, res) => {
  const phone = normalisePhone(req.body?.phone);
  const code = String(req.body?.code || '').trim();

  if (!phone || !code) return res.status(400).json({ error: 'Phone and code are required.' });

  try {
    const row = await prisma.phoneOtp.findUnique({ where: { phone } });

    if (!row) {
      return res.status(400).json({ error: 'No code found for this number. Please request a new one.' });
    }
    if (new Date(row.expiresAt).getTime() < Date.now()) {
      await prisma.phoneOtp.delete({ where: { phone } }).catch(() => null);
      return res.status(400).json({ error: 'That code has expired. Please request a new one.' });
    }
    if (row.code !== code) {
      return res.status(400).json({ error: 'Incorrect code. Please check and try again.' });
    }

    // One-time use — delete it
    await prisma.phoneOtp.delete({ where: { phone } }).catch(() => null);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[otp/verify] error:', err.message);
    return res.status(500).json({ error: 'Could not verify that code right now.' });
  }
});

module.exports = router;
