/**
 * `npm run import-django -- [path/to/db.sqlite3] [--media path/to/media] [--replace]`
 *
 * Copies all data from the original Django CBT_UI SQLite database into this
 * MySQL database — users (password hashes stay valid), catalog, branding,
 * plans/subscriptions/payments, question banks, exams, attempts — keeping
 * their ids, plus the media/ folder. The Django database is opened read-only.
 * By default the target must be empty; --replace wipes this app's tables first.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../src/config');
const db = require('../src/db');
const { migrate, TABLES } = require('./migrate');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { sqlite: path.resolve(config.BASE_DIR, '..', 'CBT_UI', 'db.sqlite3'), media: null, replace: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--replace') out.replace = true;
    else if (args[i] === '--media') out.media = path.resolve(args[++i]);
    else out.sqlite = path.resolve(args[i]);
  }
  if (!out.media) out.media = path.join(path.dirname(out.sqlite), 'media');
  return out;
}

function copyDir(src, dest) {
  let n = 0;
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) n += copyDir(s, d);
    else if (!fs.existsSync(d)) { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

async function main() {
  const opts = parseArgs();
  if (!fs.existsSync(opts.sqlite)) throw new Error(`SQLite database not found: ${opts.sqlite}`);
  await migrate({ quiet: true });

  const src = new DatabaseSync(opts.sqlite, { readOnly: true });
  const srcTables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));

  let existing = 0;
  for (const t of TABLES) existing += Number(await db.value(`SELECT COUNT(*) FROM \`${t}\``));
  if (existing && !opts.replace) {
    throw new Error(`The MySQL database "${config.DB.database}" already has ${existing} row(s). Re-run with --replace to wipe it and import again.`);
  }

  console.log(`Importing from ${opts.sqlite}`);
  await db.transaction(async (tx) => {
    await tx.run('SET FOREIGN_KEY_CHECKS = 0');
    if (opts.replace) for (const t of [...TABLES].reverse()) await tx.run(`DELETE FROM \`${t}\``);
    for (const table of TABLES) {
      if (!srcTables.has(table)) { console.log(`  ${table}: not in source, skipped`); continue; }
      const targetCols = new Set((await tx.all(`SHOW COLUMNS FROM \`${table}\``)).map((c) => c.Field));
      const rows = src.prepare(`SELECT * FROM "${table}" ORDER BY id`).all();
      if (!rows.length) { console.log(`  ${table}: 0 rows`); continue; }
      const cols = Object.keys(rows[0]).filter((c) => targetCols.has(c));
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        const params = [];
        for (const r of batch) for (const c of cols) params.push(typeof r[c] === 'bigint' ? Number(r[c]) : (r[c] ?? null));
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
  src.close();

  console.log(`Copied ${copyDir(opts.media, config.MEDIA_ROOT)} media file(s) from ${opts.media}`);
  console.log('Import complete. Existing logins work unchanged.');
}

main().then(() => db.close()).catch(async (err) => { console.error(err.message); await db.close(); process.exit(1); });
