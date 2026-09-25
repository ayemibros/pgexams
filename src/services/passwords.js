/**
 * Password hashing + validation, compatible with Django's.
 *
 * Hashes use Django's default PBKDF2-SHA256 format
 * (`pbkdf2_sha256$<iterations>$<salt>$<base64 hash>`), so accounts copied
 * over from the Django database keep working, and vice versa.
 *
 * validatePassword() reproduces the four AUTH_PASSWORD_VALIDATORS configured
 * in the Django settings: UserAttributeSimilarity, MinimumLength(8),
 * CommonPassword (Django's own 20k list) and Numeric — same messages.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ALGORITHM = 'pbkdf2_sha256';
const ITERATIONS = 870000; // Django 5.1 default
const SALT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomString(length, alphabet = SALT_CHARS) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function pbkdf2(password, salt, iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(String(password), salt, iterations, 32, 'sha256', (err, key) => (err ? reject(err) : resolve(key.toString('base64'))));
  });
}

async function makePassword(password) {
  const salt = randomString(22);
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `${ALGORITHM}$${ITERATIONS}$${salt}$${hash}`;
}

async function checkPassword(password, encoded) {
  if (!encoded || typeof encoded !== 'string' || encoded.startsWith('!')) return false;
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return false;
  const [, iterStr, salt, expected] = parts;
  const iterations = parseInt(iterStr, 10);
  if (!iterations) return false;
  const actual = await pbkdf2(password, salt, iterations);
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Readable temporary password for admin-provisioned accounts (no 0/O, 1/l). */
function generatePassword(length = 10) {
  return randomString(length, 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789');
}

// ─────────────────────────────────────────────── validation ──

let commonPasswords = null;
function getCommonPasswords() {
  if (!commonPasswords) {
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'data', 'common-passwords.txt.gz'))).toString('utf8');
    commonPasswords = new Set(raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
  }
  return commonPasswords;
}

/** Python's difflib.SequenceMatcher(a, b).quick_ratio(). */
function quickRatio(a, b) {
  const counts = new Map();
  for (const ch of b) counts.set(ch, (counts.get(ch) || 0) + 1);
  let matches = 0;
  for (const ch of a) {
    const n = counts.get(ch) || 0;
    if (n > 0) { matches++; counts.set(ch, n - 1); }
  }
  const total = a.length + b.length;
  return total ? (2 * matches) / total : 1;
}

function exceedsMaximumLengthRatio(password, maxSimilarity, value) {
  const pwdLen = password.length;
  const lengthBoundSimilarity = (maxSimilarity / 2) * pwdLen;
  return pwdLen >= 10 * value.length && value.length < lengthBoundSimilarity;
}

const USER_ATTRIBUTES = [
  ['username', 'username'],
  ['first_name', 'first name'],
  ['last_name', 'last name'],
  ['email', 'email address'],
];

/** Returns a list of error messages (empty when the password is acceptable). */
function validatePassword(password, user = null) {
  const errors = [];
  const pwd = String(password || '');

  if (user) {
    const lower = pwd.toLowerCase();
    outer: for (const [attr, verbose] of USER_ATTRIBUTES) {
      const value = user[attr];
      if (!value || typeof value !== 'string') continue;
      const valueLower = value.toLowerCase();
      const parts = [...valueLower.split(/[^\p{L}\p{N}_]+/u), valueLower];
      for (const part of parts) {
        if (exceedsMaximumLengthRatio(lower, 0.7, part)) continue;
        if (quickRatio(lower, part) >= 0.7) {
          errors.push(`The password is too similar to the ${verbose}.`);
          break outer;
        }
      }
    }
  }

  if (pwd.length < 8) errors.push('This password is too short. It must contain at least 8 characters.');
  if (getCommonPasswords().has(pwd.toLowerCase().trim())) errors.push('This password is too common.');
  if (/^\d+$/.test(pwd)) errors.push('This password is entirely numeric.');
  return errors;
}

const PASSWORD_HELP_TEXTS = [
  'Your password can’t be too similar to your other personal information.',
  'Your password must contain at least 8 characters.',
  'Your password can’t be a commonly used password.',
  'Your password can’t be entirely numeric.',
];

module.exports = {
  makePassword, checkPassword, generatePassword, validatePassword, randomString, PASSWORD_HELP_TEXTS,
};
