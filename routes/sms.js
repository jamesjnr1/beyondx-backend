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
    return;
  }
  const recipient = phone.replace(/\s+/g, '').replace(/^0/, '233');
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
