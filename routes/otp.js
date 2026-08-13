// routes/otp.js
// Uses Arkesel's native OTP API (/api/v2/otp/send + /api/v2/otp/verify).
// Every attempt is logged to SmsLog so the admin console shows exactly
// what Arkesel returned — not just "sent" but the full response code.

const express = require('express');
const router  = express.Router();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg }    = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma  = new PrismaClient({ adapter });

const RESEND_COOLDOWN = 30 * 1000;
const ARKESEL_BASE    = 'https://sms.arkesel.com/api/v2';

function normalise(raw) {
  let p = String(raw || '').replace(/[\s\-]/g, '').replace(/^\+/, '');
  if (p.startsWith('0')) p = '233' + p.slice(1);
  if (!p.startsWith('233')) p = '233' + p;
  return p;
}

async function logSms(phone, message, status, detail) {
  try {
    await prisma.smsLog.create({
      data: { phone, message, status, errorType: status === 'sent' ? null : 'other', errorDetail: detail ? String(detail).slice(0, 1000) : null }
    });
  } catch (e) { console.error('[otp] log failed:', e.message); }
}

// GET /api/otp/health
router.get('/health', async (req, res) => {
  try {
    await prisma.phoneOtp.count();
    res.json({ ok: true, senderId: process.env.ARKESEL_SENDER_ID || 'BeyondX', message: 'OTP route live.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/otp/send  { phone }
router.post('/send', async (req, res) => {
  const rawPhone = req.body?.phone;
  if (!rawPhone) return res.status(400).json({ error: 'Phone number is required.' });

  const phone = normalise(rawPhone);
  if (!/^233\d{9}$/.test(phone)) {
    return res.status(400).json({ error: 'Enter a valid Ghana number (e.g. 024XXXXXXX).' });
  }

  // Cooldown check
  try {
    const existing = await prisma.phoneOtp.findUnique({ where: { phone } });
    if (existing) {
      const age = Date.now() - new Date(existing.createdAt).getTime();
      if (age < RESEND_COOLDOWN) {
        const wait = Math.ceil((RESEND_COOLDOWN - age) / 1000);
        return res.status(429).json({ error: `Wait ${wait}s then try again.` });
      }
    }
    await prisma.phoneOtp.upsert({
      where:  { phone },
      update: { code: 'arkesel', expiresAt: new Date(Date.now() + 10*60*1000), createdAt: new Date() },
      create: { phone, code: 'arkesel', expiresAt: new Date(Date.now() + 10*60*1000) },
    });
  } catch (err) {
    console.error('[otp/send] db error:', err.message);
    return res.status(500).json({ error: 'Could not send a code. Please try again.' });
  }

  const senderId = process.env.ARKESEL_SENDER_ID || 'BeyondX';
  const displayPhone = '+' + phone;
  const msgLabel = `OTP to ${phone} via Arkesel native OTP API`;

  try {
    const body = {
      expiry:    10,
      length:    6,
      medium:    'sms',
      message:   'Your BeyondX verification code is %otp_code%. Valid for 10 minutes.',
      number:    displayPhone,
      sender_id: senderId,
      type:      'numeric',
    };

    console.log('[otp/send] calling Arkesel OTP API:', JSON.stringify(body));

    const resp = await fetch(`${ARKESEL_BASE}/otp/send`, {
      method: 'POST',
      headers: { 'api-key': process.env.ARKESEL_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await resp.json().catch(() => ({}));
    const detail = JSON.stringify(data);
    console.log('[otp/send] Arkesel response:', detail);

    const success = data.code === '1000' || data.status === 'success' || String(data.message || '').toLowerCase().includes('success');

    if (success) {
      await logSms(phone, `OTP code sent via Arkesel native OTP API (sender: ${senderId})`, 'sent', detail);
      return res.status(200).json({ ok: true });
    } else {
      await logSms(phone, msgLabel, 'failed', detail);
      await prisma.phoneOtp.delete({ where: { phone } }).catch(() => null);
      return res.status(502).json({ error: 'Could not send the code. Please try again.' });
    }
  } catch (err) {
    console.error('[otp/send] network error:', err.message);
    await logSms(phone, msgLabel, 'failed', err.message);
    await prisma.phoneOtp.delete({ where: { phone } }).catch(() => null);
    return res.status(500).json({ error: 'Could not send a code. Please try again.' });
  }
});

// POST /api/otp/verify  { phone, code }
router.post('/verify', async (req, res) => {
  const phone = normalise(req.body?.phone);
  const code  = String(req.body?.code || '').trim();
  if (!phone || !code) return res.status(400).json({ error: 'Phone and code required.' });

  try {
    const resp = await fetch(`${ARKESEL_BASE}/otp/verify`, {
      method: 'POST',
      headers: { 'api-key': process.env.ARKESEL_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: '+' + phone, code: code }),
    });

    const data = await resp.json().catch(() => ({}));
    console.log('[otp/verify] Arkesel response:', JSON.stringify(data));

    const success = data.code === '1000' || data.status === 'success' || String(data.message || '').toLowerCase().includes('success');

    if (!success) {
      const msg = data.message || 'Incorrect code or code expired. Please request a new one.';
      return res.status(400).json({ error: msg });
    }

    await prisma.phoneOtp.delete({ where: { phone } }).catch(() => null);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[otp/verify] error:', err.message);
    return res.status(500).json({ error: 'Could not verify. Please try again.' });
  }
});

module.exports = router;
