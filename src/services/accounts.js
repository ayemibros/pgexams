/**
 * Account/site helpers — ports of User.save() (registration numbers),
 * accounts/utils.py (unique_username), the catalog models' slug-generating
 * save() overrides, and SiteSettings.get_solo().
 */
const crypto = require('crypto');
const db = require('../db');
const { User, SiteSettings } = require('../models');
const passwords = require('./passwords');

/** Django's django.utils.text.slugify (allow_unicode=False). */
function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}

/** Unique slug in `table` for `name`, falling back to `fallback` — the catalog save() logic. */
async function uniqueSlug(table, name, fallback, pk = null, tx = db) {
  const base = slugify(name) || fallback;
  let slug = base;
  let i = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await tx.value(`SELECT COUNT(*) FROM \`${table}\` WHERE slug = ? AND id <> ?`, [slug, pk || 0])) {
    i += 1;
    slug = `${base}-${i}`;
  }
  return slug;
}

function generateRegistrationNumber() {
  let digits = '';
  for (let i = 0; i < 8; i++) digits += String(crypto.randomInt(10));
  return `STU-${digits}`;
}

async function uniqueRegistrationNumber(tx = db) {
  let reg = generateRegistrationNumber();
  // eslint-disable-next-line no-await-in-loop
  while (await tx.value('SELECT COUNT(*) FROM accounts_user WHERE registration_number = ?', [reg])) reg = generateRegistrationNumber();
  return reg;
}

async function uniqueUsername(first, last, tx = db) {
  let base = `${first}.${last}`.replace(/^\.+|\.+$/g, '').toLowerCase().replace(/ /g, '');
  base = [...base].filter((c) => /[\p{L}\p{N}]/u.test(c) || c === '.').join('') || 'user';
  let username = base;
  let i = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await tx.value('SELECT COUNT(*) FROM accounts_user WHERE username = ?', [username])) {
    i += 1;
    username = `${base}${i}`;
  }
  return username;
}

/** User(...) + set_password() + save(): a student with no registration number gets one. */
async function createUser(fields, rawPassword = null, tx = db) {
  const t = new Date();
  const data = {
    password: rawPassword === null ? `!${passwords.randomString(40)}` : await passwords.makePassword(rawPassword),
    last_login: null, is_superuser: false, first_name: '', last_name: '', email: '', is_staff: false,
    is_active: true, date_joined: t, role: 'student', registration_number: '', phone: '', avatar: null,
    date_of_birth: null, must_change_password: false, created_by_id: null, created_at: t,
    ...fields,
  };
  if (data.role === 'student' && !data.registration_number) data.registration_number = await uniqueRegistrationNumber(tx);
  const id = await tx.insert('accounts_user', data);
  return User.hydrate(await tx.one('SELECT * FROM accounts_user WHERE id = ?', [id]));
}

/** Mirrors User.save(): (re)assigns a registration number if a student has none. */
async function ensureRegistrationNumber(userId, tx = db) {
  const row = await tx.one('SELECT role, registration_number FROM accounts_user WHERE id = ?', [userId]);
  if (row && row.role === 'student' && !row.registration_number) {
    await tx.run('UPDATE accounts_user SET registration_number = ? WHERE id = ?', [await uniqueRegistrationNumber(tx), userId]);
  }
}

async function loadUser(id, tx = db) {
  return User.hydrate(await tx.one('SELECT * FROM accounts_user WHERE id = ?', [id]));
}

/** SiteSettings.get_solo(): the singleton row (pk=1), created with model defaults if missing. */
async function getSiteSettings(tx = db) {
  let row = await tx.one('SELECT * FROM branding_sitesettings WHERE id = 1');
  if (!row) {
    await tx.run('INSERT IGNORE INTO branding_sitesettings (id, updated_at) VALUES (1, ?)', [new Date()]);
    row = await tx.one('SELECT * FROM branding_sitesettings WHERE id = 1');
  }
  return SiteSettings.hydrate(row);
}

module.exports = {
  slugify, uniqueSlug, uniqueUsername, createUser, ensureRegistrationNumber, loadUser, getSiteSettings,
  uniqueRegistrationNumber,
};
