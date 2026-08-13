// routes/otp.js
// Uses Arkesel's native OTP API (not the bulk SMS endpoint).
// This has a dedicated delivery route for verification codes and handles
// code generation, storage, and expiry on Arkesel's side.
// POST /api/otp/send  → calls Arkesel /api/v2/otp/send
// POST /api/otp/verify → calls Arkesel /api/v2/otp/verify
// We keep a local cooldown in our PhoneOtp table to prevent resend spam.

const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const RESEND_COOLDOWN = 30 * 1000; // 30 seconds between resend attempts
const ARKESEL_BASE = 'https://sms.arkesel.com/api/v2';

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
    const hasKey = !!process.env.ARKESEL_API_KEY;
    const senderId = process.env.ARKESEL_SENDER_ID || 'BeyondX';
    res.json({ ok: true, arkeselKeySet: hasKey, senderId, message: 'OTP route live.' });
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

  // Local cooldown check
  try {
    const existing = await prisma.phoneOtp.findUnique({ where: { phone } });
    if (existing) {
      const age = Date.now() - new Date(existing.createdAt).getTime();
      if (age < RESEND_COOLDOWN) {
        const wait = Math.ceil((RESEND_COOLDOWN - age) / 1000);
        return res.status(429).json({ error: `Wait ${wait}s then try again.` });
      }
    }

    // Record timestamp for cooldown (Arkesel stores the actual code)
    await prisma.phoneOtp.upsert({
      where:  { phone },
      update: { code: 'arkesel', expiresAt: new Date(Date.now() + 10*60*1000), createdAt: new Date() },
      create: { phone, code: 'arkesel', expiresAt: new Date(Date.now() + 10*60*1000) },
    });
  } catch (err) {
    console.error('[otp/send] db error:', err.message);
    return res.status(500).json({ error: 'Could not send a code. Please try again.' });
  }

  // Call Arkesel native OTP API
  try {
    const senderId = process.env.ARKESEL_SENDER_ID || 'BeyondX';
    const body = {
      expiry: 10,
      length: 6,
      medium: 'sms',
      message: `Your BeyondX verification code is %otp_code%. It expires in 10 minutes.`,
      number: `+${phone}`,
      sender_id: senderId,
      type: 'numeric',
    };

    const resp = await fetch(`${ARKESEL_BASE}/otp/send`, {
      method: 'POST',
      headers: {
        'api-key': process.env.ARKESEL_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    console.log('[otp/send] Arkesel response:', JSON.stringify(data));

    // Arkesel OTP API returns code "1000" for success
    if (data.code !== '1000' && data.status !== 'success' && !data.message?.toLowerCase().includes('success')) {
      console.error('[otp/send] Arkesel OTP send failed:', data);
      // Clean up cooldown record so retry is possible
      await prisma.phoneOtp.delete({ where: { phone } }).catch(() => null);
      return res.status(502).json({ error: 'Could not send the code. Please try again.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[otp/send] network error:', err.message);
    await prisma.phoneOtp.delete({ where: { phone } }).catch(() => null);
    return res.status(500).json({ error: 'Could not send a code. Please try again.' });
  }
});

// POST /api/otp/verify  { phone, code }
router.post('/verify', async (req, res) => {
  const phone = normalisePhone(req.body?.phone);
  const code  = String(req.body?.code || '').trim();
  if (!phone || !code) return res.status(400).json({ error: 'Phone and code required.' });

  try {
    // Verify with Arkesel — they stored and check the code
    const resp = await fetch(`${ARKESEL_BASE}/otp/verify`, {
      method: 'POST',
      headers: {
        'api-key': process.env.ARKESEL_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ number: `+${phone}`, otp_code: code }),
    });

    const data = await resp.json();
    console.log('[otp/verify] Arkesel response:', JSON.stringify(data));

    if (data.code !== '1000' && data.status !== 'success' && !data.message?.toLowerCase().includes('success')) {
      const msg = data.message || 'Incorrect code or code expired. Try again.';
      return res.status(400).json({ error: msg });
    }

    // Clean up our cooldown record
    await prisma.phoneOtp.delete({ where: { phone } }).catch(() => null);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[otp/verify] error:', err.message);
    return res.status(500).json({ error: 'Could not verify. Please try again.' });
  }
});

module.exports = router;
