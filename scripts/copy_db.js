/**
 * `npm run copy-db -- [--from-host 127.0.0.1] [--from-port 3306] [--from-db cbt_ui] [--from-user root] [--replace]`
 *
 * Copies every row of this app's tables from another MySQL database (by
 * default the local XAMPP `cbt_ui` database) into the database configured
 * in .env — e.g. to move a locally prepared site onto the live server's
 * database. Ids are kept. The source password comes from COPY_FROM_PASSWORD
 * (blank by default). The target must hold no app data (only the auto-created
 * site-settings row is allowed) unless --replace is given, which wipes it first.
 */
const mysql = require('mysql2/promise');
const config = require('../src/config');
const db = require('../src/db');
const { migrate, TABLES } = require('./migrate');

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag, dflt) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : dflt; };
  return {
    host: get('--from-host', '127.0.0.1'),
    port: parseInt(get('--from-port', '3306'), 10),
    database: get('--from-db', 'cbt_ui'),
    user: get('--from-user', 'root'),
    password: process.env.COPY_FROM_PASSWORD || '',
    replace: a.includes('--replace'),
  };
}

async function main() {
  const src = parseArgs();
  const t = config.DB;
  if (src.host === t.host && src.port === t.port && src.database === t.database) throw new Error('Source and target are the same database.');

  await migrate({ quiet: true });
  const from = await mysql.createConnection({
    host: src.host, port: src.port, database: src.database, user: src.user, password: src.password,
    charset: 'utf8mb4', timezone: 'Z', dateStrings: true,
  });

  let existing = 0;
  for (const table of TABLES) {
    if (table === 'branding_sitesettings') continue;
    existing += Number(await db.value(`SELECT COUNT(*) FROM \`${table}\``));
  }
  if (existing && !src.replace) {
    await from.end();
    throw new Error(`Target ${t.database}@${t.host} already has ${existing} row(s) of app data. Re-run with --replace to wipe it first.`);
  }

  console.log(`Copying ${src.database}@${src.host}  ->  ${t.database}@${t.host}`);
  await db.transaction(async (tx) => {
    await tx.run('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of [...TABLES].reverse()) await tx.run(`DELETE FROM \`${table}\``);
    for (const table of TABLES) {
      const [rows] = await from.query(`SELECT * FROM \`${table}\` ORDER BY id`);
      if (!rows.length) { console.log(`  ${table}: 0 rows`); continue; }
      const cols = Object.keys(rows[0]);
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        const params = [];
        for (const r of batch) for (const c of cols) params.push(r[c]);
        await tx.run(
          `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES ${batch.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}`,
          params,
        );
      }
      await tx.run(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ${Math.max(...rows.map((r) => Number(r.id))) + 1}`);
      console.log(`  ${table}: ${rows.length} rows`);
    }
    await tx.run('SET FOREIGN_KEY_CHECKS = 1');
  });
  await from.end();
  console.log('Copy complete. Uploaded files (the media/ folder) are not in the database — upload that folder separately if it has files.');
}

main().then(() => db.close()).catch(async (err) => { console.error(err.message); await db.close(); process.exit(1); });
