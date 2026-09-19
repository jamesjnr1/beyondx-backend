// lib/push.js
//
// Web Push (VAPID) sending, built on the `web-push` package.
//
// Required environment variables (set on Railway — see the deploy notes in
// the PR/README, never hardcode these):
//   VAPID_PUBLIC_KEY   the public half of the VAPID key pair
//   VAPID_PRIVATE_KEY  the private half — server-side only, never shipped to the browser
//   VAPID_SUBJECT       a contact URI, e.g. "mailto:support@beyondxco.com"
//
// The public key also needs to be embedded in the frontend (it's public by
// design — that's the point of the key pair) so the browser can create a
// subscription against the same VAPID identity. See
// beyondx-website/src/lib/push.ts.
const webpush = require('web-push');
const prisma = require('./prisma');

let configured = false;

function configureWebPush() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications are disabled.');
    return;
  }
  webpush.setVapidDetails(
    VAPID_SUBJECT || 'mailto:support@beyondxco.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY,
  );
  configured = true;
}

// Sends `payload` (plain object — becomes the JSON the service worker's
// `push` handler receives) to every subscription belonging to the given
// worker or employer. Best-effort: never throws, so a notification failure
// can never break the caller's real request. A subscription that the push
// service reports as gone (410) or not found (404) — meaning the user
// uninstalled the app or revoked permission — is deleted so it stops being
// retried forever.
async function sendPushToUser({ workerId, employerId }, payload) {
  if (!configured) return;
  if (!workerId && !employerId) return;

  try {
    const subs = await prisma.pushSubscription.findMany({
      where: workerId ? { workerId } : { employerId },
    });
    await Promise.all(subs.map((sub) => sendToSubscription(sub, payload)));
  } catch (err) {
    console.error('[push] sendPushToUser failed:', err.message);
  }
}

// Same idea, but for every subscription of a given role (or everyone) — the
// broadcast case used by the admin "send a notification" announcement.
async function sendPushToAudience(audience, payload) {
  if (!configured) return;
  try {
    const where = audience === 'worker' ? { workerId: { not: null } }
      : audience === 'employer' ? { employerId: { not: null } }
      : {};
    const subs = await prisma.pushSubscription.findMany({ where });
    await Promise.all(subs.map((sub) => sendToSubscription(sub, payload)));
  } catch (err) {
    console.error('[push] sendPushToAudience failed:', err.message);
  }
}

async function sendToSubscription(sub, payload) {
  const pushSubscription = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };
  try {
    await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
    } else {
      console.error('[push] send failed:', err.statusCode, err.message);
    }
  }
}

module.exports = { configureWebPush, sendPushToUser, sendPushToAudience };
