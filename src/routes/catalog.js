/** Port of catalog/views.py — faculties, subjects, departments and programmes (Admin only). */
const express = require('express');
const db = require('../db');
const { Subject, Faculty, Department, Bundle } = require('../models');
const { route, render, redirect, messages, getOr404 } = require('../web');
const { uniqueSlug } = require('../services/accounts');
const { attachDepartments } = require('../services/billing');
const { strip, intOrNull } = require('../services/util');

const router = express.Router();
const isAdmin = (req) => req.user.is_authenticated && req.user.is_admin;

function denied(req, res) {
  messages.error(req, 'Access denied.');
  return redirect(res, '/');
}

/** int(order) with a 0 fallback, like the Django views' try/except ValueError. */
function orderValue(raw) {
  const s = String(raw || '0') || '0';
  return /^[-+]?\d+$/.test(s.trim()) ? Math.max(0, parseInt(s, 10)) : 0;
}

/** Name must be unique — turn the DB's duplicate-key error into a form message instead of a 500. */
async function saveUnique(req, fn, what) {
  try {
    await fn();
    return true;
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    messages.error(req, `A ${what} with that name already exists.`);
    return false;
  }
}

// ─────────────────────────────────────────── FACULTIES ──

route(router, 'catalog:faculty_list', async (req, res) => {
  if (!isAdmin(req)) return denied(req, res);
  const faculties = Faculty.hydrateAll(await db.all(
    `SELECT f.*, (SELECT COUNT(*) FROM catalog_department d WHERE d.faculty_id = f.id) AS department_count
     FROM catalog_faculty f ORDER BY f.\`order\`, f.name`,
  ));
  return render(req, res, 'catalog/staff/faculty_list.html', { active: 'faculties', faculties });
}, { login: true });

async function facultyForm(req, res, { pk = null } = {}) {
  if (!isAdmin(req)) return denied(req, res);
  const faculty = pk ? await getOr404(db.one('SELECT * FROM catalog_faculty WHERE id = ?', [pk]).then((r) => Faculty.hydrate(r))) : null;

  if (req.method === 'POST') {
    const name = strip(req.POST.get('name', ''));
    if (!name) {
      messages.error(req, 'Faculty name is required.');
    } else {
      const data = {
        name, icon: strip(req.POST.get('icon', '')) || '🎓', order: orderValue(req.POST.get('order', '0')),
        is_active: req.POST.has('is_active'),
      };
      const ok = await saveUnique(req, async () => {
        if (faculty) await db.update('catalog_faculty', faculty.id, data);
        else await db.insert('catalog_faculty', { ...data, slug: await uniqueSlug('catalog_faculty', name, 'faculty') });
      }, 'faculty');
      if (ok) {
        messages.success(req, 'Faculty saved.');
        return redirect(res, 'catalog:faculty_list');
      }
    }
  }
  return render(req, res, 'catalog/staff/faculty_form.html', { active: 'faculties', faculty });
}
route(router, 'catalog:faculty_add', (req, res) => facultyForm(req, res), { login: true });
route(router, 'catalog:faculty_edit', (req, res, p) => facultyForm(req, res, p), { login: true });

route(router, 'catalog:faculty_delete', async (req, res, { pk }) => {
  if (!isAdmin(req)) return redirect(res, '/');
  const faculty = await getOr404(db.one('SELECT * FROM catalog_faculty WHERE id = ?', [pk]));
  await db.remove('catalog_faculty', faculty.id);
  messages.success(req, `Faculty "${faculty.name}" deleted.`);
  return redirect(res, 'catalog:faculty_list');
}, { login: true, post: true });

// ─────────────────────────────────────────── SUBJECTS ──

route(router, 'catalog:subject_list', async (req, res) => {
  if (!isAdmin(req)) return denied(req, res);
  const subjects = Subject.hydrateAll(await db.all('SELECT * FROM catalog_subject ORDER BY name'));
  return render(req, res, 'catalog/staff/subject_list.html', { active: 'subjects', subjects });
}, { login: true });

async function subjectForm(req, res, { pk = null } = {}) {
  if (!isAdmin(req)) return denied(req, res);
  const subject = pk ? await getOr404(db.one('SELECT * FROM catalog_subject WHERE id = ?', [pk]).then((r) => Subject.hydrate(r))) : null;

  if (req.method === 'POST') {
    const name = strip(req.POST.get('name', ''));
    if (!name) {
      messages.error(req, 'Subject name is required.');
    } else {
      const data = { name, icon: strip(req.POST.get('icon', '')) || '📚', is_active: req.POST.has('is_active') };
      const ok = await saveUnique(req, async () => {
        if (subject) await db.update('catalog_subject', subject.id, data);
        else await db.insert('catalog_subject', data);
      }, 'subject');
      if (ok) {
        messages.success(req, 'Subject saved.');
        return redirect(res, 'catalog:subject_list');
      }
    }
  }
  return render(req, res, 'catalog/staff/subject_form.html', { active: 'subjects', subject });
}
route(router, 'catalog:subject_add', (req, res) => subjectForm(req, res), { login: true });
route(router, 'catalog:subject_edit', (req, res, p) => subjectForm(req, res, p), { login: true });

route(router, 'catalog:subject_delete', async (req, res, { pk }) => {
  if (!isAdmin(req)) return redirect(res, '/');
  const subject = await getOr404(db.one('SELECT * FROM catalog_subject WHERE id = ?', [pk]));
  await db.remove('catalog_subject', subject.id);
  messages.success(req, `Subject "${subject.name}" deleted.`);
  return redirect(res, 'catalog:subject_list');
}, { login: true, post: true });

// ─────────────────────────────────────────── DEPARTMENTS ──

route(router, 'catalog:department_list', async (req, res) => {
  if (!isAdmin(req)) return denied(req, res);
  const departments = Department.hydrateAll(await db.all(
    `SELECT d.*, (SELECT COUNT(*) FROM catalog_bundle b WHERE b.department_id = d.id) AS program_count
     FROM catalog_department d ORDER BY d.\`order\`, d.name`,
  ));
  const facs = new Map(Faculty.hydrateAll(await db.all('SELECT * FROM catalog_faculty')).map((f) => [f.id, f]));
  for (const d of departments) d.faculty = facs.get(d.faculty_id) || null;
  return render(req, res, 'catalog/staff/department_list.html', { active: 'departments', departments });
}, { login: true });

async function departmentForm(req, res, { pk = null } = {}) {
  if (!isAdmin(req)) return denied(req, res);
  const department = pk ? await getOr404(db.one('SELECT * FROM catalog_department WHERE id = ?', [pk]).then((r) => Department.hydrate(r))) : null;
  const faculties = Faculty.hydrateAll(await db.all('SELECT * FROM catalog_faculty ORDER BY `order`, name'));

  if (req.method === 'POST') {
    const name = strip(req.POST.get('name', ''));
    if (!name) {
      messages.error(req, 'Department name is required.');
    } else {
      const data = {
        name, icon: strip(req.POST.get('icon', '')) || '🏛️', description: strip(req.POST.get('description', '')),
        faculty_id: intOrNull(req.POST.get('faculty') || null), order: orderValue(req.POST.get('order', '0')),
        is_active: req.POST.has('is_active'),
      };
      const ok = await saveUnique(req, async () => {
        if (department) await db.update('catalog_department', department.id, data);
        else await db.insert('catalog_department', { ...data, slug: await uniqueSlug('catalog_department', name, 'department') });
      }, 'department');
      if (ok) {
        messages.success(req, 'Department saved.');
        return redirect(res, 'catalog:department_list');
      }
    }
  }
  return render(req, res, 'catalog/staff/department_form.html', { active: 'departments', department, faculties });
}
route(router, 'catalog:department_add', (req, res) => departmentForm(req, res), { login: true });
route(router, 'catalog:department_edit', (req, res, p) => departmentForm(req, res, p), { login: true });

route(router, 'catalog:department_delete', async (req, res, { pk }) => {
  if (!isAdmin(req)) return redirect(res, '/');
  const department = await getOr404(db.one('SELECT * FROM catalog_department WHERE id = ?', [pk]));
  await db.remove('catalog_department', department.id);
  messages.success(req, `Department "${department.name}" deleted.`);
  return redirect(res, 'catalog:department_list');
}, { login: true, post: true });

// ─────────────────────────────────────────── PROGRAMS (Bundles) ──

route(router, 'catalog:program_list', async (req, res) => {
  if (!isAdmin(req)) return denied(req, res);
  const programs = await attachDepartments(Bundle.hydrateAll(await db.all('SELECT * FROM catalog_bundle ORDER BY name')));
  const links = await db.all(
    'SELECT bs.bundle_id, s.* FROM catalog_bundle_subjects bs JOIN catalog_subject s ON s.id = bs.subject_id ORDER BY s.name',
  );
  for (const p of programs) p.subjects = Subject.hydrateAll(links.filter((l) => l.bundle_id === p.id));
  return render(req, res, 'catalog/staff/program_list.html', { active: 'programs', programs });
}, { login: true });

async function programForm(req, res, { pk = null } = {}) {
  if (!isAdmin(req)) return denied(req, res);
  const program = pk ? await getOr404(db.one('SELECT * FROM catalog_bundle WHERE id = ?', [pk]).then((r) => Bundle.hydrate(r))) : null;
  const departments = Department.hydrateAll(await db.all('SELECT * FROM catalog_department ORDER BY `order`, name'));
  const subjects = Subject.hydrateAll(await db.all('SELECT * FROM catalog_subject ORDER BY name'));

  if (req.method === 'POST') {
    const name = strip(req.POST.get('name', ''));
    if (!name) {
      messages.error(req, 'Program name is required.');
    } else {
      const data = {
        name, icon: strip(req.POST.get('icon', '')) || '🎯', description: strip(req.POST.get('description', '')),
        department_id: intOrNull(req.POST.get('department') || null), level: req.POST.get('level', 'post_utme'),
        order: orderValue(req.POST.get('order', '0')), is_active: req.POST.has('is_active'),
      };
      const subjectIds = req.POST.getlist('subjects[]').map(intOrNull).filter((x) => x !== null);
      await db.transaction(async (tx) => {
        let id = program ? program.id : null;
        if (id) await tx.update('catalog_bundle', id, data);
        else id = await tx.insert('catalog_bundle', { ...data, slug: await uniqueSlug('catalog_bundle', name, 'bundle', null, tx) });
        await tx.run('DELETE FROM catalog_bundle_subjects WHERE bundle_id = ?', [id]);
        const valid = subjectIds.length ? (await tx.all('SELECT id FROM catalog_subject WHERE id IN (?)', [subjectIds])).map((r) => r.id) : [];
        if (valid.length) await tx.insertMany('catalog_bundle_subjects', valid.map((subject_id) => ({ bundle_id: id, subject_id })));
      });
      messages.success(req, 'Program saved.');
      return redirect(res, 'catalog:program_list');
    }
  }

  const selected = program ? (await db.all('SELECT subject_id FROM catalog_bundle_subjects WHERE bundle_id = ?', [program.id])).map((r) => r.subject_id) : [];
  return render(req, res, 'catalog/staff/program_form.html', {
    active: 'programs', program, departments, subjects, level_choices: Bundle.LEVEL_CHOICES, selected_subject_ids: selected,
  });
}
route(router, 'catalog:program_add', (req, res) => programForm(req, res), { login: true });
route(router, 'catalog:program_edit', (req, res, p) => programForm(req, res, p), { login: true });

route(router, 'catalog:program_delete', async (req, res, { pk }) => {
  if (!isAdmin(req)) return redirect(res, '/');
  const program = await getOr404(db.one('SELECT * FROM catalog_bundle WHERE id = ?', [pk]));
  await db.remove('catalog_bundle', program.id);
  messages.success(req, `Program "${program.name}" deleted.`);
  return redirect(res, 'catalog:program_list');
}, { login: true, post: true });

module.exports = { router };
