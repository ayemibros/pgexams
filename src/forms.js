/**
 * Request body parsing with Django semantics.
 *
 *   req.POST  — a QueryDict: .get(key, default) returns the LAST value for a
 *               key (like Django), .getlist(key) returns all values, .has(key)
 *   req.GET   — the same, built from the query string
 *   req.FILES — .get(name) -> { originalname, mimetype, size, path } | null
 *   req.rawBody — the raw text of an application/json request (handlers
 *                 JSON.parse it themselves, so invalid JSON can return 400
 *                 exactly like Django's json.loads(request.body) views)
 *
 * urlencoded and multipart bodies are parsed into the same flat list of
 * (key, value) pairs, so field names like "choice_text[]" or repeated
 * "cohorts" behave identically in both.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const busboy = require('busboy');
const config = require('./config');

class QueryDict {
  constructor(pairs = []) { this.pairs = pairs; }
  get(key, fallback = undefined) {
    for (let i = this.pairs.length - 1; i >= 0; i--) if (this.pairs[i][0] === key) return this.pairs[i][1];
    return fallback;
  }
  getlist(key) { return this.pairs.filter(([k]) => k === key).map(([, v]) => v); }
  has(key) { return this.pairs.some(([k]) => k === key); }
  keys() { return [...new Set(this.pairs.map(([k]) => k))]; }
  /** Plain object of last values — handy for re-filling forms. */
  toObject() { const o = {}; for (const [k, v] of this.pairs) o[k] = v; return o; }
}

class Files {
  constructor(files = []) { this.files = files; }
  get(name) { return this.files.find((f) => f.fieldname === name) || null; }
  cleanup() { for (const f of this.files) fs.promises.unlink(f.path).catch(() => {}); }
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // non-file form data (Django's DATA_UPLOAD_MAX_MEMORY_SIZE is 2.5MB; a bit roomier here)
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // lesson videos can be large

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const pairs = [];
    const files = [];
    const pending = [];
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES, fieldSize: MAX_BODY_BYTES }, defParamCharset: 'utf8' });
    } catch (err) { reject(err); return; }
    bb.on('field', (name, value) => pairs.push([name, value]));
    bb.on('file', (name, stream, info) => {
      if (!info.filename) { stream.resume(); return; }
      const tmp = path.join(os.tmpdir(), `cbt-upload-${crypto.randomBytes(12).toString('hex')}`);
      const out = fs.createWriteStream(tmp);
      let size = 0;
      stream.on('data', (c) => { size += c.length; });
      pending.push(new Promise((res, rej) => {
        out.on('finish', () => {
          if (size > 0) files.push({ fieldname: name, originalname: info.filename, mimetype: info.mimeType, size, path: tmp });
          else fs.promises.unlink(tmp).catch(() => {});
          res();
        });
        out.on('error', rej);
        stream.on('limit', () => rej(Object.assign(new Error('Uploaded file too large'), { status: 413 })));
      }));
      stream.pipe(out);
    });
    bb.on('close', () => Promise.all(pending).then(() => resolve({ pairs, files }), reject));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

/** Express middleware populating req.GET / req.POST / req.FILES / req.rawBody. */
async function parseBody(req, res, next) {
  try {
    req.GET = new QueryDict([...new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '')]);
    req.POST = new QueryDict();
    req.FILES = new Files();
    req.rawBody = '';
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (type.startsWith('multipart/form-data')) {
      const { pairs, files } = await parseMultipart(req);
      req.POST = new QueryDict(pairs);
      req.FILES = new Files(files);
      res.on('finish', () => req.FILES.cleanup());
    } else {
      const buf = await readRaw(req, MAX_BODY_BYTES);
      req.rawBuffer = buf; // exact bytes, e.g. for verifying Paystack's webhook HMAC
      const raw = buf.toString('utf8');
      req.rawBody = raw;
      if (type.startsWith('application/x-www-form-urlencoded')) {
        req.POST = new QueryDict([...new URLSearchParams(raw)]);
      }
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

// ───────────────────────────────────────────── media storage ──

/** Django's Storage.get_valid_name(). */
function validName(name) {
  return String(name).trim().replace(/ /g, '_').replace(/[^-\w.]/g, '');
}

/** strftime-expand an upload_to like "avatars/%Y/%m/". */
function expandUploadTo(uploadTo) {
  const d = new Date();
  return uploadTo
    .replace(/%Y/g, String(d.getFullYear()))
    .replace(/%m/g, String(d.getMonth() + 1).padStart(2, '0'))
    .replace(/%d/g, String(d.getDate()).padStart(2, '0'));
}

function randomSuffix(n = 7) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

/** Picks a free name under MEDIA_ROOT the way Django's FileSystemStorage does. */
async function availableName(relName) {
  const dir = path.posix.dirname(relName);
  const ext = path.posix.extname(relName);
  const base = path.posix.basename(relName, ext);
  let candidate = relName;
  while (fs.existsSync(path.join(config.MEDIA_ROOT, candidate))) {
    candidate = path.posix.join(dir, `${base}_${randomSuffix()}${ext}`);
  }
  return candidate;
}

/** Saves an uploaded temp file into MEDIA_ROOT/<upload_to>; returns the stored relative name. */
async function saveUpload(file, uploadTo) {
  const rel = await availableName(path.posix.join(expandUploadTo(uploadTo), validName(path.basename(file.originalname)) || 'file'));
  const dest = path.join(config.MEDIA_ROOT, rel);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.rename(file.path, dest);
  } catch (_) {
    await fs.promises.copyFile(file.path, dest);
    await fs.promises.unlink(file.path).catch(() => {});
  }
  return rel;
}

/** Saves raw bytes at an exact relative name (made unique if taken); returns the stored name. */
async function saveBytes(relName, buffer) {
  const rel = await availableName(relName);
  const dest = path.join(config.MEDIA_ROOT, rel);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, buffer);
  return rel;
}

module.exports = { QueryDict, Files, parseBody, saveUpload, saveBytes, validName };
