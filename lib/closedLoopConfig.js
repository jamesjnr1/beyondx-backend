// lib/closedLoopConfig.js
//
// Settings the Version 4 spec lists as "not yet decided". Each is kept in
// one place so it can be changed without touching the routes, and most can
// be overridden from the environment on Railway.

function fromEnvJson(name, fallback) {
  try { return process.env[name] ? JSON.parse(process.env[name]) : fallback; }
  catch { console.error(`[closedLoopConfig] ${name} is not valid JSON, using default`); return fallback; }
}

// Which engagement types are priced hourly vs fixed. Undecided, so it is a
// config value. Override with PRICING_TYPE_DEFAULTS='{"one_time":"fixed","recurring":"hourly"}'.
const PRICING_TYPE_DEFAULTS = fromEnvJson('PRICING_TYPE_DEFAULTS', { one_time: 'fixed', recurring: 'fixed' });

function defaultPricingType(recurrence) {
  const t = PRICING_TYPE_DEFAULTS[recurrence === 'recurring' ? 'recurring' : 'one_time'];
  return t === 'hourly' ? 'hourly' : 'fixed';
}

// Change-order adjustment rule. The exact rule is undecided, so it is a
// replaceable function: swap the body (or the name in CHANGE_ORDER_RULE)
// without touching the change-order routes. The default applies the
// surcharge BeyondX already tells employers about: a scope increase costs at
// least 25% more, and more if the extra work is bigger. A decrease is
// applied as entered.
const CHANGE_ORDER_RULES = {
  percent_min_25: {
    label: 'Percentage change, minimum 25% for added work',
    apply({ originalAmount, percent }) {
      const p = Number(percent);
      if (!Number.isFinite(p) || p === 0) throw new Error('Enter the percentage change.');
      const applied = p > 0 ? Math.max(25, p) : Math.max(-100, p);
      return { newAmount: Math.round(originalAmount * (1 + applied / 100) * 100) / 100, appliedPercent: applied };
    },
  },
};
const CHANGE_ORDER_RULE = process.env.CHANGE_ORDER_RULE || 'percent_min_25';

function applyChangeOrderRule(input) {
  const rule = CHANGE_ORDER_RULES[CHANGE_ORDER_RULE] || CHANGE_ORDER_RULES.percent_min_25;
  return { ...rule.apply(input), rule: CHANGE_ORDER_RULE, label: rule.label };
}

// Screening time limits from the spec.
const GUARANTOR_TIMEOUT_DAYS = Number(process.env.GUARANTOR_TIMEOUT_DAYS || 14);
const REFERENCE_MAX_ATTEMPTS = Number(process.env.REFERENCE_MAX_ATTEMPTS || 3);

// Xpert pipeline statuses, and the plain words an Xpert sees for each.
const XPERT_STATUSES = [
  'applied', 'guarantor_pending', 'guarantor_confirmed', 'skill_verification',
  'provisional_active', 'full_active', 'under_review', 'suspended', 'inactive',
  'removed', 'blocked_closed',
];
// Moving into or out of these needs a written reason.
const REASON_REQUIRED = ['under_review', 'suspended', 'removed'];
// Statuses that give the Xpert site access (accountStatus 'active').
const ACTIVE_STATUSES = ['provisional_active', 'full_active'];

function accountStatusFor(xpertStatus) {
  if (ACTIVE_STATUSES.includes(xpertStatus)) return 'active';
  if (xpertStatus === 'suspended') return 'suspended';
  if (['removed', 'blocked_closed', 'inactive'].includes(xpertStatus)) return 'rejected';
  return 'under_review'; // still applying, or an active Xpert placed under review
}

module.exports = {
  defaultPricingType, applyChangeOrderRule, CHANGE_ORDER_RULES,
  GUARANTOR_TIMEOUT_DAYS, REFERENCE_MAX_ATTEMPTS,
  XPERT_STATUSES, REASON_REQUIRED, ACTIVE_STATUSES, accountStatusFor,
};
