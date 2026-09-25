/** Port of billing/views.py — plans, pricing tiers, subscriptions, payments and the Paystack checkout. */
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const db = require('../db');
const { User, Subject, Bundle, Plan, PricingTier, Subscription, Payment } = require('../models');
const { route, render, redirect, messages, getOr404, reverse, Http404 } = require('../web');
const { parseLocalDateTime } = require('../templating');
const paystack = require('../services/paystack');
const { activateSubscriptionFromPayment, attachDepartments } = require('../services/billing');
const X = require('../services/exams');
const { contains, strip, intOrNull } = require('../services/util');

const router = express.Router();
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CART_PROGRAMS = 10;
const MAX_TIER_MONTHS = 36;
const MAX_TIER_PRICE = 9999999;

const isAdmin = (req) => req.user.is_authenticated && req.user.is_admin;
const isStudent = (req) => req.user.is_authenticated && req.user.is_student;

function denied(req, res) {
  messages.error(req, 'Access denied.');
  return redirect(res, '/');
}

const gatewayConfigured = () => Boolean(config.PAYSTACK_SECRET_KEY) || config.PAYMENT_SIMULATION;
const monthsLabel = (m) => `${m} month${m !== 1 ? 's' : ''}`;

/** "%d %b %Y" of an aware datetime, as Python's strftime prints it (UTC). */
function utcDate(d) {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

async function planWithScopes(plans) {
  const ids = plans.map((p) => p.id);
  if (!ids.length) return plans;
  const subj = await db.all('SELECT ps.plan_id, s.* FROM billing_plan_subjects ps JOIN catalog_subject s ON s.id = ps.subject_id WHERE ps.plan_id IN (?) ORDER BY s.name', [ids]);
  const bund = await db.all('SELECT pb.plan_id, b.* FROM billing_plan_bundles pb JOIN catalog_bundle b ON b.id = pb.bundle_id WHERE pb.plan_id IN (?) ORDER BY b.name', [ids]);
  for (const p of plans) {
    p.subjects = Subject.hydrateAll(subj.filter((r) => r.plan_id === p.id));
    p.bundles = Bundle.hydrateAll(bund.filter((r) => r.plan_id === p.id));
  }
  return plans;
}

async function setPlanLinks(tx, planId, table, col, ids) {
  await tx.run(`DELETE FROM \`${table}\` WHERE plan_id = ?`, [planId]);
  if (ids.length) await tx.insertMany(table, [...new Set(ids)].map((v) => ({ plan_id: planId, [col]: v })));
}

// ─────────────────────────────────────────── PLANS ──

route(router, 'billing:plan_list', async (req, res) => {
  if (!isAdmin(req)) return denied(req, res);
  const plans = await planWithScopes(Plan.hydrateAll(await db.all('SELECT * FROM billing_plan WHERE is_order_snapshot = 0 ORDER BY name')));
  return render(req, res, 'billing/staff/plan_list.html', { active: 'plans', plans });
}, { login: true });

async function planForm(req, res, { pk = null } = {}) {
  if (!isAdmin(req)) return denied(req, res);
  const plan = pk ? await getOr404(db.one('SELECT * FROM billing_plan WHERE id = ?', [pk]).then((r) => Plan.hydrate(r))) : null;
  const subjects = Subject.hydrateAll(await db.all('SELECT * FROM catalog_subject ORDER BY name'));
  // Postgraduate programmes are priced/granted by the subscribe flow (PricingTier),
  // so they're deliberately left off this manual form.
  const bundles = Bundle.hydrateAll(await db.all("SELECT * FROM catalog_bundle WHERE level <> 'postgraduate' ORDER BY name"));

  if (req.method === 'POST') {
    const p = req.POST;
    const name = strip(p.get('name', ''));
    if (!name) {
      messages.error(req, 'Plan name is required.');
    } else {
      const priceRaw = strip(p.get('price', '0')) || '0';
      const daysRaw = strip(p.get('duration_days', '30')) || '30';
      const data = {
        name, description: strip(p.get('description', '')),
        price: /^[-+]?(\d+\.?\d*|\.\d+)$/.test(priceRaw) ? Number(priceRaw) : 0,
        duration_days: /^\d+$/.test(daysRaw) ? parseInt(daysRaw, 10) : 30,
        is_all_access: p.has('is_all_access'), is_active: p.has('is_active'),
      };
      const subjectIds = p.getlist('subjects[]').map(intOrNull).filter((x) => x !== null);
      const bundleIds = p.getlist('bundles[]').map(intOrNull).filter((x) => bundles.some((b) => b.id === x));
      await db.transaction(async (tx) => {
        let id = plan ? plan.id : null;
        if (id) await tx.update('billing_plan', id, data);
        else id = await tx.insert('billing_plan', { ...data, is_order_snapshot: false, created_at: new Date() });
        const validSubjects = subjectIds.length ? (await tx.all('SELECT id FROM catalog_subject WHERE id IN (?)', [subjectIds])).map((r) => r.id) : [];
        await setPlanLinks(tx, id, 'billing_plan_subjects', 'subject_id', validSubjects);
        await setPlanLinks(tx, id, 'billing_plan_bundles', 'bundle_id', bundleIds);
      });
      messages.success(req, 'Plan saved.');
      return redirect(res, 'billing:plan_list');
    }
  }

  const selSubjects = plan ? (await db.all('SELECT subject_id FROM billing_plan_subjects WHERE plan_id = ?', [plan.id])).map((r) => r.subject_id) : [];
  const selBundles = plan ? (await db.all('SELECT bundle_id FROM billing_plan_bundles WHERE plan_id = ?', [plan.id])).map((r) => r.bundle_id) : [];
  return render(req, res, 'billing/staff/plan_form.html', {
    active: 'plans', plan, subjects, bundles, selected_subject_ids: selSubjects, selected_bundle_ids: selBundles,
  });
}
route(router, 'billing:plan_add', (req, res) => planForm(req, res), { login: true });
route(router, 'billing:plan_edit', (req, res, p) => planForm(req, res, p), { login: true });

route(router, 'billing:plan_delete', async (req, res, { pk }) => {
  if (!isAdmin(req)) return redirect(res, '/');
  const plan = await getOr404(db.one('SELECT * FROM billing_plan WHERE id = ?', [pk]));
  try {
    await db.remove('billing_plan', plan.id);
    messages.success(req, `Plan "${plan.name}" deleted.`);
  } catch (err) {
    if (err.code !== 'ER_ROW_IS_REFERENCED_2' && err.code !== 'ER_ROW_IS_REFERENCED') throw err;
    // Django's on_delete=PROTECT: a plan with subscriptions or payments can't be deleted.
    messages.error(req, `Plan "${plan.name}" can't be deleted because subscriptions or payments use it. Mark it inactive instead.`);
  }
  return redirect(res, 'billing:plan_list');
}, { login: true, post: true });

// ─────────────────────────────────────────── SUBSCRIPTIONS ──

route(router, 'billing:subscription_list', async (req, res) => {
  if (!isAdmin(req)) return denied(req, res);
  const where = [];
  const params = [];
  const search = strip(req.GET.get('q', ''));
  const status = req.GET.get('status', '');
  if (search) {
    where.push("(u.username LIKE ? ESCAPE '\\\\' OR u.first_name LIKE ? ESCAPE '\\\\' OR u.last_name LIKE ? ESCAPE '\\\\' OR u.registration_number LIKE ? ESCAPE '\\\\')");
    const s = contains(search);
    params.push(s, s, s, s);
  }
  if (status) { where.push('s.status = ?'); params.push(status); }
  const subs = Subscription.hydrateAll(await db.all(
    `SELECT s.* FROM billing_subscription s JOIN accounts_user u ON u.id = s.student_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.created_at DESC`, params,
  ));
  await X.attachUsers(subs, 'student_id', 'student');
  await X.attachUsers(subs, 'created_by_id', 'created_by');
  const plans = await X.byIds(Plan, 'billing_plan', subs.map((s) => s.plan_id));
  for (const s of subs) s.plan = plans.get(s.plan_id);
  return render(req, res, 'billing/staff/subscription_list.html', {
    active: 'subscriptions', subscriptions: subs, status_choices: Subscription.STATUS_CHOICES, filters: { q: search, status },
  });
}, { login: true });

async function subscriptionForm(req, res, { pk = null } = {}) {
  if (!isAdmin(req)) return denied(req, res);
  const subscription = pk ? await getOr404(db.one('SELECT * FROM billing_subscription WHERE id = ?', [pk]).then((r) => Subscription.hydrate(r))) : null;
  const plans = Plan.hydrateAll(await db.all(`SELECT * FROM billing_plan ${subscription ? '' : 'WHERE is_active = 1'} ORDER BY name`));

  const search = strip(req.GET.get('q', ''));
  const params = [];
  let where = "role = 'student'";
  if (search) {
    where += " AND (username LIKE ? ESCAPE '\\\\' OR first_name LIKE ? ESCAPE '\\\\' OR last_name LIKE ? ESCAPE '\\\\' OR registration_number LIKE ? ESCAPE '\\\\')";
    const s = contains(search);
    params.push(s, s, s, s);
  }
  const students = User.hydrateAll(await db.all(`SELECT * FROM accounts_user WHERE ${where} ORDER BY first_name, last_name`, params));

  if (req.method === 'POST') {
    const p = req.POST;
    const studentPk = intOrNull(p.get('student'));
    const plan = Plan.hydrate(await db.one('SELECT * FROM billing_plan WHERE id = ?', [intOrNull(p.get('plan')) ?? -1]));
    const student = studentPk ? await db.one('SELECT id FROM accounts_user WHERE id = ?', [studentPk]) : null;
    if (!student || !plan) {
      messages.error(req, 'Choose a student and a plan.');
    } else {
      const startsAt = parseLocalDateTime(p.get('starts_at') || '') || new Date();
      const endsAt = parseLocalDateTime(p.get('ends_at') || '') || new Date(startsAt.getTime() + plan.duration_days * DAY_MS);
      const data = {
        student_id: student.id, plan_id: plan.id, status: p.get('status', 'active'), starts_at: startsAt, ends_at: endsAt,
        notes: strip(p.get('notes', '')).slice(0, 255),
      };
      if (subscription) await db.update('billing_subscription', subscription.id, data);
      else await db.insert('billing_subscription', { ...data, created_by_id: req.user.id, created_at: new Date() });
      messages.success(req, 'Subscription saved.');
      return redirect(res, 'billing:subscription_list');
    }
  }

  return render(req, res, 'billing/staff/subscription_form.html', { active: 'subscriptions', subscription, plans, students, search });
}
route(router, 'billing:subscription_add', (req, res) => subscriptionForm(req, res), { login: true });
route(router, 'billing:subscription_edit', (req, res, p) => subscriptionForm(req, res, p), { login: true });

route(router, 'billing:subscription_cancel', async (req, res, { pk }) => {
  if (!isAdmin(req)) return redirect(res, '/');
  const sub = await getOr404(db.one('SELECT id FROM billing_subscription WHERE id = ?', [pk]));
  await db.update('billing_subscription', sub.id, { status: 'cancelled' });
  messages.success(req, 'Subscription cancelled.');
  return redirect(res, 'billing:subscription_list');
}, { login: true, post: true });

// ─────────────────────────────────────────── PAYMENTS (ADMIN LEDGER) ──

route(router, 'billing:payment_list', async (req, res) => {
  if (!isAdmin(req)) return denied(req, res);
  const status = req.GET.get('status', '');
  const payments = Payment.hydrateAll(await db.all(
    `SELECT * FROM billing_payment ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC`, status ? [status] : [],
  ));
  await X.attachUsers(payments, 'student_id', 'student');
  const plans = await X.byIds(Plan, 'billing_plan', payments.map((p) => p.plan_id));
  for (const p of payments) p.plan = plans.get(p.plan_id);
  const totalRevenue = Number(await db.value("SELECT COALESCE(SUM(amount), 0) FROM billing_payment WHERE status = 'success'")) || 0;
  return render(req, res, 'billing/staff/payment_list.html', {
    active: 'payments', payments, status_choices: Payment.STATUS_CHOICES, filters: { status }, total_revenue: totalRevenue,
  });
}, { login: true });

// ─────────────────────────────────────────── STUDENT CHECKOUT (PAYSTACK) ──

/** Subscribable postgraduate programmes: active, not hidden by an inactive department/faculty. */
async function availablePrograms(extraWhere = '', params = []) {
  const rows = await db.all(
    `SELECT b.* FROM catalog_bundle b
       LEFT JOIN catalog_department d ON d.id = b.department_id
       LEFT JOIN catalog_faculty f ON f.id = d.faculty_id
     WHERE b.is_active = 1 AND b.level = 'postgraduate'
       AND (d.id IS NULL OR d.is_active = 1) AND (f.id IS NULL OR f.is_active = 1) ${extraWhere}
     ORDER BY f.\`order\`, f.name, d.\`order\`, d.name, b.\`order\`, b.name`, params,
  );
  return attachDepartments(Bundle.hydrateAll(rows));
}

/** Faculty -> department -> programme tree for the subscribe page ("Other"/"General" buckets sort last). */
function catalogPayload(programs, activeUntil) {
  const faculties = new Map();
  for (const b of programs) {
    const dept = b.department;
    const fac = dept ? dept.faculty : null;
    const fk = fac ? fac.id : 0;
    if (!faculties.has(fk)) faculties.set(fk, { id: fk, name: fac ? fac.name : 'Other programmes', depts: new Map() });
    const f = faculties.get(fk);
    const dk = dept ? dept.id : 0;
    if (!f.depts.has(dk)) f.depts.set(dk, { id: dk, name: dept ? dept.name : 'General', progs: [] });
    const until = activeUntil.get(b.id);
    f.depts.get(dk).progs.push({ id: b.id, name: b.name, until: until ? utcDate(until) : null });
  }
  const stableLast = (arr) => [...arr.filter((x) => x.id !== 0), ...arr.filter((x) => x.id === 0)];
  return stableLast([...faculties.values()].map((f) => ({ ...f, depts: stableLast([...f.depts.values()]) })));
}

function parseIds(raw) {
  const ids = [];
  for (const part of String(raw || '').split(',')) {
    const t = part.trim();
    if (/^\d+$/.test(t) && !ids.includes(parseInt(t, 10))) ids.push(parseInt(t, 10));
  }
  return ids;
}

/**
 * The one subscribe page — public. Anyone can build a selection; the final
 * button takes a signed-in student to payment, or sends a visitor through
 * sign-up/login and back with the selection intact.
 */
route(router, 'billing:plans_browse', async (req, res) => {
  const { user } = req;
  if (user.is_authenticated && !user.is_student) {
    messages.error(req, 'Only student accounts can subscribe.');
    return redirect(res, 'accounts:post_login_redirect');
  }

  const now = new Date();
  const activeUntil = new Map();
  const activePlanIds = [];
  if (user.is_authenticated) {
    const subs = await db.all("SELECT id, plan_id, ends_at FROM billing_subscription WHERE student_id = ? AND status = 'active' AND ends_at >= ?", [user.id, now]);
    const links = subs.length ? await db.all('SELECT plan_id, bundle_id FROM billing_plan_bundles WHERE plan_id IN (?)', [[...new Set(subs.map((s) => s.plan_id))]]) : [];
    for (const s of subs) {
      activePlanIds.push(s.plan_id);
      for (const l of links) {
        if (l.plan_id !== s.plan_id) continue;
        if (!activeUntil.has(l.bundle_id) || s.ends_at > activeUntil.get(l.bundle_id)) activeUntil.set(l.bundle_id, s.ends_at);
      }
    }
  }

  const programs = await availablePrograms();
  const faculties = catalogPayload(programs, activeUntil);
  const validIds = new Set(programs.map((b) => b.id));
  const tiers = PricingTier.hydrateAll(await db.all('SELECT * FROM billing_pricingtier WHERE is_active = 1 ORDER BY months'));

  // Restore a selection carried through sign-up/login (?programs=1,2&tier=3), and the older ?department= deep link.
  const initialPrograms = parseIds(req.GET.get('programs')).filter((i) => validIds.has(i) && !activeUntil.has(i));
  const tierRaw = req.GET.get('tier', '');
  const tierId = /^\d+$/.test(tierRaw) ? parseInt(tierRaw, 10) : null;
  let initialFaculty = null;
  const deptId = req.GET.get('department');
  if (deptId && /^\d+$/.test(deptId)) {
    const f = faculties.find((fac) => fac.depts.some((d) => d.id === parseInt(deptId, 10)));
    initialFaculty = f ? f.id : null;
  }

  // Everything else (Post-UTME / manual plans) keeps its own plan list.
  let generalPlans = [];
  if (user.is_authenticated) {
    generalPlans = await planWithScopes(Plan.hydrateAll(await db.all(
      `SELECT * FROM billing_plan WHERE is_active = 1 AND is_order_snapshot = 0 AND id NOT IN (
         SELECT pb.plan_id FROM billing_plan_bundles pb JOIN catalog_bundle b ON b.id = pb.bundle_id WHERE b.level = 'postgraduate'
       ) ORDER BY name`,
    )));
  }

  return render(req, res, 'billing/student/plans_browse.html', {
    subscribe_data: {
      faculties,
      tiers: tiers.map((t) => ({ id: t.id, months: t.months, price: Math.trunc(Number(t.price)) })),
      initial: { programs: initialPrograms, tier: tierId, faculty: initialFaculty },
      cap: MAX_CART_PROGRAMS,
      authed: user.is_authenticated,
      gateway: gatewayConfigured(),
      urls: { subscribe: reverse('billing:plans_browse'), register: reverse('accounts:register'), login: reverse('accounts:login') },
    },
    tiers,
    has_programs: programs.length > 0,
    general_plans: generalPlans,
    active_plan_ids: activePlanIds,
    gateway_configured: gatewayConfigured(),
    payment_simulation: config.PAYMENT_SIMULATION,
  });
});

/** Create the Payment for `plan` and send the student to Paystack (or the local simulator). */
async function startPayment(req, res, plan, { deletePlanOnAbort = false } = {}) {
  const { user } = req;
  const base = { student_id: user.id, plan_id: plan.id, amount: plan.price, status: 'pending', subscription_id: null, raw_response: {}, created_at: new Date(), verified_at: null };

  if (config.PAYMENT_SIMULATION) {
    const reference = `sim_${crypto.randomBytes(16).toString('hex')}`;
    await db.insert('billing_payment', { ...base, reference });
    return redirect(res, 'billing:sim_payment', reference);
  }

  const reference = `cbt_${crypto.randomBytes(16).toString('hex')}`;
  const paymentId = await db.insert('billing_payment', { ...base, reference });
  try {
    const data = await paystack.initializeTransaction({
      email: user.email, amountNaira: plan.price, reference,
      callbackUrl: `${config.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}${reverse('billing:checkout_callback')}`,
      metadata: { student_id: user.id, plan_id: plan.id },
    });
    return res.redirect(302, data.authorization_url);
  } catch (err) {
    if (err instanceof paystack.PaystackNotConfigured) {
      await db.remove('billing_payment', paymentId);
      if (deletePlanOnAbort) await db.remove('billing_plan', plan.id);
      messages.error(req, "Online payment isn't set up yet. Please contact support to arrange access.");
      return redirect(res, 'billing:plans_browse');
    }
    if (err instanceof paystack.PaystackError) {
      await db.update('billing_payment', paymentId, { status: 'failed' });
      messages.error(req, `Couldn't start payment: ${err.message}`);
      return redirect(res, 'billing:plans_browse');
    }
    throw err;
  }
}

route(router, 'billing:checkout_start', async (req, res, { plan_pk }) => {
  if (!isStudent(req)) return denied(req, res);
  const plan = await getOr404(db.one('SELECT * FROM billing_plan WHERE id = ? AND is_active = 1 AND is_order_snapshot = 0', [plan_pk]).then((r) => Plan.hydrate(r)));
  if (!req.user.email) {
    messages.error(req, 'Add an email address to your profile before subscribing.');
    return redirect(res, 'accounts:my_profile');
  }
  return startPayment(req, res, plan);
}, { login: true, post: true });

/**
 * Buy one or more postgraduate programmes for one tier length. The price is
 * recomputed here from the site-wide PricingTier and the number of *valid*
 * programmes — nothing the browser sends about money is trusted. The order is
 * recorded as a hidden snapshot Plan listing exactly the programmes bought.
 */
route(router, 'billing:checkout_cart', async (req, res) => {
  if (!isStudent(req)) return denied(req, res);
  const tierRaw = req.POST.get('tier', '');
  const tier = /^\d+$/.test(tierRaw)
    ? PricingTier.hydrate(await db.one('SELECT * FROM billing_pricingtier WHERE id = ? AND is_active = 1', [parseInt(tierRaw, 10)])) : null;
  const ids = parseIds(req.POST.getlist('programs').join(','));
  const programs = ids.length ? await availablePrograms('AND b.id IN (?)', [ids]) : [];

  if (!tier || !programs.length) {
    messages.error(req, 'Choose at least one programme and a plan length.');
    return redirect(res, 'billing:plans_browse');
  }
  if (programs.length > MAX_CART_PROGRAMS) {
    messages.error(req, `You can subscribe to up to ${MAX_CART_PROGRAMS} programmes at a time.`);
    return redirect(res, 'billing:plans_browse');
  }
  if (!req.user.email) {
    messages.error(req, 'Add an email address to your profile before subscribing.');
    return redirect(res, 'accounts:my_profile');
  }

  const already = (await db.all(
    `SELECT DISTINCT b.name FROM catalog_bundle b
       JOIN billing_plan_bundles pb ON pb.bundle_id = b.id
       JOIN billing_subscription s ON s.plan_id = pb.plan_id
     WHERE b.id IN (?) AND s.student_id = ? AND s.status = 'active' AND s.ends_at >= ? ORDER BY b.name`,
    [programs.map((p) => p.id), req.user.id, new Date()],
  )).map((r) => r.name);
  if (already.length) {
    messages.error(req, `You already have active access to: ${already.join(', ')}.`);
    return redirect(res, 'billing:plans_browse');
  }

  const label = monthsLabel(tier.months);
  const name = programs.length === 1 ? `${programs[0].name} — ${label}` : `${programs[0].name} + ${programs.length - 1} more — ${label}`;
  const planId = await db.transaction(async (tx) => {
    const id = await tx.insert('billing_plan', {
      name: [...name].slice(0, 150).join(''), description: `Programmes: ${programs.map((p) => p.name).join('; ')}`,
      price: Number(tier.price) * programs.length, duration_days: tier.duration_days,
      is_all_access: false, is_active: false, is_order_snapshot: true, created_at: new Date(),
    });
    await tx.insertMany('billing_plan_bundles', programs.map((p) => ({ plan_id: id, bundle_id: p.id })));
    return id;
  });
  const plan = Plan.hydrate(await db.one('SELECT * FROM billing_plan WHERE id = ?', [planId]));
  return startPayment(req, res, plan, { deletePlanOnAbort: true });
}, { login: true, post: true });

async function paymentWithPlan(where, params) {
  const payment = Payment.hydrate(await db.one(`SELECT * FROM billing_payment WHERE ${where}`, params));
  if (payment) payment.plan = Plan.hydrate(await db.one('SELECT * FROM billing_plan WHERE id = ?', [payment.plan_id]));
  return payment;
}

/** Verifies a Paystack payload against the expected amount; activates or fails the payment. */
async function settlePayment(payment, data) {
  const expectedKobo = Math.round(Number(payment.amount) * 100);
  if (data.status === 'success' && Number(data.amount) === expectedKobo) {
    await activateSubscriptionFromPayment(payment, { raw_response: data });
  } else {
    await db.update('billing_payment', payment.id, { raw_response: data, status: 'failed' });
  }
}

route(router, 'billing:checkout_callback', async (req, res) => {
  if (!isStudent(req)) return denied(req, res);
  const reference = req.GET.get('reference', '');
  let payment = await getOr404(paymentWithPlan('reference = ? AND student_id = ?', [reference, req.user.id]));

  if (payment.status !== 'success') {
    let data;
    try {
      data = await paystack.verifyTransaction(reference);
    } catch (err) {
      if (!(err instanceof paystack.PaystackError)) throw err;
      messages.error(req, `Couldn't verify payment: ${err.message}`);
      return render(req, res, 'billing/student/checkout_result.html', { payment, success: false });
    }
    await settlePayment(payment, data);
    payment = await paymentWithPlan('id = ?', [payment.id]);
  }
  return render(req, res, 'billing/student/checkout_result.html', { payment, success: payment.status === 'success' });
}, { login: true });

/** Paystack's server-to-server notification (CSRF-exempt; authenticated by HMAC signature). */
route(router, 'billing:payment_webhook', async (req, res) => {
  if (!paystack.verifyWebhookSignature(req.rawBuffer, req.get('X-Paystack-Signature') || '')) return res.status(400).end();
  let event;
  try { event = JSON.parse(req.rawBody); } catch (_) { return res.status(400).end(); }
  if (event && event.event === 'charge.success') {
    const data = event.data || {};
    const payment = await paymentWithPlan('reference = ?', [data.reference || '']);
    if (payment && payment.status !== 'success') await settlePayment(payment, data);
  }
  return res.status(200).end();
}, { post: true });

// ─────────────────────────────────────────── PRICING (ADMIN) ──

/** Whole naira only, more than zero. Returns [price|null, error|null]. */
function parsePrice(raw) {
  const text = String(raw ?? '').replace(/,/g, '').replace(/₦/g, '').trim();
  if (/^[-+]?(nan|snan|inf|infinity)$/i.test(text)) return [null, 'Enter a valid price.'];
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return [null, 'Enter a valid price.'];
  const value = Number(text);
  if (!Number.isFinite(value)) return [null, 'Enter a valid price.'];
  if (!Number.isInteger(value)) return [null, 'Prices must be whole naira amounts.'];
  if (value <= 0) return [null, 'A price must be more than ₦0.'];
  if (value > MAX_TIER_PRICE) return [null, 'That price is too large.'];
  return [value, null];
}

/** One price list for every postgraduate programme; past purchases keep the price they were bought at. */
route(router, 'billing:tier_list', async (req, res) => {
  if (!isAdmin(req)) return denied(req, res);
  const tiers = PricingTier.hydrateAll(await db.all('SELECT * FROM billing_pricingtier ORDER BY months'));

  if (req.method === 'POST') {
    const errors = [];
    const updates = [];
    for (const t of tiers) {
      const [price, err] = parsePrice(req.POST.get(`price_${t.id}`));
      if (err) errors.push(`${monthsLabel(t.months)}: ${err}`);
      else updates.push([t, price, req.POST.has(`active_${t.id}`)]);
    }
    if (errors.length) {
      for (const e of errors) messages.error(req, e);
      messages.error(req, 'Nothing was saved. Please fix the prices above and try again.');
    } else {
      let changed = 0;
      for (const [t, price, active] of updates) {
        if (Number(t.price) !== price || t.is_active !== active) {
          await db.update('billing_pricingtier', t.id, { price, is_active: active });
          changed++;
        }
      }
      messages.success(req, changed ? 'Pricing saved.' : 'No changes to save.');
      if (updates.length && !updates.some(([, , active]) => active)) messages.warning(req, "No plan length is active, so applicants can't subscribe right now.");
    }
    return redirect(res, 'billing:tier_list');
  }

  return render(req, res, 'billing/staff/tier_list.html', { active: 'pricing', tiers });
}, { login: true });

route(router, 'billing:tier_add', async (req, res) => {
  if (!isAdmin(req)) return redirect(res, '/');
  const monthsRaw = strip(req.POST.get('months', ''));
  const [price, err] = parsePrice(req.POST.get('price'));
  const months = /^\d+$/.test(monthsRaw) ? parseInt(monthsRaw, 10) : null;
  if (months === null || months < 1 || months > MAX_TIER_MONTHS) {
    messages.error(req, `Length must be a whole number of months from 1 to ${MAX_TIER_MONTHS}.`);
  } else if (err) {
    messages.error(req, err);
  } else if (await db.value('SELECT COUNT(*) FROM billing_pricingtier WHERE months = ?', [months])) {
    messages.error(req, `There is already a ${months}-month plan. Edit its price in the table instead.`);
  } else {
    await db.insert('billing_pricingtier', { months, price, is_active: true });
    messages.success(req, 'Plan length added.');
  }
  return redirect(res, 'billing:tier_list');
}, { login: true, post: true });

route(router, 'billing:tier_delete', async (req, res, { pk }) => {
  if (!isAdmin(req)) return redirect(res, '/');
  const tier = await getOr404(db.one('SELECT * FROM billing_pricingtier WHERE id = ?', [pk]));
  await db.remove('billing_pricingtier', tier.id);
  messages.success(req, `Removed the ${tier.months}-month plan. Existing subscriptions are not affected.`);
  return redirect(res, 'billing:tier_list');
}, { login: true, post: true });

// ─────────────────────────────────────────── TEST PAYMENT (LOCAL ONLY) ──

/**
 * Stand-in for Paystack's hosted page while PAYMENT_SIMULATION is on (local
 * testing only). Runs the same activation code a real payment does.
 */
route(router, 'billing:sim_payment', async (req, res, { reference }) => {
  if (!config.PAYMENT_SIMULATION || !reference.startsWith('sim_') || !isStudent(req)) throw new Http404();
  const payment = await getOr404(paymentWithPlan('reference = ? AND student_id = ?', [reference, req.user.id]));

  if (req.method === 'POST' && payment.status === 'pending') {
    if (req.POST.get('outcome') === 'success') await activateSubscriptionFromPayment(payment);
    else await db.update('billing_payment', payment.id, { status: 'failed' });
    return redirect(res, 'billing:sim_payment', reference);
  }
  if (payment.status !== 'pending') {
    return render(req, res, 'billing/student/checkout_result.html', { payment, success: payment.status === 'success' });
  }
  const programmes = Bundle.hydrateAll(await db.all(
    'SELECT b.* FROM catalog_bundle b JOIN billing_plan_bundles pb ON pb.bundle_id = b.id WHERE pb.plan_id = ? ORDER BY b.name', [payment.plan_id],
  ));
  return render(req, res, 'billing/student/sim_payment.html', { payment, programmes });
}, { login: true });

module.exports = { router };
