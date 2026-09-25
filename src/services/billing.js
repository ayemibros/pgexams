/**
 * Subscription/access rules — port of the logic in billing/models.py:
 * AccessProfile, has_access() and activate_subscription_from_payment().
 */
const db = require('../db');
const { Bundle, Department, Faculty, Subscription, Payment, Plan } = require('../models');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything a student may open right now, worked out once from their
 * active subscriptions (one query instead of one per exam).
 */
class AccessProfile {
  constructor() {
    this.all_access = false;
    this.has_postgraduate = false;
    this.subject_ids = new Set();
    this.bundles = new Map(); // bundle id -> Bundle (with department/faculty attached)
    this.bundle_until = new Map(); // bundle id -> latest ends_at among active subscriptions
  }

  static async load(user) {
    const p = new AccessProfile();
    if (!user || !user.is_authenticated) return p;
    const now = new Date();
    const subs = await db.all(
      `SELECT s.id, s.ends_at, s.plan_id, pl.is_all_access FROM billing_subscription s JOIN billing_plan pl ON pl.id = s.plan_id
       WHERE s.student_id = ? AND s.status = 'active' AND s.starts_at <= ? AND s.ends_at >= ?`, [user.id, now, now],
    );
    if (!subs.length) return p;
    const planIds = [...new Set(subs.map((s) => s.plan_id))];
    const planSubjects = await db.all('SELECT plan_id, subject_id FROM billing_plan_subjects WHERE plan_id IN (?)', [planIds]);
    const planBundles = await db.all('SELECT plan_id, bundle_id FROM billing_plan_bundles WHERE plan_id IN (?)', [planIds]);
    const bundleIds = [...new Set(planBundles.map((r) => r.bundle_id))];
    const bundles = new Map((await loadBundles(bundleIds)).map((b) => [b.id, b]));

    for (const sub of subs) {
      if (sub.is_all_access) p.all_access = true;
      for (const r of planSubjects) if (r.plan_id === sub.plan_id) p.subject_ids.add(r.subject_id);
      for (const r of planBundles) {
        if (r.plan_id !== sub.plan_id) continue;
        const b = bundles.get(r.bundle_id);
        if (!b) continue;
        p.bundles.set(b.id, b);
        if (b.level === 'postgraduate') p.has_postgraduate = true;
        if (!p.bundle_until.has(b.id) || sub.ends_at > p.bundle_until.get(b.id)) p.bundle_until.set(b.id, sub.ends_at);
      }
    }
    return p;
  }

  get has_any() { return this.all_access || this.bundles.size > 0 || this.subject_ids.size > 0; }

  /**
   * EPT comes with any postgraduate programme; an exam with neither subject
   * nor bundle can't be gated and is open.
   */
  allows(subject = null, bundle = null, isEpt = false) {
    if (isEpt) return this.all_access || this.has_postgraduate;
    if (!subject && !bundle) return true;
    if (this.all_access) return true;
    return Boolean((subject && this.subject_ids.has(subject.id)) || (bundle && this.bundles.has(bundle.id)));
  }
}

/** Bundles by id with department (and its faculty) attached — select_related("department__faculty"). */
async function loadBundles(ids) {
  if (!ids.length) return [];
  const bundles = Bundle.hydrateAll(await db.all('SELECT * FROM catalog_bundle WHERE id IN (?)', [ids]));
  await attachDepartments(bundles);
  return bundles;
}

async function attachDepartments(bundles) {
  const deptIds = [...new Set(bundles.map((b) => b.department_id).filter(Boolean))];
  const depts = new Map(deptIds.length
    ? Department.hydrateAll(await db.all('SELECT * FROM catalog_department WHERE id IN (?)', [deptIds])).map((d) => [d.id, d]) : []);
  const facIds = [...new Set([...depts.values()].map((d) => d.faculty_id).filter(Boolean))];
  const facs = new Map(facIds.length
    ? Faculty.hydrateAll(await db.all('SELECT * FROM catalog_faculty WHERE id IN (?)', [facIds])).map((f) => [f.id, f]) : []);
  for (const d of depts.values()) d.faculty = facs.get(d.faculty_id) || null;
  for (const b of bundles) b.department = depts.get(b.department_id) || null;
  return bundles;
}

async function hasAccess(user, subject = null, bundle = null, isEpt = false) {
  return (await AccessProfile.load(user)).allows(subject, bundle, isEpt);
}

/**
 * Turn a verified-successful Payment into an active Subscription. Idempotent
 * — safe from both the callback redirect and the webhook, whichever lands first.
 * `extra` holds payment fields to persist alongside (e.g. raw_response).
 */
async function activateSubscriptionFromPayment(payment, extra = {}) {
  if (payment.status === 'success' && payment.subscription_id) return payment.subscription_id;
  return db.transaction(async (tx) => {
    // Re-check under a row lock so a simultaneous callback + webhook can't double-extend.
    const fresh = await tx.one('SELECT * FROM billing_payment WHERE id = ? FOR UPDATE', [payment.id]);
    if (fresh.status === 'success' && fresh.subscription_id) return fresh.subscription_id;
    const plan = Plan.hydrate(await tx.one('SELECT * FROM billing_plan WHERE id = ?', [fresh.plan_id]));
    const now = new Date();
    const existing = await tx.one(
      `SELECT * FROM billing_subscription WHERE student_id = ? AND plan_id = ? AND status = 'active' AND ends_at >= ?
       ORDER BY ends_at DESC LIMIT 1`, [fresh.student_id, plan.id, now],
    );
    let subId;
    if (existing) {
      await tx.update('billing_subscription', existing.id, { ends_at: new Date(existing.ends_at.getTime() + plan.duration_days * DAY_MS) });
      subId = existing.id;
    } else {
      subId = await tx.insert('billing_subscription', {
        student_id: fresh.student_id, plan_id: plan.id, status: 'active', starts_at: now,
        ends_at: new Date(now.getTime() + plan.duration_days * DAY_MS),
        notes: `Paystack payment ${fresh.reference}`, created_by_id: null, created_at: now,
      });
    }
    await tx.update('billing_payment', fresh.id, { ...extra, subscription_id: subId, status: 'success', verified_at: now });
    return subId;
  });
}

module.exports = { AccessProfile, hasAccess, activateSubscriptionFromPayment, loadBundles, attachDepartments, Subscription, Payment };
