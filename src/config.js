/**
 * App settings — the Node equivalent of CBT_UI's config/settings.py. Every
 * setting is an optional environment variable with a LAN/offline-safe
 * default, loaded from a persistent .env file next to package.json (a real
 * OS-level env var still wins, same as python-dotenv's default behaviour).
 */
const path = require('path');

const BASE_DIR = path.resolve(__dirname, '..');
const ENV_PATH = path.join(BASE_DIR, '.env');

require('dotenv').config({ path: ENV_PATH, quiet: true });

const env = (name, fallback) => (process.env[name] !== undefined && process.env[name] !== '' ? process.env[name] : fallback);
const boolEnv = (name, fallback) => env(name, fallback ? 'True' : 'False') === 'True';

const DEBUG = boolEnv('DEBUG', true);

// Secure cookies and HTTPS redirects silently break login on a plain-HTTP
// deployment, so they stay OFF unless an online deployment opts in with
// ONLINE_MODE=True (or sets the individual flags).
const ONLINE_MODE = boolEnv('ONLINE_MODE', false);

const PAYSTACK_SECRET_KEY = env('PAYSTACK_SECRET_KEY', '');

module.exports = {
  BASE_DIR,
  ENV_PATH,
  DEBUG,
  ONLINE_MODE,
  SECRET_KEY: env('SECRET_KEY', 'dev-insecure-secret-key-change-me-in-production'),
  // A number locally; under IIS/iisnode (SmarterASP.NET) PORT is a named pipe
  // such as "\\.\pipe\…", which must be passed to listen() unchanged.
  PORT: /^\d+$/.test(env('PORT', '8000')) ? parseInt(env('PORT', '8000'), 10) : env('PORT', '8000'),
  HOST: env('HOST', '0.0.0.0'),
  TIME_ZONE: env('TIME_ZONE', 'Africa/Lagos'),
  // The site's public address, e.g. https://pgexams.telifort.com — used for
  // links sent to other services (the Paystack return URL). When it is https,
  // every request is treated as HTTPS: hosts like SmarterASP.NET/IIS end TLS
  // before Node and don't say so in a header.
  PUBLIC_URL: env('PUBLIC_URL', '').replace(/\/+$/, ''),

  DB: {
    host: env('DB_HOST', '127.0.0.1'),
    port: parseInt(env('DB_PORT', '3306'), 10),
    database: env('DB_NAME', 'cbt_ui'),
    user: env('DB_USER', 'root'),
    password: env('DB_PASSWORD', ''),
  },

  SESSION_COOKIE_AGE_MS: 60 * 60 * 8 * 1000, // 8 hours — appropriate for exam sessions
  SECURE_SSL_REDIRECT: boolEnv('SECURE_SSL_REDIRECT', ONLINE_MODE && !DEBUG),
  SESSION_COOKIE_SECURE: boolEnv('SESSION_COOKIE_SECURE', ONLINE_MODE && !DEBUG),
  CSRF_COOKIE_SECURE: boolEnv('CSRF_COOKIE_SECURE', ONLINE_MODE && !DEBUG),
  TRUST_PROXY: ONLINE_MODE,

  // ── Payments (Paystack) ──────────────────────────────────────────────
  // Each client deployment uses its own Paystack account. Left blank, the
  // Subscribe flow shows a clear not-configured message instead of erroring.
  PAYSTACK_SECRET_KEY,
  PAYSTACK_PUBLIC_KEY: env('PAYSTACK_PUBLIC_KEY', ''),
  // LOCAL TESTING ONLY: replaces the Paystack redirect with a fake "simulate
  // payment" page. On only when PAYMENT_SIMULATION=True is set explicitly,
  // DEBUG is on, and no Paystack secret key is configured.
  PAYMENT_SIMULATION: boolEnv('PAYMENT_SIMULATION', false) && DEBUG && !PAYSTACK_SECRET_KEY,

  STATIC_DIR: path.join(BASE_DIR, 'static'),
  MEDIA_ROOT: path.join(BASE_DIR, 'media'),
  MEDIA_URL: '/media/',
  TEMPLATES_DIR: path.join(BASE_DIR, 'templates'),
};
