/**
 * `npm run migrate` — creates the MySQL database (if missing) and all tables
 * (the equivalent of `python manage.py migrate`). Safe to re-run.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config');

// Parent tables before children (also the order data is copied in).
const TABLES = [
  'accounts_user', 'catalog_subject', 'catalog_faculty', 'catalog_department', 'catalog_bundle', 'catalog_bundle_subjects',
  'branding_sitesettings', 'billing_plan', 'billing_plan_subjects', 'billing_plan_bundles', 'billing_pricingtier',
  'billing_subscription', 'billing_payment', 'examhub_questionbank', 'examhub_questiontag', 'examhub_question',
  'examhub_question_tags', 'examhub_exam', 'examhub_examsection', 'examhub_examquestion', 'examhub_examattempt',
  'examhub_attemptanswer',
];

function schemaStatements() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8');
  return sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);
}

async function migrate({ quiet = false } = {}) {
  const { host, port, user, password, database } = config.DB;
  const conn = await mysql.createConnection({ host, port, user, password, charset: 'utf8mb4' });
  try {
    const name = database.replace(/`/g, '');
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`USE \`${name}\``);
    for (const stmt of schemaStatements()) await conn.query(stmt);
    if (!quiet) console.log(`Database "${database}" is up to date (${TABLES.length} tables).`);
  } finally {
    await conn.end();
  }
}

module.exports = { migrate, TABLES, schemaStatements };

if (require.main === module) {
  migrate().catch((err) => { console.error(err.message); process.exit(1); });
}
