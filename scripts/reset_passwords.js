/**
 * `npm run reset-passwords -- <username> [username...]` or `-- --all`
 * Sets a fresh random password for each account and prints it once (the
 * equivalent of `manage.py changepassword`). Stored passwords are one-way
 * hashes, so an old password can never be looked up — only replaced.
 */
const db = require('../src/db');
const { makePassword, generatePassword } = require('../src/services/passwords');

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) throw new Error('Usage: npm run reset-passwords -- <username> [username...]   (or --all)');
  const users = args.includes('--all')
    ? await db.all('SELECT id, username, role FROM accounts_user ORDER BY id')
    : await db.all('SELECT id, username, role FROM accounts_user WHERE username IN (?) ORDER BY id', [args]);
  if (!users.length) throw new Error('No matching accounts.');
  console.log('New passwords (shown once — save them now):');
  for (const u of users) {
    const password = generatePassword();
    await db.run('UPDATE accounts_user SET password = ?, is_active = 1, must_change_password = 0 WHERE id = ?', [await makePassword(password), u.id]);
    console.log(`  ${u.username.padEnd(28)} ${u.role.padEnd(12)} ${password}`);
  }
}

main().then(() => db.close()).catch(async (err) => { console.error(err.message); await db.close(); process.exit(1); });
