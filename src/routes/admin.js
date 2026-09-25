/**
 * /admin/ — a generic data-management console standing in for the Django
 * admin. Same models and list/search/filter columns as the Django
 * ModelAdmin registrations; forms are generated from each table's columns.
 * Like Django admin, only active users with is_staff can use it.
 */
const express = require('express');
const db = require('../db');
const { render, messages, Http404 } = require('../web');
const passwords = require('../services/passwords');
const accounts = require('../services/accounts');
const { contains } = require('../services/util');
const { User } = require('../models');

const router = express.Router();

// Tables whose `slug` is auto-generated from `name` when left blank (the catalog models' save()).
const SLUG_FALLBACKS = { catalog_faculty: 'faculty', catalog_department: 'department', catalog_bundle: 'bundle' };

// app label -> models; list/search/filter columns mirror the CBT_UI admin.py files.
const REGISTRY = [
  { app: 'Accounts', models: [
    { key: 'user', table: 'accounts_user', name: 'Users', str: (r) => r.username, list: ['username', 'first_name', 'last_name', 'email', 'role', 'registration_number', 'must_change_password', 'is_active'], search: ['username', 'first_name', 'last_name', 'email', 'registration_number'], filters: ['role', 'is_active', 'must_change_password'] },
  ] },
  { app: 'Catalog', models: [
    { key: 'subject', table: 'catalog_subject', name: 'Subjects', str: (r) => r.name, list: ['name', 'icon', 'is_active'], search: ['name'], filters: ['is_active'] },
    { key: 'faculty', table: 'catalog_faculty', name: 'Faculties', str: (r) => r.name, list: ['name', 'icon', 'order', 'is_active'], search: ['name'], filters: ['is_active'] },
    { key: 'department', table: 'catalog_department', name: 'Departments', str: (r) => r.name, list: ['name', 'faculty_id', 'icon', 'order', 'is_active'], search: ['name'], filters: ['is_active', 'faculty_id'] },
    { key: 'bundle', table: 'catalog_bundle', name: 'Bundles', str: (r) => r.name, list: ['name', 'slug', 'icon', 'department_id', 'level', 'order', 'is_active'], search: ['name'], filters: ['is_active', 'level', 'department_id'] },
  ] },
  { app: 'Billing', models: [
    { key: 'plan', table: 'billing_plan', name: 'Plans', str: (r) => r.name, list: ['name', 'price', 'duration_days', 'is_all_access', 'is_active'], search: ['name'], filters: ['is_all_access', 'is_active', 'is_order_snapshot'] },
    { key: 'subscription', table: 'billing_subscription', name: 'Subscriptions', str: (r) => `Subscription #${r.id}`, list: ['student_id', 'plan_id', 'status', 'starts_at', 'ends_at', 'created_by_id'], search: [], filters: ['status', 'plan_id'] },
    { key: 'pricingtier', table: 'billing_pricingtier', name: 'Pricing tiers', str: (r) => `${r.months} month${r.months !== 1 ? 's' : ''}`, list: ['months', 'price', 'is_active'], search: [], filters: [] },
  ] },
  { app: 'Branding', models: [
    { key: 'sitesettings', table: 'branding_sitesettings', name: 'Site Settings', str: (r) => r.school_name, list: ['school_name', 'short_name', 'primary_color', 'secondary_color', 'updated_at'], search: [], filters: [] },
  ] },
  { app: 'Examhub', models: [
    { key: 'questionbank', table: 'examhub_questionbank', name: 'Question banks', str: (r) => r.name, list: ['name', 'subject_id', 'created_by_id'], search: ['name'], filters: ['subject_id'] },
    { key: 'questiontag', table: 'examhub_questiontag', name: 'Question tags', str: (r) => r.name, list: ['name'], search: ['name'], filters: [] },
    { key: 'question', table: 'examhub_question', name: 'Questions', str: (r) => `[${r.question_type}] ${String(r.stem).replace(/<[^>]*>/g, '').slice(0, 80)}`, list: ['stem', 'bank_id', 'question_type', 'difficulty', 'topic', 'is_verified'], search: ['stem', 'topic', 'subtopic'], filters: ['question_type', 'difficulty', 'is_verified'] },
    { key: 'exam', table: 'examhub_exam', name: 'Exams', str: (r) => r.title, list: ['title', 'subject_id', 'bundle_id', 'mode', 'is_published', 'is_self_study', 'created_at'], search: ['title'], filters: ['mode', 'is_published', 'is_self_study', 'subject_id', 'bundle_id'] },
    { key: 'examsection', table: 'examhub_examsection', name: 'Exam sections', str: (r) => r.title, list: ['title', 'exam_id', 'subject_id', 'order'], search: ['title'], filters: ['subject_id'] },
    { key: 'examquestion', table: 'examhub_examquestion', name: 'Exam questions', str: (r) => `Q${r.order} (#${r.id})`, list: ['id', 'section_id', 'bank_question_id', 'points'], search: ['stem'], filters: [] },
    { key: 'examattempt', table: 'examhub_examattempt', name: 'Exam attempts', str: (r) => `Attempt #${r.id}`, list: ['student_id', 'exam_id', 'status', 'score_pct', 'passed', 'started_at'], search: [], filters: ['status', 'passed'] },
    { key: 'attemptanswer', table: 'examhub_attemptanswer', name: 'Attempt answers', str: (r) => `Answer #${r.id}`, list: ['attempt_id', 'exam_question_id', 'is_correct', 'auto_score', 'manual_score'], search: [], filters: ['is_correct', 'flagged'] },
  ] },
];
const MODELS = new Map(REGISTRY.flatMap((g) => g.models.map((m) => [m.key, { ...m, app: g.app }])));
const PAGE_SIZE = 100;

function adminAccess(req, res, next) {
  if (!req.user.is_authenticated) return res.redirect(302, `/accounts/login/?next=${encodeURIComponent(req.originalUrl)}`);
  if (!req.user.is_active || !req.user.is_staff) {
    res.status(403);
    return render(req, res, 'admin/denied.html', {}, 403);
  }
  return next();
}

const columnCache = new Map();
async function columns(table) {
  if (!columnCache.has(table)) {
    const rows = await db.all(`SHOW COLUMNS FROM \`${table}\``);
    columnCache.set(table, rows.map((c) => {
      const t = c.Type.toLowerCase();
      let kind = 'text';
      if (t.startsWith('tinyint(1)')) kind = 'bool';
      else if (/^(int|bigint)/.test(t)) kind = 'int';
      else if (t.startsWith('decimal')) kind = 'decimal';
      else if (t.startsWith('datetime')) kind = 'datetime';
      else if (t === 'date') kind = 'date';
      else if (t.startsWith('longtext')) kind = 'longtext';
      return { name: c.Field, kind, nullable: c.Null === 'YES', key: c.Key };
    }));
  }
  return columnCache.get(table);
}

function displayValue(v, kind) {
  if (v === null || v === undefined) return '—';
  if (kind === 'bool') return v ? '✔' : '✘';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const s = String(v);
  return s.length > 90 ? `${s.slice(0, 89)}…` : s;
}

function inputValue(v, kind) {
  if (v === null || v === undefined) return '';
  if (kind === 'datetime' && v instanceof Date) return v.toISOString().slice(0, 16);
  return String(v);
}

router.use(adminAccess);

router.get('/', async (req, res) => {
  const groups = [];
  for (const g of REGISTRY) {
    const models = [];
    for (const m of g.models) models.push({ ...m, count: Number(await db.value(`SELECT COUNT(*) FROM \`${m.table}\``)) });
    groups.push({ app: g.app, models });
  }
  return render(req, res, 'admin/index.html', { groups });
});

router.all('/:model/', async (req, res, next) => {
  const m = MODELS.get(req.params.model);
  if (!m) return next();
  const cols = await columns(m.table);
  const kinds = Object.fromEntries(cols.map((c) => [c.name, c.kind]));

  if (req.method === 'POST' && req.POST.get('action') === 'delete_selected') {
    const ids = req.POST.getlist('_selected').map(Number).filter(Number.isInteger);
    if (ids.length) {
      await db.run(`DELETE FROM \`${m.table}\` WHERE id IN (?)`, [ids]);
      messages.success(req, `Successfully deleted ${ids.length} ${m.name.toLowerCase()}.`);
    }
    return res.redirect(302, `/admin/${m.key}/`);
  }

  const where = [];
  const params = [];
  const q = req.GET.get('q', '');
  if (q && m.search.length) {
    where.push(`(${m.search.map((f) => `\`${f}\` LIKE ? ESCAPE '\\\\'`).join(' OR ')})`);
    for (let i = 0; i < m.search.length; i++) params.push(contains(q));
  }
  const activeFilters = {};
  for (const f of m.filters) {
    const v = req.GET.get(f);
    if (v !== undefined && v !== '') { where.push(`\`${f}\` = ?`); params.push(v); activeFilters[f] = v; }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(await db.value(`SELECT COUNT(*) FROM \`${m.table}\` ${whereSql}`, params));
  const page = Math.max(1, parseInt(req.GET.get('p', '1'), 10) || 1);
  const rows = await db.all(`SELECT * FROM \`${m.table}\` ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]);

  const filterOptions = [];
  for (const f of m.filters) {
    const vals = (await db.all(`SELECT DISTINCT \`${f}\` AS v FROM \`${m.table}\` WHERE \`${f}\` IS NOT NULL ORDER BY v LIMIT 50`)).map((r) => String(r.v));
    filterOptions.push({ field: f, values: vals, current: activeFilters[f] || '' });
  }

  return render(req, res, 'admin/list.html', {
    model: m, total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), q, filters: filterOptions,
    headers: m.list,
    rows: rows.map((r) => ({ id: r.id, cells: m.list.map((f) => displayValue(r[f], kinds[f])) })),
  });
});

async function changeForm(req, res, m, id) {
  const cols = (await columns(m.table)).filter((c) => c.name !== 'id');
  const row = id ? await db.one(`SELECT * FROM \`${m.table}\` WHERE id = ?`, [id]) : null;
  if (id && !row) throw new Http404();
  let errors = [];

  if (req.method === 'POST') {
    const data = {};
    for (const c of cols) {
      if (c.name === 'password' && m.key === 'user') continue;
      let v = req.POST.get(c.name);
      if (c.kind === 'bool') { data[c.name] = req.POST.has(c.name); continue; }
      if (v === undefined) continue;
      if (v === '' && c.nullable) { data[c.name] = null; continue; }
      if (c.kind === 'int') {
        if (v === '') { errors.push(`${c.name}: This field is required.`); continue; }
        if (!/^-?\d+$/.test(v)) { errors.push(`${c.name}: Enter a whole number.`); continue; }
        v = parseInt(v, 10);
      } else if (c.kind === 'decimal') {
        if (v === '' || Number.isNaN(Number(v))) { errors.push(`${c.name}: Enter a number.`); continue; }
        v = Number(v);
      } else if (c.kind === 'datetime') {
        const d = new Date(`${v}Z`);
        if (Number.isNaN(d.getTime())) { errors.push(`${c.name}: Enter a valid date/time.`); continue; }
        v = d;
      } else if (c.kind === 'longtext' && /^(feature_highlights|used_for_list|choices_data|blank_answers|keywords|match_left|match_right|correct_pairs|order_items|categories|category_items|question_order|selected_indices|answer_data|what_youll_learn|requirements)$/.test(c.name)) {
        if (v === '' && c.nullable) v = null;
        else { try { JSON.parse(v); } catch (_) { errors.push(`${c.name}: Enter valid JSON.`); continue; } }
      }
      data[c.name] = v;
    }
    const newPassword = m.key === 'user' ? req.POST.get('_new_password', '') : '';
    if (newPassword) data.password = await passwords.makePassword(newPassword);
    if (m.key === 'user' && !id && !newPassword) errors.push('password: A password is required for a new user.');

    if (!errors.length) {
      try {
        let savedId = id;
        if (SLUG_FALLBACKS[m.table] && 'slug' in data && !data.slug) {
          data.slug = await accounts.uniqueSlug(m.table, data.name, SLUG_FALLBACKS[m.table], id);
        }
        if ('updated_at' in data || cols.some((c) => c.name === 'updated_at')) data.updated_at = new Date();
        if (id) {
          await db.update(m.table, id, data);
        } else {
          const t = new Date();
          for (const c of cols) if (['created_at', 'date_joined', 'started_at', 'starts_at'].includes(c.name) && !data[c.name]) data[c.name] = t;
          savedId = await db.insert(m.table, data);
        }
        if (m.key === 'user') await accounts.ensureRegistrationNumber(savedId);
        messages.success(req, `The ${m.name.replace(/s$/, '').toLowerCase()} “${m.str({ ...(row || {}), ...data, id: savedId })}” was ${id ? 'changed' : 'added'} successfully.`);
        if (req.POST.has('_continue')) return res.redirect(302, `/admin/${m.key}/${savedId}/change/`);
        if (req.POST.has('_addanother')) return res.redirect(302, `/admin/${m.key}/add/`);
        return res.redirect(302, `/admin/${m.key}/`);
      } catch (err) {
        errors = [err.sqlMessage || err.message];
      }
    }
  }

  const source = req.method === 'POST' ? req.POST.toObject() : (row || {});
  const fields = cols.map((c) => ({
    ...c,
    readonly: c.name === 'password' && m.key === 'user',
    value: c.kind === 'bool'
      ? (req.method === 'POST' ? req.POST.has(c.name) : Boolean(row ? row[c.name] : (c.name === 'is_active')))
      : (req.method === 'POST' ? (source[c.name] ?? '') : inputValue(row ? row[c.name] : '', c.kind)),
  }));
  return render(req, res, 'admin/change.html', {
    model: m, id, title: row ? m.str(row) : `Add ${m.name.replace(/s$/, '').toLowerCase()}`, fields, errors,
    is_user: m.key === 'user', role_choices: User.ROLE_CHOICES,
  });
}

router.all('/:model/add/', async (req, res, next) => {
  const m = MODELS.get(req.params.model);
  if (!m) return next();
  return changeForm(req, res, m, null);
});

router.all('/:model/:id/change/', async (req, res, next) => {
  const m = MODELS.get(req.params.model);
  if (!m || !/^\d+$/.test(req.params.id)) return next();
  return changeForm(req, res, m, parseInt(req.params.id, 10));
});

router.all('/:model/:id/delete/', async (req, res, next) => {
  const m = MODELS.get(req.params.model);
  if (!m || !/^\d+$/.test(req.params.id)) return next();
  const row = await db.one(`SELECT * FROM \`${m.table}\` WHERE id = ?`, [req.params.id]);
  if (!row) throw new Http404();
  if (req.method === 'POST') {
    await db.remove(m.table, row.id);
    messages.success(req, `The ${m.name.replace(/s$/, '').toLowerCase()} “${m.str(row)}” was deleted successfully.`);
    return res.redirect(302, `/admin/${m.key}/`);
  }
  return render(req, res, 'admin/delete.html', { model: m, id: row.id, title: m.str(row) });
});

module.exports = { router };
