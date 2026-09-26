/**
 * E-Resources: study guides (PDF) for applicants. The files live in /resources
 * (not /static), so they are only served through here, after an access check:
 * staff see everything; students need an active subscription, except for the
 * guides marked free.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { route, render, Http404, reverse } = require('../web');
const { AccessProfile } = require('../services/billing');

const router = express.Router();
const DIR = path.join(__dirname, '..', '..', 'resources');
const FREE = new Set(['ept-guide']);

function catalogue() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, 'catalogue.json'), 'utf8')).map((r) => ({ ...r, free: FREE.has(r.slug) }));
  } catch (err) {
    return [];
  }
}

async function canOpen(user, resource) {
  if (user.can_manage_exams || resource.free) return true;
  return (await AccessProfile.load(user)).has_any;
}

route(router, 'resources:list', async (req, res) => {
  const { user } = req;
  const hasAccess = user.can_manage_exams || (await AccessProfile.load(user)).has_any;
  const items = catalogue().map((r) => ({ ...r, unlocked: hasAccess || r.free }));
  return render(req, res, 'resources/list.html', {
    active: 'resources', items, has_access: hasAccess,
    shell_template: user.can_manage_exams ? 'layout/staff_shell.html' : 'layout/student_shell.html',
  });
}, { login: true });

route(router, 'resources:file', async (req, res, { slug }) => {
  const resource = catalogue().find((r) => r.slug === slug);
  if (!resource) throw new Http404();
  if (!await canOpen(req.user, resource)) return res.redirect(302, reverse('resources:list'));
  const file = path.join(DIR, path.basename(resource.file));
  if (!fs.existsSync(file)) throw new Http404();
  const disposition = req.query.download === '1' ? 'attachment' : 'inline';
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `${disposition}; filename="${resource.file}"`);
  res.set('Cache-Control', 'private, max-age=3600');
  return res.sendFile(file);
}, { login: true });

module.exports = { router };
