/**
 * `npm run smoke-test [baseUrl]` — end-to-end test against a running server
 * (start it with PAYMENT_SIMULATION=True for the checkout part). Creates
 * temporary accounts (random in-memory passwords), walks every page as each
 * role, signs up + subscribes + takes an exam, then deletes everything it made.
 */
const crypto = require('crypto');
const db = require('../src/db');
const accounts = require('../src/services/accounts');
const X = require('../src/services/exams');

const BASE = process.argv[2] || 'http://127.0.0.1:8000';
const TAG = `smoke${crypto.randomBytes(3).toString('hex')}`;
const PASSWORD = `Zx9!${crypto.randomBytes(9).toString('base64url')}`;
let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL ${m}`); };

class Client {
  constructor() { this.cookies = {}; }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies[pair.slice(0, i)] = pair.slice(i + 1);
    }
  }
  async req(method, path, { form, json, raw } = {}) {
    const headers = { Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
    let body;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; headers['X-CSRFToken'] = this.csrf; body = JSON.stringify(json); }
    if (raw) body = raw;
    const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
    this.store(res);
    const text = await res.text();
    const m = /name="csrfmiddlewaretoken" value="([^"]+)"/.exec(text);
    if (m) this.csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text, type: res.headers.get('content-type') || '' };
  }
  get(p) { return this.req('GET', p); }
  post(p, form = {}) {
    const params = new URLSearchParams();
    params.append('csrfmiddlewaretoken', this.csrf);
    for (const [k, v] of Object.entries(form)) for (const x of (Array.isArray(v) ? v : [v])) params.append(k, x);
    return this.req('POST', p, { form: params });
  }
  async login(username, password = PASSWORD) {
    await this.get('/accounts/login/');
    const r = await this.post('/accounts/login/', { username, password });
    return r.status === 302 ? r.location : null;
  }
}

async function page(c, path, needle, label = path) {
  const r = await c.get(path);
  if (r.status !== 200) { bad(`${label} -> HTTP ${r.status} ${r.location || ''} ${r.text.slice(0, 400).replace(/\s+/g, ' ')}`); return r; }
  if (needle && !r.text.includes(needle)) { bad(`${label} -> missing "${needle}"`); return r; }
  ok(label);
  return r;
}

async function main() {
  const admin = await accounts.createUser({ username: `${TAG}.super`, first_name: 'Smoke', last_name: 'Super', email: `${TAG}.super@example.com`, role: 'super_admin', is_staff: true, is_superuser: true }, PASSWORD);
  const staff = await accounts.createUser({ username: `${TAG}.staff`, first_name: 'Smoke', last_name: 'Staff', role: 'staff' }, PASSWORD);
  const ids = [admin.id, staff.id];
  const applicantEmail = `${TAG}.applicant@example.com`;

  try {
    // ── public site ──────────────────────────────────────────────────
    console.log('public');
    const anon = new Client();
    await page(anon, '/', 'Subscribe Now!', 'home page');
    await page(anon, '/how-it-works/', 'three steps', 'how it works');
    await page(anon, '/support/', 'How can we help?', 'support');
    const pr = await anon.get('/pricing/');
    pr.status === 301 && pr.location === '/subscribe/' ? ok('/pricing/ -> /subscribe/ (301)') : bad(`pricing -> ${pr.status} ${pr.location}`);
    const sub = await page(anon, '/subscribe/', 'Subscribe', 'subscribe page (anonymous)');
    await page(anon, '/accounts/login/', 'Welcome back', 'login page');
    const reg0 = await anon.get('/accounts/register/');
    reg0.status === 200 && reg0.text.includes('Try it free') ? ok('free sign-up page opens directly') : bad(`register -> ${reg0.status} ${reg0.location}`);
    const r404 = await anon.get('/nope/x/');
    r404.status === 404 ? ok('404') : bad(`404 -> ${r404.status}`);
    const rc = await anon.req('POST', '/accounts/login/', { form: { username: 'x', password: 'y' } });
    rc.status === 403 ? ok('CSRF enforced') : bad(`csrf -> ${rc.status}`);
    const dash = await anon.get('/dashboard/');
    dash.status === 302 && dash.location.startsWith('/accounts/login/') ? ok('dashboard requires login') : bad(`dashboard anon -> ${dash.status}`);

    // pick a subscribable postgraduate programme + tier from the page data
    const data = JSON.parse((/<script id="subscribe-data" type="application\/json">([\s\S]*?)<\/script>/.exec(sub.text) || [0, 'null'])[1]);
    const prog = data && data.faculties.flatMap((f) => f.depts.flatMap((d) => d.progs))[0];
    const tier = data && data.tiers[0];
    data ? ok(`subscribe data: ${data.faculties.length} facult(ies), ${data.tiers.length} tier(s), gateway=${data.gateway}`) : bad('no subscribe data');

    // ── sign up as an applicant (from the subscribe flow) ─────────────
    console.log('applicant');
    const s = new Client();
    const next = `/subscribe/?programs=${prog ? prog.id : ''}&tier=${tier ? tier.id : ''}`;
    await page(s, `/accounts/register/?next=${encodeURIComponent(next)}`, 'Create your account', 'register form');
    const weak = await s.post('/accounts/register/', { full_name: 'Smoke Applicant', email: applicantEmail, password: '12345678', password_confirm: '12345678', next });
    weak.text.includes('This password is too common.') && weak.text.includes('entirely numeric') ? ok('weak password rejected with Django messages') : bad('weak password');
    const regOk = await s.post('/accounts/register/', { full_name: 'Smoke Applicant', email: applicantEmail, password: PASSWORD, password_confirm: PASSWORD, next });
    regOk.status === 302 && regOk.location === next ? ok('sign-up logs in and returns to the selection') : bad(`register -> ${regOk.status} ${regOk.location}`);
    const applicant = await db.one('SELECT * FROM accounts_user WHERE username = ?', [applicantEmail]);
    if (applicant) ids.push(applicant.id);
    applicant && applicant.role === 'student' && /^STU-\d{8}$/.test(applicant.registration_number) ? ok(`student ${applicant.registration_number}`) : bad('applicant record');
    const dup = new Client();
    await dup.get(`/accounts/register/?next=${encodeURIComponent(next)}`);
    const dupR = await dup.post('/accounts/register/', { full_name: 'Other Person', email: applicantEmail.toUpperCase(), password: PASSWORD, password_confirm: PASSWORD, next });
    dupR.text.includes('already exists') ? ok('duplicate email refused (case-insensitive)') : bad('duplicate email');

    await page(s, '/dashboard/', 'Activate your access', 'dashboard (no subscription)');
    await page(s, '/exams/', 'My Exams', 'my exams (no subscription)');
    const loginEmail = new Client();
    (await loginEmail.login(applicantEmail.toUpperCase())) === '/accounts/redirect/' ? ok('login with email, any case') : bad('email login');

    if (prog && tier && data.gateway) {
      await s.get(next);
      const co = await s.post('/subscribe/checkout/', { tier: String(tier.id), programs: String(prog.id) });
      const simRef = (/\/subscribe\/test-payment\/([^/]+)\//.exec(co.location || '') || [])[1];
      if (simRef) {
        ok('checkout -> test payment page');
        const payment = await db.one('SELECT * FROM billing_payment WHERE reference = ?', [simRef]);
        Number(payment.amount) === tier.price ? ok(`price recomputed server-side: ₦${payment.amount}`) : bad(`amount ${payment.amount} vs ${tier.price}`);
        await page(s, `/subscribe/test-payment/${simRef}/`, 'Test payment', 'test payment page');
        await s.post(`/subscribe/test-payment/${simRef}/`, { outcome: 'success' });
        const done = await page(s, `/subscribe/test-payment/${simRef}/`, 'You now have access', 'payment success page');
        const subRow = await db.one("SELECT * FROM billing_subscription WHERE student_id = ? AND status = 'active'", [applicant.id]);
        subRow ? ok(`subscription active until ${subRow.ends_at.toISOString().slice(0, 10)}`) : bad('no subscription');
        const again = await s.post('/subscribe/checkout/', { tier: String(tier.id), programs: String(prog.id) });
        const againPage = await s.get('/subscribe/');
        againPage.text.includes('already have active access') ? ok('re-buying an active programme refused') : bad(`rebuy -> ${again.status}`);
      } else bad(`checkout -> ${co.status} ${co.location}`);
    } else console.log('  skip checkout (no postgraduate programme/tier or no gateway)');

    // ── take an exam the applicant can now open ────────────────────────
    const list = await page(s, '/exams/', 'My Exams', 'my exams (subscribed)');
    const examId = (/\/exams\/(\d+)\/start\//.exec(list.text) || [])[1];
    if (examId) {
      await page(s, `/exams/${examId}/start/`, 'Begin Exam', 'exam start page');
      const st = await s.post(`/exams/${examId}/start/`);
      const aid = (/\/attempt\/(\d+)\/take\//.exec(st.location || '') || [])[1];
      if (aid) {
        const take = await page(s, `/attempt/${aid}/take/`, 'exam-data', 'take page');
        const ed = JSON.parse(/<script id="exam-data" type="application\/json">([\s\S]*?)<\/script>/.exec(take.text)[1]);
        const answers = {};
        const leaked = ed.questions.some((q) => (q.choices || []).some((c) => 'is_correct' in c) || 'tf_answer' in q || 'explanation' in q);
        leaked ? bad('take page exposes the answer key in the page source') : ok('answer key not in page source');
        // The page no longer carries the key, so look up the right answers directly.
        const keyed = await X.hydrateExamQuestions(await db.all('SELECT * FROM examhub_examquestion WHERE id IN (?)', [ed.questions.map((q) => q.pk)]));
        for (const q of keyed) {
          if (q.eff_type === 'mcq_single') answers[q.id] = { type: 'choice', value: [Math.max(0, (q.eff_choices_data || []).findIndex((c) => c.is_correct))] };
        }
        const first = ed.questions[0];
        const sv = await s.req('POST', `/attempt/${aid}/save/`, { json: { question_pk: first.pk, ...(answers[first.pk] || { type: 'text', value: 'x' }) } });
        JSON.parse(sv.text).ok ? ok('autosave') : bad(`save -> ${sv.text}`);
        const sb = await s.req('POST', `/attempt/${aid}/submit/`, { json: { answers } });
        JSON.parse(sb.text).ok ? ok('submit') : bad(`submit -> ${sb.text}`);
        const att = await db.one('SELECT * FROM examhub_examattempt WHERE id = ?', [aid]);
        ok(`graded ${att.raw_score}/${att.max_score} = ${att.score_pct}%`);
        await page(s, `/attempt/${aid}/results/`, 'Score', 'results');
        await page(s, `/attempt/${aid}/review/`, 'Review', 'review');
        await page(s, '/results/', '#1', 'results history (attempt numbering)');
        await page(s, `/results/?exam=${examId}`, 'Practice again', 'results filtered by exam');
      } else bad(`start -> ${st.status} ${st.location}`);
    } else bad('no exam visible after subscribing');
    const subscribed = await db.one("SELECT id FROM billing_subscription WHERE student_id = ? AND status = 'active'", [applicant.id]);
    if (subscribed) await page(s, '/practice/', 'Practice', 'practice setup (subscribed)');
    else {
      const pr = await s.get('/practice/');
      pr.status === 302 && pr.location === '/trial/' ? ok('practice setup -> free trial (no subscription)') : bad(`practice setup unsubscribed -> ${pr.status} ${pr.location}`);
    }
    const locked = await s.get('/staff/');
    locked.status === 302 ? ok('student blocked from staff area') : bad(`student /staff/ -> ${locked.status}`);

    // ── staff ─────────────────────────────────────────────────────────
    console.log('staff');
    const t = new Client();
    (await t.login(staff.username)) === '/accounts/redirect/' ? ok('staff login') : bad('staff login');
    await page(t, '/staff/', 'Question Banks', 'staff dashboard');
    const adminOnly = await t.get('/staff/faculties/');
    adminOnly.status === 302 ? ok('staff blocked from admin catalog') : bad(`staff faculties -> ${adminOnly.status}`);
    await t.get('/staff/banks/new/');
    const nb = await t.post('/staff/banks/new/', { name: `${TAG} Bank`, description: 'x' });
    const bankId = (/\/staff\/banks\/(\d+)\/questions\//.exec(nb.location || '') || [])[1];
    if (bankId) {
      ok('create bank');
      await t.get(`/staff/banks/${bankId}/questions/add/`);
      const nq = await t.post(`/staff/banks/${bankId}/questions/add/`, { question_type: 'mcq_single', stem: `${TAG} Q?`, 'choice_text[]': ['Yes', 'No'], 'choice_correct[]': '0', default_points: '1' });
      nq.status === 302 ? ok('create question') : bad(`question -> ${nq.status}`);
      await page(t, `/staff/banks/${bankId}/questions/`, `${TAG} Q?`, 'bank questions');
      const bu = await t.post(`/staff/banks/${bankId}/bulk-upload/`, { fmt: 'json', raw_json: JSON.stringify([{ type: 'true_false', stem: `${TAG} tf`, answer: 'yes' }]) });
      bu.text.includes('imported successfully') ? ok('bulk upload') : bad('bulk upload');
    } else bad(`bank -> ${nb.status}`);
    const el = await page(t, '/staff/exams/', 'grouped by department', 'staff exam list');
    const deptBundle = (/kind=department&amp;bundle=(\d+)/.exec(el.text) || /kind=department&bundle=(\d+)/.exec(el.text) || [])[1];
    await page(t, '/staff/exams/new/?kind=ept', 'New exam', 'new exam form');
    const ne = await t.post('/staff/exams/new/', { kind: deptBundle ? 'department' : 'ept', bundle: deptBundle || '', title: `${TAG} Exam`, year: '2025', time_limit_minutes: '30', pass_score: '50', detect_tab_switch: 'on', allow_scratch_pad: 'on' });
    const secId = (/\/staff\/sections\/(\d+)\/questions\//.exec(ne.location || '') || [])[1];
    if (secId) {
      ok('create exam -> straight to its questions');
      await page(t, `/staff/sections/${secId}/questions/`, `${TAG} Exam`, 'manage questions');
      await t.post(`/staff/sections/${secId}/questions/`, { action: 'add_inline', question_type: 'mcq_single', stem: 'Inline?', points: '1', 'choice_text[]': ['A', 'B'], 'choice_correct[]': '1' });
      await t.post(`/staff/sections/${secId}/questions/`, { action: 'publish' });
      const ex = await db.one('SELECT e.* FROM examhub_exam e JOIN examhub_examsection s ON s.exam_id = e.id WHERE s.id = ?', [secId]);
      ex.is_published && Number(await db.value('SELECT COUNT(*) FROM examhub_examquestion WHERE section_id = ?', [secId])) === 1 ? ok('inline question + publish') : bad('inline/publish');
      await page(t, `/staff/exams/${ex.id}/edit/`, 'Edit exam', 'edit exam');
      await page(t, `/staff/exams/${ex.id}/sections/`, 'Sections', 'exam sections');
      await page(t, `/staff/exams/${ex.id}/analytics/`, 'Analytics', 'analytics');
      await page(t, `/staff/exams/${ex.id}/results/`, 'Results', 'results');
      const csv = await t.get(`/staff/exams/${ex.id}/results/?export=csv`);
      csv.type.includes('text/csv') ? ok('CSV export') : bad('csv');
      const cl = await t.post(`/staff/exams/${ex.id}/clone/`);
      cl.status === 302 ? ok('clone exam') : bad('clone');
    } else bad(`create exam -> ${ne.status} ${ne.location}`);

    // ── super admin ───────────────────────────────────────────────────
    console.log('super admin');
    const a = new Client();
    (await a.login(admin.username)) === '/accounts/redirect/' ? ok('super admin login') : bad('super login');
    await page(a, '/staff/', 'Total Revenue', 'dashboard with platform stats');
    for (const [p, n] of [['/staff/faculties/', 'Faculties'], ['/staff/departments/', 'Departments'], ['/staff/subjects/', 'Subjects'], ['/staff/programs/', 'Programs'],
      ['/accounts/staff/accounts/', 'Accounts'], ['/staff/subscriptions/', 'Subscriptions'], ['/staff/pricing/', 'Pricing'], ['/staff/plans/', 'Plans'],
      ['/staff/payments/', 'Payments'], ['/staff/settings/', 'Site Branding'], ['/staff/subscriptions/new/', 'Grant Subscription'], ['/staff/plans/new/', 'New Plan'],
      ['/staff/programs/new/', 'New Program'], ['/staff/departments/new/', 'New Department'], ['/admin/', 'Site administration']]) {
      await page(a, p, n, p);
    }
    await a.get('/staff/faculties/new/');
    await a.post('/staff/faculties/new/', { name: `${TAG} Faculty`, icon: '🎓', order: '3', is_active: 'on' });
    const fac = await db.one('SELECT * FROM catalog_faculty WHERE name = ?', [`${TAG} Faculty`]);
    fac && fac.slug === `${TAG}-faculty` ? ok(`faculty created, slug ${fac.slug}`) : bad('faculty');
    const dupF = await a.post('/staff/faculties/new/', { name: `${TAG} Faculty`, icon: '🎓', order: '3' });
    dupF.status === 200 && dupF.text.includes('already exists') ? ok('duplicate faculty name handled') : bad(`dup faculty -> ${dupF.status}`);
    if (fac) { await a.post(`/staff/faculties/${fac.id}/delete/`); ok('faculty deleted'); }
    await a.get('/accounts/staff/accounts/new/admin/');
    const na = await a.post('/accounts/staff/accounts/new/staff/', { first_name: TAG, last_name: 'Lecturer', email: '' });
    na.text.includes('account created') ? ok('create staff account (one-time password shown)') : bad('create staff');
    const lect = await db.one('SELECT id FROM accounts_user WHERE first_name = ?', [TAG]);
    if (lect) ids.push(lect.id);
    await a.post(`/accounts/staff/accounts/${admin.id}/toggle-active/`);
    const afterTog = await a.get('/accounts/staff/accounts/');
    /can(&#39;|&#x27;|')t disable your own account/.test(afterTog.text) && (await db.value('SELECT is_active FROM accounts_user WHERE id = ?', [admin.id]))
      ? ok('cannot disable own account') : bad('self toggle');
    await a.get('/staff/pricing/');
    await a.post('/staff/pricing/add/', { months: '35', price: '1,000' });
    const nt = await db.one('SELECT * FROM billing_pricingtier WHERE months = 35');
    nt && Number(nt.price) === 1000 ? ok('add pricing tier (commas accepted)') : bad('tier add');
    await a.post('/staff/pricing/add/', { months: '34', price: '99.5' });
    (await a.get('/staff/pricing/')).text.includes('Prices must be whole naira amounts.') && !await db.value('SELECT COUNT(*) FROM billing_pricingtier WHERE months = 34')
      ? ok('fractional price refused') : bad('fraction');
    if (nt) await a.post(`/staff/pricing/${nt.id}/delete/`);
    const site = await accounts.getSiteSettings();
    const ss = await a.post('/staff/settings/', {
      school_name: site.school_name, short_name: site.short_name, logo_url: site.logo_url, target_institution_name: site.target_institution_name,
      shared_exam_name: site.shared_exam_name, shared_exam_short_name: site.shared_exam_short_name, primary_color: site.primary_color,
      secondary_color: site.secondary_color, tagline: site.tagline, hero_headline: site.hero_headline, trust_line: site.trust_line,
      footer_note: site.footer_note, contact_email: site.contact_email, contact_phone: site.contact_phone, whatsapp_number: site.whatsapp_number,
    });
    ss.status === 302 ? ok('site settings save (unchanged values)') : bad('site settings');
    await page(a, '/admin/bundle/', 'Add', 'admin: bundles');
    await page(a, '/admin/sitesettings/', 'Add', 'admin: site settings');
    const staffTries = await t.get('/staff/settings/');
    staffTries.status === 302 ? ok('site branding is super-admin only') : bad('settings not gated');
    const wh = await anon.req('POST', '/subscribe/webhook/', { raw: '{}', json: undefined });
    wh.status === 400 ? ok('webhook rejects unsigned calls') : bad(`webhook -> ${wh.status}`);
    const lo = await a.post('/accounts/logout/');
    lo.status === 302 ? ok('logout') : bad('logout');
  } finally {
    await db.run('DELETE FROM examhub_exam WHERE created_by_id IN (?) OR owner_id IN (?)', [ids, ids]);
    await db.run('DELETE FROM examhub_questionbank WHERE created_by_id IN (?)', [ids]);
    const snapPlans = (await db.all('SELECT DISTINCT plan_id FROM billing_payment WHERE student_id IN (?)', [ids])).map((r) => r.plan_id);
    await db.run('DELETE FROM accounts_user WHERE id IN (?)', [ids]);
    if (snapPlans.length) await db.run('DELETE FROM billing_plan WHERE id IN (?) AND is_order_snapshot = 1', [snapPlans]);
    await db.run('DELETE FROM billing_pricingtier WHERE months IN (34, 35)');
    await db.run('DELETE FROM catalog_faculty WHERE name LIKE ?', [`${TAG}%`]);
    console.log(`cleaned up (${TAG})`);
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
}

main().then(() => db.close()).then(() => process.exit(failures ? 1 : 0)).catch(async (err) => { console.error(err); await db.close(); process.exit(1); });
