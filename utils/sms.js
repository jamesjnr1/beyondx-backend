// utils/sms.js
// Shared SMS sending utility used across the backend. Every send attempt —
// success or failure — is logged to the SmsLog table so the admin dashboard
// can surface problems (especially a depleted Arkesel balance) instead of
// failures only being visible in Railway's server logs.

const prisma = require('../lib/prisma');

async function logSms(phone, message, status, errorType, errorDetail) {
  try {
    await prisma.smsLog.create({
      data: { phone, message, status, errorType, errorDetail: errorDetail ? String(errorDetail).slice(0, 1000) : null }
    });
  } catch (e) {
    console.error('Failed to write SMS log:', e);
  }
}

// Arkesel credentials come only from the environment (Railway → Variables).
// Never put the key in code: anyone who can read the repository could spend
// the SMS balance with it.
const ARKESEL_API_KEY = process.env.ARKESEL_API_KEY || '';
const ARKESEL_SENDER  = process.env.ARKESEL_SENDER || 'BeyondX';
if (!ARKESEL_API_KEY) console.error('[sms] ARKESEL_API_KEY is not set — SMS will not be sent until it is added in Railway.');

async function sendSMS(phone, message) {
  if (!phone) {
    console.error('No phone number — SMS skipped.');
    await logSms(phone, message, 'failed', 'invalid_number', 'No phone number');
    return;
  }

  let digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('0')) digits = '233' + digits.slice(1);
  else if (!digits.startsWith('233')) digits = '233' + digits;
  const recipient = digits;

  if (!/^233\d{9}$/.test(recipient)) {
    console.error('Invalid phone after normalisation:', phone, '->', recipient);
    await logSms(phone, message, 'failed', 'invalid_number', `Normalised to "${recipient}" — not a valid Ghana MSISDN`);
    return;
  }

  if (!ARKESEL_API_KEY) {
    await logSms(phone, message, 'failed', 'not_configured', 'ARKESEL_API_KEY is not set on the server');
    return;
  }

  console.log(`[sms] sending to ${recipient} via ${ARKESEL_SENDER}`);

  try {
    const resp = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
      method: 'POST',
      headers: { 'api-key': ARKESEL_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: ARKESEL_SENDER, message, recipients: [recipient] })
    });
    const data = await resp.json();
    console.log('[sms] Arkesel response:', JSON.stringify(data));
    if (data.status !== 'success') {
      const bodyText = JSON.stringify(data).toLowerCase();
      const isLowBalance = bodyText.includes('balance') || bodyText.includes('insufficient') || bodyText.includes('credit');
      await logSms(phone, message, 'failed', isLowBalance ? 'low_balance' : 'other', JSON.stringify(data));
    } else {
      await logSms(phone, message, 'sent', null, null);
    }
  } catch (err) {
    console.error('[sms] error:', err.message);
    await logSms(phone, message, 'failed', 'other', err.message);
  }
}

module.exports = { sendSMS };
