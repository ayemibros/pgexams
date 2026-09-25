/**
 * `npm run create-test-accounts` — port of CBT_UI's create_test_accounts
 * command: creates (or resets) a throwaway Super Admin and Student login for
 * LOCAL TESTING ONLY. The credentials are public (they live in this file),
 * which is why it refuses to run unless DEBUG is on.
 */
const config = require('../src/config');
const db = require('../src/db');
const { migrate } = require('./migrate');
const accounts = require('../src/services/accounts');
const { makePassword } = require('../src/services/passwords');

const TEST_ACCOUNTS = [
  {
    label: 'Super Admin', username: 'testadmin', email: 'testadmin@example.com', password: 'Admin-Test-2026!',
    first_name: 'Test', last_name: 'Admin', role: 'super_admin', is_staff: true, is_superuser: true,
  },
  {
    label: 'Student', username: 'student.test@example.com', email: 'student.test@example.com', password: 'Student-Test-2026!',
    first_name: 'Test', last_name: 'Applicant', role: 'student', is_staff: false, is_superuser: false,
  },
];

async function main() {
  if (!config.DEBUG) throw new Error('Refusing to create well-known test accounts while DEBUG is off.');
  await migrate({ quiet: true });
  console.log('');
  for (const spec of TEST_ACCOUNTS) {
    const { label, password, ...fields } = spec;
    const existing = await db.one('SELECT id FROM accounts_user WHERE username = ?', [spec.username]);
    const data = { ...fields, is_active: true, must_change_password: false, password: await makePassword(password) };
    if (existing) {
      await db.update('accounts_user', existing.id, data);
      await accounts.ensureRegistrationNumber(existing.id);
    } else {
      await accounts.createUser(fields, password);
      await db.run('UPDATE accounts_user SET must_change_password = 0 WHERE username = ?', [spec.username]);
    }
    console.log(`  ${existing ? 'Reset  ' : 'Created'} ${label.padEnd(12)} login: ${spec.username.padEnd(26)} password: ${password}`);
  }
  console.log('\nFor local testing only. Delete these accounts before going live.\n');
}

main().then(() => db.close()).catch(async (err) => { console.error(err.message); await db.close(); process.exit(1); });
