const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');

const router = express.Router();

// Accepts a token from either a worker or an employer — a device's push
// subscription belongs to whichever account is signed in on it, same
// either-party pattern as routes/tasks.js's authEitherParty.
function authEitherParty(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'worker' && decoded.role !== 'employer') {
      return res.status(403).json({ error: 'Invalid token role' });
    }
    req.role = decoded.role;
    req.userId = decoded.id;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// POST /api/push/subscribe — save (or refresh) this device's push
// subscription. The frontend calls this right after the browser grants
// notification permission and creates a PushSubscription via
// registration.pushManager.subscribe(). Upserts on endpoint, since the same
// device re-subscribing (e.g. after clearing site data) sends the same
// shape again.
router.post('/subscribe', authEitherParty, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'A subscription with endpoint and keys.p256dh/keys.auth is required.' });
  }
  try {
    const ownerField = req.role === 'worker'
      ? { workerId: req.userId, employerId: null }
      : { workerId: null, employerId: req.userId };

    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: req.headers['user-agent'] || null, ...ownerField },
      update: { p256dh: keys.p256dh, auth: keys.auth, userAgent: req.headers['user-agent'] || null, ...ownerField },
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[push/subscribe]', err.message);
    res.status(500).json({ error: 'Could not save subscription.' });
  }
});

// POST /api/push/unsubscribe — remove this device's subscription (e.g. the
// user turns notifications off). Scoped to the signed-in account so one
// user can't delete another's subscription by guessing an endpoint.
router.post('/unsubscribe', authEitherParty, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'An endpoint is required.' });
  try {
    await prisma.pushSubscription.deleteMany({
      where: {
        endpoint,
        ...(req.role === 'worker' ? { workerId: req.userId } : { employerId: req.userId }),
      },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[push/unsubscribe]', err.message);
    res.status(500).json({ error: 'Could not remove subscription.' });
  }
});

module.exports = router;
