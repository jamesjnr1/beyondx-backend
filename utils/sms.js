// utils/sms.js
// Shared SMS sending utility used across the backend. Every send attempt —
// success or failure — is logged to the SmsLog table so the admin dashboard
// can surface problems (especially a depleted Arkesel balance) instead of
// failures only being visible in Railway's server logs.

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function logSms(phone, message, status, errorType, errorDetail) {
  try {
    await prisma.smsLog.create({
      data: { phone, message, status, errorType, errorDetail: errorDetail ? String(errorDetail).slice(0, 1000) : null }
    });
  } catch (e) {
    console.error('Failed to write SMS log:', e);
  }
}

// Sends an SMS via Arkesel. Requires ARKESEL_API_KEY (and optionally
// ARKESEL_SENDER_ID, defaults to 'BeyondX') set in the environment.
// Never throws — a failed SMS should never break the caller's flow.
async function sendSMS(phone, message) {
  if (!process.env.ARKESEL_API_KEY) {
    console.error('ARKESEL_API_KEY is not set — SMS skipped.');
    await logSms(phone, message, 'failed', 'other', 'ARKESEL_API_KEY not set');
    return;
  }
  if (!phone) {
    console.error('No phone number on file — SMS skipped.');
    await logSms(phone, message, 'failed', 'invalid_number', 'No phone number on file');
    return;
  }
  // Normalize whatever format is in the database — strip everything except
  // digits and a leading +, then convert to Arkesel's expected 233XXXXXXXXX
  // form. This handles: '024 123 4567', '0241234567', '+233241234567',
  // '233241234567', '024-123-4567', etc.
  let digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('0')) digits = '233' + digits.slice(1);
  else if (!digits.startsWith('233')) digits = '233' + digits;
  const recipient = digits;

  // A valid Ghana MSISDN in this form is exactly 12 digits (233 + 9 digits).
  // Catching this here — instead of only letting Arkesel silently reject it —
  // is what actually surfaces 'some people never get SMS' as a visible,
  // diagnosable log entry instead of a mystery.
  if (!/^233\d{9}$/.test(recipient)) {
    console.error('Invalid phone number after normalization:', phone, '->', recipient);
    await logSms(phone, message, 'failed', 'invalid_number', `Normalized to "${recipient}" — not a valid Ghana MSISDN`);
    return;
  }

  try {
    const resp = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
      method: 'POST',
      headers: {
        'api-key': process.env.ARKESEL_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: process.env.ARKESEL_SENDER_ID || 'BeyondX',
        message,
        recipients: [recipient]
      })
    });
    const data = await resp.json();
    if (data.status !== 'success') {
      console.error('Arkesel SMS failed:', data);
      // Arkesel's exact wording for a depleted balance has varied across
      // API versions, so match loosely on the response text rather than
      // one exact string/code.
      const bodyText = JSON.stringify(data).toLowerCase();
      const isLowBalance = bodyText.includes('balance') || bodyText.includes('insufficient') || bodyText.includes('credit');
      await logSms(phone, message, 'failed', isLowBalance ? 'low_balance' : 'other', JSON.stringify(data));
    } else {
      console.log('Arkesel SMS sent successfully to', recipient);
      await logSms(phone, message, 'sent', null, null);
    }
  } catch (err) {
    console.error('Arkesel SMS error:', err);
    await logSms(phone, message, 'failed', 'other', err.message || String(err));
  }
}

module.exports = { sendSMS };
