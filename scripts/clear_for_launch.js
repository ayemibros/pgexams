/**
 * `node scripts/clear_for_launch.js --yes`
 *
 * Empties the configured database for real data entry, keeping only:
 * the super admin account "admin", the site branding, and the pricing tiers.
 * Deletes every other account (with its subscriptions, payments and exam
 * attempts), all plans, the whole catalog, all exams, question banks and
 * questions. Writes a full JSON backup of every table to backups/ first.
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');
const { TABLES } = require('./migrate');

const KEEP_USERNAME = 'admin';

async function main() {
  if (!process.argv.includes('--yes')) throw new Error('This deletes data. Re-run with --yes to confirm.');
  const admin = await db.one('SELECT id, role FROM accounts_user WHERE username = ?', [KEEP_USERNAME]);
  if (!admin) throw new Error(`Account "${KEEP_USERNAME}" not found — refusing to run (it would leave no way to log in).`);
  if (admin.role !== 'super_admin') throw new Error(`"${KEEP_USERNAME}" is not a Super Admin — refusing to run.`);

  // ── backup ──
  const backup = { database: config.DB.database, host: config.DB.host, taken_at: new Date().toISOString(), tables: {} };
  for (const t of TABLES) backup.tables[t] = await db.all(`SELECT * FROM \`${t}\``);
  const dir = path.join(config.BASE_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `backup-${config.DB.database}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(backup, null, 1));
  console.log(`Backup written: ${file}`);

  // ── clear ──
  const deleted = {};
  await db.transaction(async (tx) => {
    const del = async (label, sql, params = []) => { deleted[label] = (await tx.run(sql, params)).affectedRows; };
    await del('payments', 'DELETE FROM billing_payment');
    await del('subscriptions', 'DELETE FROM billing_subscription');
    await del('exam attempts', 'DELETE FROM examhub_examattempt');
    await del('exams', 'DELETE FROM examhub_exam');
    await del('question banks', 'DELETE FROM examhub_questionbank');
    await del('question tags', 'DELETE FROM examhub_questiontag');
    await del('plans', 'DELETE FROM billing_plan');
    await del('programmes', 'DELETE FROM catalog_bundle');
    await del('departments', 'DELETE FROM catalog_department');
    await del('faculties', 'DELETE FROM catalog_faculty');
    await del('subjects', 'DELETE FROM catalog_subject');
    await tx.run('UPDATE accounts_user SET created_by_id = NULL');
    await del('accounts', 'DELETE FROM accounts_user WHERE id <> ?', [admin.id]);
  });
  for (const [k, v] of Object.entries(deleted)) console.log(`  deleted ${String(v).padStart(3)} ${k}`);

  const left = {};
  for (const t of TABLES) left[t] = Number(await db.value(`SELECT COUNT(*) FROM \`${t}\``));
  console.log('Remaining rows:', Object.entries(left).filter(([, n]) => n).map(([t, n]) => `${t}=${n}`).join(', '));
}

main().then(() => db.close()).catch(async (err) => { console.error(err.message); await db.close(); process.exit(1); });
