'use strict';
/* POS SATE - server online
 * Node >= 22.13 (memakai node:sqlite bawaan, tanpa dependensi npm).
 * Menyimpan data di SQLite (data/pos.db), melayani aplikasi POS, dan API sinkron.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PASSWORD = process.env.POS_PASSWORD || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_BODY = 40 * 1024 * 1024;
const TOKEN_DAYS = 90;

if (!PASSWORD || PASSWORD.length < 6) {
  console.error('\n[POS SATE] Atur kata sandi dulu: POS_PASSWORD="sandi-anda" (minimal 6 karakter)\n');
  process.exit(1);
}
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

/* ---------- rahasia penanda token ---------- */
let SECRET = process.env.POS_SECRET || '';
if (!SECRET) {
  const f = path.join(DATA_DIR, 'secret.key');
  try { SECRET = fs.readFileSync(f, 'utf8').trim(); } catch (e) {}
  if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, SECRET, { mode: 0o600 }); }
}
const PV = crypto.createHash('sha256').update(PASSWORD + '|' + SECRET).digest('hex').slice(0, 10); // ganti sandi = token lama tidak berlaku
const b64 = (b) => Buffer.from(b).toString('base64url');
const mac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken() {
  const p = b64(JSON.stringify({ exp: Date.now() + TOKEN_DAYS * 864e5, pv: PV }));
  return p + '.' + mac(p);
}
function checkToken(t) {
  if (!t || typeof t !== 'string') return false;
  const [p, m] = t.split('.');
  if (!p || !m) return false;
  const e = mac(p);
  if (e.length !== m.length || !crypto.timingSafeEqual(Buffer.from(e), Buffer.from(m))) return false;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.exp > Date.now() && o.pv === PV; } catch (e) { return false; }
}
function samePassword(a) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(PASSWORD));
}

/* ---------- database ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'pos.db'));
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS doc(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots(day TEXT PRIMARY KEY, json TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, name TEXT, cat TEXT, price REAL, cost REAL, stock REAL, pos INTEGER);
CREATE TABLE IF NOT EXISTS orders(no TEXT PRIMARY KEY, t TEXT, type TEXT, method TEXT, subtotal REAL, discount REAL, tax REAL, total REAL, paid REAL, cust TEXT);
CREATE TABLE IF NOT EXISTS order_lines(no TEXT, name TEXT, qty REAL, price REAL, cost REAL);
CREATE INDEX IF NOT EXISTS idx_orders_t ON orders(t);
CREATE INDEX IF NOT EXISTS idx_lines_no ON order_lines(no);
`);
const q = {
  get: db.prepare('SELECT json, version, updated_at FROM doc WHERE id=1'),
  upsert: db.prepare('INSERT INTO doc(id,json,version,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, version=excluded.version, updated_at=excluded.updated_at'),
  snap: db.prepare('INSERT OR IGNORE INTO snapshots(day,json,version,created_at) SELECT ?, json, version, ? FROM doc WHERE id=1'),
  snapList: db.prepare('SELECT day, version, created_at, length(json) AS size FROM snapshots ORDER BY day DESC'),
  snapGet: db.prepare('SELECT json, version FROM snapshots WHERE day=?'),
  snapPrune: db.prepare('DELETE FROM snapshots WHERE day NOT IN (SELECT day FROM snapshots ORDER BY day DESC LIMIT 30)'),
  insItem: db.prepare('INSERT OR REPLACE INTO items(id,name,cat,price,cost,stock,pos) VALUES(?,?,?,?,?,?,?)'),
  insOrder: db.prepare('INSERT OR REPLACE INTO orders(no,t,type,method,subtotal,discount,tax,total,paid,cust) VALUES(?,?,?,?,?,?,?,?,?,?)'),
  insLine: db.prepare('INSERT INTO order_lines(no,name,qty,price,cost) VALUES(?,?,?,?,?)'),
};
const num = (v) => (Number.isFinite(+v) ? +v : 0);

function getDoc() {
  const r = q.get.get();
  return r ? { version: r.version, updatedAt: r.updated_at, data: JSON.parse(r.json) } : { version: 0, updatedAt: null, data: null };
}
function validDoc(d) {
  return d && typeof d === 'object' && Array.isArray(d.items) && Array.isArray(d.orders) && d.set && typeof d.set === 'object';
}
function saveDoc(data, baseVersion) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = q.get.get();
    const ver = cur ? cur.version : 0;
    if (baseVersion !== ver) {
      db.exec('ROLLBACK');
      return { conflict: true, version: ver, data: cur ? JSON.parse(cur.json) : null };
    }
    const now = new Date().toISOString();
    if (cur) { q.snap.run(now.slice(0, 10), now); q.snapPrune.run(); } // snapshot harian = kondisi sebelum perubahan pertama hari itu
    const nv = ver + 1;
    q.upsert.run(JSON.stringify(data), nv, now);
    db.exec('DELETE FROM items; DELETE FROM orders; DELETE FROM order_lines;');
    data.items.forEach((i, n) => q.insItem.run(String(i.id), String(i.name || ''), String(i.cat || ''), num(i.price), num(i.cost), num(i.stock), n));
    for (const o of data.orders) {
      q.insOrder.run(String(o.no), String(o.t || ''), String(o.type || ''), String(o.method || ''), num(o.sub), num(o.disc), num(o.tax), num(o.total), num(o.paid), String(o.cust || ''));
      for (const l of o.lines || []) q.insLine.run(String(o.no), String(l.name || ''), num(l.qty), num(l.price), num(l.cost));
    }
    db.exec('COMMIT');
    return { version: nv, updatedAt: now };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (x) {}
    throw e;
  }
}

/* cadangan file JSON harian (data/backups), simpan 30 hari */
function dailyBackup() {
  try {
    const d = getDoc();
    if (!d.data) return;
    const day = new Date().toISOString().slice(0, 10), f = path.join(DATA_DIR, 'backups', `pos-${day}.json`);
    if (!fs.existsSync(f)) {
      fs.writeFileSync(f, JSON.stringify(d.data));
      const all = fs.readdirSync(path.join(DATA_DIR, 'backups')).filter((n) => /^pos-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
      all.slice(0, Math.max(0, all.length - 30)).forEach((n) => fs.unlinkSync(path.join(DATA_DIR, 'backups', n)));
    }
  } catch (e) { console.error('backup harian gagal:', e.message); }
}
setTimeout(dailyBackup, 3000).unref();
setInterval(dailyBackup, 3600e3).unref();

/* ---------- pembatasan percobaan login ---------- */
const fails = new Map();
function clientIp(req) {
  if (TRUST_PROXY) { const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (x) return x; }
  return req.socket.remoteAddress || '?';
}
function locked(ip) { const f = fails.get(ip); return !!(f && f.until > Date.now()); }
function fail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++; if (f.n >= 8) { f.until = Date.now() + 10 * 60e3; f.n = 0; }
  fails.set(ip, f);
}
setInterval(() => { const t = Date.now(); for (const [k, v] of fails) if (v.until < t && v.n === 0) fails.delete(k); }, 600e3).unref();

/* ---------- berkas statis ---------- */
const PUB = path.join(__dirname, 'public');
const STATIC = {
  '/manifest.webmanifest': ['application/manifest+json', 'no-cache'],
  '/sw.js': ['text/javascript', 'no-cache'],
  '/icon-192.png': ['image/png', 'public, max-age=86400'],
  '/icon-512.png': ['image/png', 'public, max-age=86400'],
};
let indexCache = { m: 0, raw: null, gz: null };
function indexHtml() {
  const f = path.join(PUB, 'index.html'), st = fs.statSync(f);
  if (indexCache.m !== st.mtimeMs) {
    let h = fs.readFileSync(f, 'utf8');
    const inject = '<script>window.POS_CLOUD=true</script><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-192.png"><link rel="icon" href="/icon-192.png">';
    h = h.includes('</head>') ? h.replace('</head>', inject + '</head>') : inject + h;
    const raw = Buffer.from(h);
    indexCache = { m: st.mtimeMs, raw, gz: zlib.gzipSync(raw, { level: 9 }) };
  }
  return indexCache;
}

/* ---------- HTTP ---------- */
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function send(res, code, body, headers) {
  res.writeHead(code, { ...SEC, ...headers });
  res.end(body);
}
function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function authed(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') && checkToken(h.slice(7));
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const c = indexHtml();
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      return send(res, 200, gz ? c.gz : c.raw, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
    }
    if (req.method === 'GET' && STATIC[p]) {
      const f = path.join(PUB, p.slice(1));
      if (!fs.existsSync(f)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      return send(res, 200, fs.readFileSync(f), { 'Content-Type': STATIC[p][0], 'Cache-Control': STATIC[p][1] });
    }
    if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(302, { Location: '/icon-192.png' }); return res.end(); }

    if (!p.startsWith('/api/')) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });

    if (p === '/api/health') return json(res, 200, { ok: true, pos: true });

    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (locked(ip)) return json(res, 429, { error: 'terlalu banyak percobaan' });
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      if (!b || typeof b.password !== 'string' || !samePassword(b.password)) { fail(ip); return json(res, 401, { error: 'sandi salah' }); }
      fails.delete(ip);
      return json(res, 200, { token: makeToken(), days: TOKEN_DAYS });
    }

    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });

    if (p === '/api/version' && req.method === 'GET') return json(res, 200, { version: getDoc().version });

    if (p === '/api/data' && req.method === 'GET') {
      const d = getDoc();
      if (u.searchParams.get('since') === String(d.version) && d.version > 0) return json(res, 200, { version: d.version, unchanged: true });
      return json(res, 200, d);
    }
    if (p === '/api/data' && req.method === 'PUT') {
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      if (!b || !validDoc(b.data) || !Number.isInteger(b.baseVersion)) return json(res, 400, { error: 'data tidak valid' });
      const r = saveDoc(b.data, b.baseVersion);
      return json(res, r.conflict ? 409 : 200, r);
    }
    if (p === '/api/export' && req.method === 'GET') {
      const d = getDoc();
      return send(res, 200, JSON.stringify(d.data || {}), { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="pos-sate-${new Date().toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
    }
    if (p === '/api/snapshots' && req.method === 'GET') return json(res, 200, { snapshots: q.snapList.all() });
    const m = p.match(/^\/api\/snapshots\/(\d{4}-\d{2}-\d{2})$/);
    if (m && req.method === 'GET') {
      const r = q.snapGet.get(m[1]);
      return r ? json(res, 200, { version: r.version, data: JSON.parse(r.json) }) : json(res, 404, { error: 'tidak ada' });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    if (e && e.code === 413) return json(res, 413, { error: 'data terlalu besar' });
    console.error(e);
    try { json(res, 500, { error: 'server error' }); } catch (x) {}
  }
});
server.requestTimeout = 60000;
server.listen(PORT, () => console.log(`POS SATE berjalan di http://localhost:${PORT}  (data: ${DATA_DIR})`));

function shutdown() { try { server.close(); db.close(); } catch (e) {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
