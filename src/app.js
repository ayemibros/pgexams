/** Express application — the equivalent of CBT_UI's settings.MIDDLEWARE + config/urls.py. */
const express = require('express');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');
const config = require('./config');
const db = require('./db');
const { parseBody } = require('./forms');
const { loadUser, csrfProtect, Http404 } = require('./web');
const { URLS } = require('./urls');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY || config.PUBLIC_URL) app.set('trust proxy', 1);

  // Behind IIS (SmarterASP.NET) HTTPS ends before Node and no X-Forwarded-Proto
  // header arrives, so Node would see every request as http — secure cookies
  // would never be set and the HTTPS redirect would loop. With an https
  // PUBLIC_URL, mark requests as HTTPS unless a proxy has said otherwise.
  if (config.PUBLIC_URL.startsWith('https://')) {
    app.use((req, res, next) => {
      if (!req.headers['x-forwarded-proto']) req.headers['x-forwarded-proto'] = 'https';
      next();
    });
  }

  // SecurityMiddleware + XFrameOptionsMiddleware equivalents.
  app.use((req, res, next) => {
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.SECURE_SSL_REDIRECT && !req.secure) return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
    return next();
  });

  // Static assets (whitenoise equivalent) and uploaded media (served in every mode).
  app.use('/static', express.static(config.STATIC_DIR, { maxAge: config.DEBUG ? 0 : '30d' }));
  app.use('/media', express.static(config.MEDIA_ROOT, { maxAge: config.DEBUG ? 0 : '1d' }));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/favicon.ico'));

  app.use(parseBody);

  const MySQLStore = MySQLStoreFactory(session);
  app.use(session({
    name: 'sessionid',
    secret: config.SECRET_KEY,
    store: new MySQLStore({ createDatabaseTable: true, clearExpired: true, checkExpirationInterval: 15 * 60 * 1000 }, db.getPool()),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: config.SESSION_COOKIE_AGE_MS, httpOnly: true, sameSite: 'lax', secure: config.SESSION_COOKIE_SECURE },
  }));

  app.use(loadUser);
  app.use(csrfProtect);

  // Same order as config/urls.py: admin, accounts, branding, catalog, billing, examhub.
  app.use('/admin', require('./routes/admin').router);
  app.use(require('./routes/accounts').router);
  app.use(require('./routes/branding').router);
  app.use(require('./routes/catalog').router);
  app.use(require('./routes/billing').router);
  app.use(require('./routes/examhub_student').router);
  app.use(require('./routes/examhub_staff').router);

  // CommonMiddleware's APPEND_SLASH for URLs Express didn't already match.
  const patterns = Object.values(URLS).map((p) => new RegExp(`^${p.replace(/:[a-z_]+/g, '[^/]+')}$`));
  app.use((req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && !req.path.endsWith('/')) {
      const slashed = `${req.path}/`;
      if (patterns.some((re) => re.test(slashed)) || slashed.startsWith('/admin/')) {
        return res.redirect(301, slashed + req.originalUrl.slice(req.path.length));
      }
    }
    return next(new Http404());
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return undefined;
    const wantsJson = String(req.get('accept') || '').includes('application/json') || String(req.get('content-type') || '').includes('application/json');
    if (wantsJson) return res.status(status).json({ ok: false, error: status === 404 ? 'Not found' : 'Server error' });
    const title = status === 404 ? 'Not Found' : status === 413 ? 'Request Too Large' : status === 405 ? 'Method Not Allowed' : 'Server Error';
    const detail = status === 404
      ? 'The requested resource was not found on this server.'
      : (config.DEBUG ? String(err.stack || err.message) : 'Something went wrong on our side. Please try again.');
    res.status(status).type('html').send(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>`
      + `<body style="font-family:sans-serif;padding:2rem;max-width:900px"><h1>${title} <span style="color:#666;font-weight:normal">(${status})</span></h1>`
      + `<pre style="white-space:pre-wrap;color:#444">${detail.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre></body></html>`,
    );
    return undefined;
  });

  return app;
}

module.exports = { createApp };
