/** Port of accounts/views.py, accounts/admin_views.py and accounts/backends.py. */
const express = require('express');
const db = require('../db');
const { User } = require('../models');
const {
  route, render, redirect, messages, getOr404, loginUser, logoutUser, updateSessionAuthHash, safeNext, safe, reverse,
} = require('../web');
const { escapeHtml } = require('../templating');
const accounts = require('../services/accounts');
const passwords = require('../services/passwords');
const { saveUpload } = require('../forms');
const { contains, strip } = require('../services/util');

const router = express.Router();

// ─────────────────────────────────────────── AUTH ──

/**
 * EmailOrUsernameBackend: log in with an email address *or* a username,
 * case-insensitively. An email shared by several accounts is ambiguous and
 * refused (those people log in with their username instead).
 */
async function authenticate(username, password) {
  const ident = String(username || '').trim();
  if (!ident || password === undefined || password === null) return null;
  const matches = User.hydrateAll(await db.all(
    'SELECT * FROM accounts_user WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?) LIMIT 3', [ident, ident],
  ));
  const exact = matches.filter((u) => u.username.toLowerCase() === ident.toLowerCase());
  const user = exact.length ? exact[0] : (matches.length === 1 ? matches[0] : null);
  if (!user) {
    await passwords.makePassword(password); // same timing as a wrong password
    return null;
  }
  if (await passwords.checkPassword(password, user.password) && user.is_active) return user;
  return null;
}

route(router, 'accounts:login', async (req, res) => {
  let formErrors = null;
  if (req.method === 'POST') {
    const user = await authenticate(req.POST.get('username', ''), req.POST.get('password', ''));
    if (user) {
      await loginUser(req, user);
      return res.redirect(302, safeNext(req.POST.get('next')) || safeNext(req.GET.get('next')) || reverse('accounts:post_login_redirect'));
    }
    formErrors = ['Please enter a correct username and password. Note that both fields may be case-sensitive.'];
  }
  return render(req, res, 'registration/login.html', {
    form: { errors: formErrors }, next: req.POST.get('next') || req.GET.get('next', ''),
  });
});

route(router, 'accounts:logout', async (req, res) => {
  await logoutUser(req);
  return redirect(res, 'accounts:login');
}, { post: true });

route(router, 'accounts:post_login_redirect', async (req, res) => {
  const { user } = req;
  if (user.must_change_password) return redirect(res, 'accounts:change_password');
  if (user.can_manage_exams) return redirect(res, 'examhub:staff_dashboard');
  return redirect(res, 'examhub:student_dashboard');
}, { login: true });

/** `next`, but only when it points back at the subscribe page — where account creation starts. */
function subscribeNext(req) {
  const nxt = safeNext(req.POST.get('next') || req.GET.get('next') || '');
  if (!nxt) return '';
  const path = nxt.split('?')[0].split('#')[0];
  return path === reverse('billing:plans_browse') ? nxt : '';
}

const EMAIL_RE = /^[^\s@"(),:;<>[\\\]]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/**
 * Self-registration: free, from the home page ("Try free"), or from the
 * subscribe page on the way to paying. Full name, email, password — the
 * email doubles as the username. New applicants land on the free trial
 * unless they came from the subscribe page.
 */
route(router, 'accounts:register', async (req, res) => {
  if (req.user.is_authenticated) return res.redirect(302, safeNext(req.POST.get('next') || req.GET.get('next')) || reverse('accounts:post_login_redirect'));

  if (req.method === 'POST') {
    const fullName = String(req.POST.get('full_name', '')).split(/\s+/).filter(Boolean).join(' ');
    const email = strip(req.POST.get('email', '')).toLowerCase();
    const password = req.POST.get('password', '');
    const passwordConfirm = req.POST.get('password_confirm', '');
    const spaceAt = fullName.indexOf(' ');
    const firstName = spaceAt < 0 ? fullName : fullName.slice(0, spaceAt);
    const lastName = spaceAt < 0 ? '' : fullName.slice(spaceAt + 1);

    const errors = [];
    if (spaceAt < 0) errors.push('Please enter your full name (first and last name).');
    else if (firstName.length > 150 || lastName.length > 150) errors.push('That name is too long.');

    if (!EMAIL_RE.test(email) || email.length > 254) {
      errors.push('Please enter a valid email address.');
    } else if (email.length > 150) {
      errors.push('That email address is too long.');
    } else if (await db.value('SELECT COUNT(*) FROM accounts_user WHERE LOWER(email) = ? OR LOWER(username) = ?', [email, email])) {
      errors.push('An account with this email already exists. Please log in instead.');
    }

    if (password !== passwordConfirm) errors.push('Passwords do not match.');
    else errors.push(...passwords.validatePassword(password, { username: email, email, first_name: firstName, last_name: lastName }));

    if (!errors.length) {
      const user = await accounts.createUser({
        username: email, email, first_name: firstName, last_name: lastName, role: 'student', must_change_password: false,
      }, password);
      await loginUser(req, user);
      messages.success(req, `Welcome, ${user.first_name}! Your account is ready.`);
      return res.redirect(302, safeNext(req.POST.get('next') || req.GET.get('next')) || reverse('examhub:free_trial'));
    }
    for (const e of errors) messages.error(req, e);
  }

  return render(req, res, 'registration/register.html', {
    form_data: req.method === 'POST' ? req.POST.toObject() : {},
    next: safeNext(req.POST.get('next') || req.GET.get('next') || '') || '',
    from_subscribe: Boolean(subscribeNext(req)),
  });
});

function passwordField(name, label, errors, helpHtml = '') {
  return {
    label,
    errors: errors.join(''),
    widget: safe(`<input type="password" name="${name}" autocomplete="new-password" required id="id_${name}">${helpHtml}`),
  };
}

route(router, 'accounts:change_password', async (req, res) => {
  const { user } = req;
  const errors1 = [];
  const errors2 = [];
  if (req.method === 'POST') {
    const p1 = req.POST.get('new_password1', '');
    const p2 = req.POST.get('new_password2', '');
    if (!p1) errors1.push('This field is required.');
    if (!p2) errors2.push('This field is required.');
    if (p1 && p2 && p1 !== p2) errors2.push('The two password fields didn’t match.');
    if (p1 && p2 && p1 === p2) errors2.push(...passwords.validatePassword(p2, user));
    if (!errors1.length && !errors2.length) {
      const hash = await passwords.makePassword(p1);
      await db.run('UPDATE accounts_user SET password = ?, must_change_password = 0 WHERE id = ?', [hash, user.id]);
      updateSessionAuthHash(req, hash);
      messages.success(req, 'Password updated.');
      return redirect(res, 'accounts:post_login_redirect');
    }
  }
  const help = `<div class="form-hint"><ul>${passwords.PASSWORD_HELP_TEXTS.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></div>`;
  return render(req, res, 'registration/change_password.html', {
    form: [passwordField('new_password1', 'New password', errors1, help), passwordField('new_password2', 'New password confirmation', errors2)],
  });
}, { login: true });

route(router, 'accounts:my_profile', async (req, res) => {
  const { user } = req;
  if (req.method === 'POST') {
    const data = {};
    const avatar = req.FILES.get('avatar');
    if (avatar) {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(avatar.mimetype)) {
        messages.error(req, 'Please upload a JPEG, PNG, WebP or GIF image.');
      } else if (avatar.size > 4 * 1024 * 1024) {
        messages.error(req, 'Image is too large (max 4 MB).');
      } else {
        data.avatar = await saveUpload(avatar, 'avatars/%Y/%m/');
      }
    }
    data.phone = strip(req.POST.get('phone', ''));
    const dob = req.POST.get('date_of_birth') || null;
    if (dob) data.date_of_birth = /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : null;
    await db.update('accounts_user', user.id, data);
    await accounts.ensureRegistrationNumber(user.id);
    messages.success(req, 'Profile updated.');
    return redirect(res, 'accounts:my_profile');
  }
  return render(req, res, 'accounts/my_profile.html', {
    active: 'profile', person: user, shell_template: user.can_manage_exams ? 'layout/staff_shell.html' : 'layout/student_shell.html',
  });
}, { login: true });

// ─────────────────────────────────────────── STAFF / ADMIN ACCOUNT MANAGEMENT ──

// Higher number = more senior: an Admin can't disable a peer/senior account.
const ROLE_RANK = { student: 0, staff: 1, admin: 2, super_admin: 3 };
const CREATABLE_ROLES = { staff: 'Staff / Lecturer', admin: 'Admin' };

const isAdmin = (req) => req.user.is_authenticated && req.user.is_admin;

function denied(req, res) {
  messages.error(req, 'Access denied.');
  return redirect(res, '/');
}

route(router, 'accounts:account_list', async (req, res) => {
  if (!isAdmin(req)) return denied(req, res);
  const visibleRoles = ['staff', 'student'];
  if (req.user.is_super_admin) visibleRoles.push('admin');

  const where = ['role IN (?)'];
  const params = [visibleRoles];
  const roleFilter = req.GET.get('role', '');
  const search = strip(req.GET.get('q', ''));
  if (visibleRoles.includes(roleFilter)) { where.push('role = ?'); params.push(roleFilter); }
  if (search) {
    where.push("(username LIKE ? ESCAPE '\\\\' OR first_name LIKE ? ESCAPE '\\\\' OR last_name LIKE ? ESCAPE '\\\\' OR email LIKE ? ESCAPE '\\\\')");
    const s = contains(search);
    params.push(s, s, s, s);
  }
  const rows = await db.all(`SELECT * FROM accounts_user WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, params);
  const labels = Object.fromEntries(User.ROLE_CHOICES);
  return render(req, res, 'accounts/staff/account_list.html', {
    active: 'accounts', accounts: User.hydrateAll(rows),
    role_choices: visibleRoles.map((r) => [r, labels[r]]), filters: { role: roleFilter, q: search },
  });
}, { login: true });

route(router, 'accounts:account_create', async (req, res, { role }) => {
  if (!isAdmin(req)) return denied(req, res);
  if (!(role in CREATABLE_ROLES)) {
    messages.error(req, 'Unknown role.');
    return redirect(res, 'accounts:account_list');
  }
  if (role === 'admin' && !req.user.is_super_admin) {
    messages.error(req, 'Only a Super Admin can create Admin accounts.');
    return redirect(res, 'accounts:account_list');
  }

  let createdUser = null;
  let createdPassword = null;
  if (req.method === 'POST') {
    const firstName = strip(req.POST.get('first_name', ''));
    const lastName = strip(req.POST.get('last_name', ''));
    const email = strip(req.POST.get('email', ''));
    if (!firstName || !lastName) {
      messages.error(req, 'First and last name are required.');
    } else {
      const password = passwords.generatePassword();
      createdUser = await db.transaction(async (tx) => accounts.createUser({
        username: await accounts.uniqueUsername(firstName, lastName, tx), first_name: firstName, last_name: lastName,
        email, role, must_change_password: true, created_by_id: req.user.id,
      }, password, tx));
      createdPassword = password;
    }
  }

  return render(req, res, 'accounts/staff/account_form.html', {
    active: 'accounts', role, role_label: CREATABLE_ROLES[role], created_user: createdUser, created_password: createdPassword,
  });
}, { login: true });

route(router, 'accounts:account_toggle_active', async (req, res, { pk }) => {
  if (!isAdmin(req)) return redirect(res, '/');
  const target = await getOr404(accounts.loadUser(pk));
  if (target.id === req.user.id) {
    messages.error(req, "You can't disable your own account.");
    return redirect(res, 'accounts:account_list');
  }
  if ((ROLE_RANK[target.role] || 0) >= (ROLE_RANK[req.user.role] || 0)) {
    messages.error(req, "You don't have permission to change that account.");
    return redirect(res, 'accounts:account_list');
  }
  const isActive = !target.is_active;
  await db.update('accounts_user', target.id, { is_active: isActive });
  messages.success(req, `${target.get_full_name || target.username} is now ${isActive ? 'active' : 'disabled'}.`);
  return redirect(res, 'accounts:account_list');
}, { login: true, post: true });

module.exports = { router, authenticate };
