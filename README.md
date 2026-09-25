# CBT UI — Node.js + MySQL

**Powered by Telifort Ltd.** This is a Node.js/MySQL port of the Django
`CBT_UI` project. It's a single-institution, subscription-based exam-practice
platform for postgraduate entrance exams, with:

- **Public site:** home, how it works, support, and a subscribe page that walks applicants from faculty to department to programme.
- **Sign-up during checkout:** the applicant's email becomes their username.
- **Paystack payments:** callback, webhook and a local test-payment simulator.
- **Access tied to subscriptions:** any postgraduate subscription unlocks the shared EPT, and past-question practice has unlimited retakes.
- **The CBT exam engine:** 9 question types, the rich STEM question editor, bulk import, grading, analytics and CSV export.
- **Admin screens:** catalog (faculties, departments, subjects, programmes), accounts, pricing tiers, plans, subscriptions, payments and site branding.

The URLs, pages, rules and data model are the same as the Django version.
MySQL tables and columns use the same names as Django's, so data copies across unchanged.

## Getting started

Requirements: Node.js 22.5+ and MySQL or MariaDB. XAMPP's MariaDB works.

```bash
npm install
copy .env.example .env       # DB_* settings, Paystack keys
npm run migrate              # creates the `cbt_ui` database and tables
npm run seed                 # demo branding, catalog, exams, plans + admin/teacher/student logins (printed once)
npm start                    # http://localhost:8000/
```

Bring over the data from the Django version (read-only on the Django side;
logins keep working because the password format is identical):

```bash
npm run import-django                              # default: ..\CBT_UI\db.sqlite3 + ..\CBT_UI\media
npm run import-django -- path\to\db.sqlite3 --replace
```

## Payments

- **Real payments:** set `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` in `.env`.
  - Paystack sends the applicant back to `/subscribe/callback/`.
  - Point Paystack's webhook at `https://<your-domain>/subscribe/webhook/`. Its HMAC-SHA512 signature is verified, and it is exempt from CSRF, as in Django.
- **Without keys:** Subscribe shows a "payment isn't set up yet" message.
- **Local testing without Paystack:** `PAYMENT_SIMULATION=True` (with `DEBUG=True` and no secret key) replaces Paystack with a test page offering success and failure buttons. It runs the same activation code as a real payment.

The price is always recalculated on the server from the pricing tiers and the
number of programmes. Each purchase is recorded as a hidden snapshot plan, so
later price changes never affect past orders.

## Commands

| Command | Django equivalent |
|---|---|
| `npm start` | `runserver` / `gunicorn` (runs `migrate` first, like the Procfile) |
| `npm run migrate` | `migrate` |
| `npm run seed` | `seed_demo` |
| `npm run create-test-accounts` | `create_test_accounts` (fixed local-testing logins, DEBUG only) |
| `npm run createsuperuser -- <username> [email]` | `createsuperuser` |
| `npm run reset-passwords -- <username…>` or `-- --all` | `changepassword` |
| `npm run import-django` | *(new)* copy data from the Django SQLite database |
| `npm run smoke-test` | *(new)* end-to-end test against a running server, using temporary accounts that are deleted afterwards |

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` | `127.0.0.1` `3306` `cbt_ui` `root` *(empty)* | MySQL connection |
| `HOST` / `PORT` | `0.0.0.0` / `8000` | Listen address |
| `SECRET_KEY` | dev value | Signs session cookies. Set a real one in production |
| `DEBUG` | `True` | Shows error details and reloads templates on change |
| `ONLINE_MODE` | `False` | HTTPS redirect, secure cookies, trust proxy |
| `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` | *(empty)* | This client's Paystack account |
| `PAYMENT_SIMULATION` | `False` | Local test payments (DEBUG only, no Paystack key) |
| `TIME_ZONE` | `Africa/Lagos` | Display time zone. Datetimes are stored in UTC |

## Layout

```
server.js            entry point
src/app.js           middleware and routers (settings.MIDDLEWARE + config/urls.py)
src/urls.js          every named route 'ns:name' -> path, identical to Django
src/models.js        model classes: roles, counts_as_ept, is_active_now, whatsapp_url, …
src/routes/          accounts, branding, catalog, billing, examhub_student, examhub_staff, admin
src/services/        billing (AccessProfile, activation), paystack, exams, grading, sanitize, passwords
src/schema.sql       MySQL schema
templates/           Nunjucks ports of every Django template
static/              public.css, rich editor, vendored KaTeX
```

## Deliberate differences from the Django version

- **`/admin/`:** a generic data console replaces the Django admin, with the same models and columns. Only staff (`is_staff`) accounts can use it.
- **Duplicate catalog names** (faculty, department, subject) show a form message instead of a server error.
- **Deleting a plan that subscriptions use** shows a message instead of a server error. The data rule is the same (Django's `PROTECT`).
- **Missing trailing slash:** a URL like `/exams` is served directly instead of via a 301 redirect to `/exams/`.
- **Decimal display:** decimals print without trailing zeros where the template doesn't format them, e.g. `25%` instead of `25.00%`.
