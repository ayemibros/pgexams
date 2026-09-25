/**
 * Request plumbing shared by every route — the Node equivalents of Django's
 * session/auth/CSRF/messages middleware, login_required, require_POST,
 * render(), redirect(), get_object_or_404 and the two context processors
 * (branding.site_branding and examhub.live_notifications).
 */
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const { env, safe, escapeHtml } = require('./templating');
const { URLS, INT_PARAMS, SLUG_PARAMS, expressPath, reverse } = require('./urls');
const accounts = require('./services/accounts');

// ───────────────────────────────────────────── errors ──

class Http404 extends Error { constructor(msg = 'Not Found') { super(msg); this.status = 404; } }
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function getOr404(promise) {
  const obj = await promise;
  if (!obj) throw new Http404();
  return obj;
}

// ───────────────────────────────────────────── messages ──

const LEVEL_TAGS = { debug: 'debug', info: 'info', success: 'success', warning: 'warning', error: 'error' };

class Message {
  constructor(level, message) { this.level = level; this.message = message; this.tags = LEVEL_TAGS[level] || level; }
  toString() { return this.message; }
}

const messages = {
  add(req, level, text) {
    if (!req.session) return;
    req.session.messages = req.session.messages || [];
    req.session.messages.push({ level, text: String(text) });
  },
  success(req, text) { messages.add(req, 'success', text); },
  error(req, text) { messages.add(req, 'error', text); },
  warning(req, text) { messages.add(req, 'warning', text); },
  info(req, text) { messages.add(req, 'info', text); },
  /** Pops (consumes) pending messages — they show once, like Django's. */
  consume(req) {
    const list = (req.session && req.session.messages) || [];
    if (req.session) req.session.messages = [];
    return list.map((m) => new Message(m.level, m.text));
  },
};

// ───────────────────────────────────────────── auth ──

const ANONYMOUS = Object.freeze({
  is_authenticated: false, is_student: false, is_admin: false, is_super_admin: false, can_manage_exams: false,
  username: '', id: null, pk: null,
});

/** HMAC of the stored password hash — a password change invalidates other sessions (Django's session auth hash). */
function sessionAuthHash(passwordHash) {
  return crypto.createHmac('sha256', `${config.SECRET_KEY}:session-auth`).update(String(passwordHash)).digest('hex');
}

async function loginUser(req, user) {
  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = user.id;
  req.session.authHash = sessionAuthHash(user.password);
  req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  await db.run('UPDATE accounts_user SET last_login = ? WHERE id = ?', [new Date(), user.id]);
}

/** update_session_auth_hash(): keep the current session valid after a password change. */
function updateSessionAuthHash(req, passwordHash) {
  req.session.authHash = sessionAuthHash(passwordHash);
}

async function logoutUser(req) {
  await new Promise((resolve) => req.session.destroy(() => resolve()));
}

/** Middleware: attaches req.user (a User, or ANONYMOUS). */
async function loadUser(req, res, next) {
  try {
    req.user = ANONYMOUS;
    const id = req.session && req.session.userId;
    if (id) {
      const user = await accounts.loadUser(id);
      if (user && user.is_active && req.session.authHash === sessionAuthHash(user.password)) {
        req.user = user;
      } else {
        delete req.session.userId;
        delete req.session.authHash;
      }
    }
    next();
  } catch (err) { next(err); }
}

// ───────────────────────────────────────────── CSRF ──

function csrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function csrfFailure(res, reason) {
  res.status(403).type('html').send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>403 Forbidden</title></head><body style="font-family:sans-serif;padding:2rem">`
    + `<h1>Forbidden <span style="color:#666;font-weight:normal">(403)</span></h1><p>CSRF verification failed. Request aborted.</p>`
    + `${config.DEBUG ? `<p style="color:#666">Reason given for failure: ${escapeHtml(reason)}</p>` : ''}</body></html>`,
  );
}

// Views Django marked @csrf_exempt (Paystack's server-to-server webhook).
const CSRF_EXEMPT_PATHS = new Set([URLS['billing:payment_webhook']]);

function csrfProtect(req, res, next) {
  if (CSRF_EXEMPT_PATHS.has(req.path)) return next();
  const token = csrfToken(req);
  if (['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(req.method)) return next();
  const sent = req.POST.get('csrfmiddlewaretoken') || req.get('X-CSRFToken') || '';
  const a = Buffer.from(String(sent));
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return csrfFailure(res, sent ? 'CSRF token incorrect.' : 'CSRF token missing.');
  return next();
}

// ───────────────────────────────────────────── rendering ──

/** examhub.context_processors.live_notifications — lazy import avoids a require cycle. */
async function liveNotifications(user) {
  if (!user || !user.is_authenticated || !user.is_student) return {};
  const { liveSchoolItems } = require('./routes/examhub_student');
  const live = await liveSchoolItems(user);
  return { notif_exams: live.exams, notif_tests: live.tests, notif_count: live.exams.length + live.tests.length };
}

function requestContext(req) {
  return {
    user: req.user,
    path: req.path,
    method: req.method,
    GET: req.GET ? req.GET.toObject() : {},
    get_full_path: req.originalUrl,
    scheme: req.protocol,
    get_host: req.get('host') || '',
    resolver_match: { url_name: req.urlName || '' },
  };
}

async function renderToString(req, template, ctx = {}) {
  const user = req.user || ANONYMOUS;
  const token = req.session ? csrfToken(req) : '';
  const context = {
    request: requestContext(req),
    user,
    csrf_token: token,
    csrf_input: safe(`<input type="hidden" name="csrfmiddlewaretoken" value="${escapeHtml(token)}">`),
    messages: messages.consume(req),
    site_settings: await accounts.getSiteSettings(),
    MEDIA_URL: config.MEDIA_URL,
    DEBUG: config.DEBUG,
    ...(await liveNotifications(user)),
    ...ctx,
  };
  return new Promise((resolve, reject) => {
    env.render(template, context, (err, html) => (err ? reject(err) : resolve(html)));
  });
}

async function render(req, res, template, ctx = {}, status = 200) {
  const html = await renderToString(req, template, ctx);
  res.status(status).type('html').send(html);
}

/** redirect('ns:name', ...args) or redirect('/literal/path/'). */
function redirect(res, target, ...args) {
  const url = URLS[target] !== undefined ? reverse(target, ...args) : target;
  res.redirect(302, url);
}

function jsonResponse(res, data, status = 200) {
  res.status(status).json(data);
}

// ───────────────────────────────────────────── route registration ──

/** Allowed "next" targets after login: same-site paths only (Django's url_has_allowed_host_and_scheme). */
function safeNext(next) {
  if (!next || typeof next !== 'string') return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  return next;
}

/**
 * Registers `handler` on `router` at the path for URL name `name`.
 * Options: { login: true } = login_required, { post: true } = require_POST,
 * { extra: {...} } = extra kwargs merged into the handler's params (like the
 * dict Django's path() can pass to a view).
 */
function route(router, name, handler, opts = {}) {
  router.all(expressPath(name), async (req, res, next) => {
    try {
      // Django-style path converters: <int:…> must be digits, <slug:…> a slug.
      for (const [k, v] of Object.entries(req.params)) {
        if (INT_PARAMS.has(k) && !/^\d+$/.test(v)) return next();
        if (SLUG_PARAMS.has(k) && !/^[-a-zA-Z0-9_]+$/.test(v)) return next();
      }
      const params = {};
      for (const [k, v] of Object.entries(req.params)) params[k] = INT_PARAMS.has(k) ? parseInt(v, 10) : v;
      Object.assign(params, opts.extra || {});
      req.urlName = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;

      if (opts.login && !req.user.is_authenticated) {
        return res.redirect(302, `${reverse('accounts:login')}?next=${encodeURIComponent(req.originalUrl)}`);
      }
      if (opts.post && req.method !== 'POST') {
        return res.status(405).type('text').send('Method Not Allowed');
      }
      return await handler(req, res, params);
    } catch (err) {
      return next(err);
    }
  });
}

module.exports = {
  Http404, HttpError, getOr404, messages, ANONYMOUS, loginUser, logoutUser, updateSessionAuthHash, loadUser,
  csrfProtect, csrfToken, render, renderToString, redirect, jsonResponse, route, safeNext, reverse, safe,
};
