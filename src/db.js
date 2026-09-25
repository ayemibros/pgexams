/**
 * Thin MySQL/MariaDB data-access layer (mysql2/promise). Rather than an ORM,
 * the app uses plain parameterised SQL with a few helpers:
 *
 *   db.all(sql, params)          -> rows[]
 *   db.one(sql, params)          -> first row or null
 *   db.value(sql, params)        -> first column of first row (e.g. COUNT(*))
 *   db.run(sql, params)          -> { insertId, affectedRows }
 *   db.insert(table, data)       -> new id
 *   db.update(table, id, data)   -> affectedRows
 *   db.transaction(async (tx) => { ... tx.insert(...) ... })
 *
 * JSON fields are stored as LONGTEXT (works on both MySQL 5.7+/8 and MariaDB,
 * whose JSON type is only an alias) — encoded on write here, decoded on read
 * by the model layer (src/models.js). All DATETIMEs are read/written as UTC.
 */
const mysql = require('mysql2/promise');
const config = require('./config');

let pool = null;

function createPool(opts = config.DB) {
  return mysql.createPool({
    host: opts.host,
    port: opts.port,
    user: opts.user,
    password: opts.password,
    database: opts.database,
    waitForConnections: true,
    connectionLimit: 15,
    charset: 'utf8mb4',
    timezone: 'Z',
    // DATE columns (e.g. date_of_birth) have no time zone — keep them as
    // 'YYYY-MM-DD' strings so they can never shift a day on conversion.
    dateStrings: ['DATE'],
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
  });
}

function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

/** Raw query params: arrays are kept as-is so `IN (?)` expands to a list. */
function encodeParam(v) {
  if (v === undefined) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  if (Array.isArray(v)) return v;
  if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

/** Column values for insert/update: arrays and objects are JSON fields. */
function encodeValue(v) {
  if (v === undefined) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

function makeApi(executor) {
  const api = {
    async all(sql, params = []) {
      const [rows] = await executor.query(sql, params.map(encodeParam));
      return rows;
    },
    async one(sql, params = []) {
      const rows = await api.all(sql, params);
      return rows.length ? rows[0] : null;
    },
    async value(sql, params = []) {
      const row = await api.one(sql, params);
      if (!row) return null;
      return row[Object.keys(row)[0]];
    },
    async run(sql, params = []) {
      const [result] = await executor.query(sql, params.map(encodeParam));
      return result;
    },
    async insert(table, data) {
      const cols = Object.keys(data);
      const sql = `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      const [result] = await executor.query(sql, cols.map((c) => encodeValue(data[c])));
      return result.insertId;
    },
    async insertMany(table, rows, batchSize = 500) {
      if (!rows.length) return 0;
      const cols = Object.keys(rows[0]);
      let n = 0;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const sql = `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES ${batch.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}`;
        const params = [];
        for (const r of batch) for (const c of cols) params.push(encodeValue(r[c]));
        const [result] = await executor.query(sql, params);
        n += result.affectedRows;
      }
      return n;
    },
    async update(table, id, data) {
      const cols = Object.keys(data);
      if (!cols.length) return 0;
      const sql = `UPDATE \`${table}\` SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`;
      const [result] = await executor.query(sql, [...cols.map((c) => encodeValue(data[c])), id]);
      return result.affectedRows;
    },
    async remove(table, id) {
      const result = await api.run(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
      return result.affectedRows;
    },
  };
  return api;
}

const db = makeApi({ query: (...args) => getPool().query(...args) });

db.transaction = async function transaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(makeApi(conn));
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
};

/** `IN (?)` helper that stays valid SQL for an empty list. */
db.inList = (ids) => (ids && ids.length ? ids : [-1]);

db.getPool = getPool;
db.createPool = createPool;
db.makeApi = makeApi;
db.close = async () => { if (pool) { await pool.end(); pool = null; } };

module.exports = db;
