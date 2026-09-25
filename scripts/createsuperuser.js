/**
 * `npm run createsuperuser -- <username> [email]` — creates a Super Admin
 * (the equivalent of `manage.py createsuperuser`). The password comes from
 * the CBT_SUPERUSER_PASSWORD env var, or is generated and printed once.
 */
const db = require('../src/db');
const { migrate } = require('./migrate');
const accounts = require('../src/services/accounts');
const { generatePassword, validatePassword } = require('../src/services/passwords');

async function main() {
  const [username, email = ''] = process.argv.slice(2);
  if (!username) throw new Error('Usage: npm run createsuperuser -- <username> [email]');
  await migrate({ quiet: true });
  if (await db.value('SELECT COUNT(*) FROM accounts_user WHERE username = ?', [username])) throw new Error('Error: That username is already taken.');
  const provided = process.env.CBT_SUPERUSER_PASSWORD;
  const password = provided || generatePassword(14);
  if (provided) {
    const errors = validatePassword(password, { username, email });
    if (errors.length) throw new Error(errors.join('\n'));
  }
  await accounts.createUser({ username, email, role: 'super_admin', is_superuser: true, is_staff: true }, password);
  console.log(`Superuser "${username}" created.${provided ? '' : ` Password: ${password}`}`);
}

main().then(() => db.close()).catch(async (err) => { console.error(err.message); await db.close(); process.exit(1); });
