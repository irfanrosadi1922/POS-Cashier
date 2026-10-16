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

/* muat file .env di samping server.js (opsional) supaya bisa dijalankan tanpa Docker: node server.js */
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2]; if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch (e) { /* tidak ada .env: pakai variabel lingkungan */ }

const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PASSWORD = process.env.POS_PASSWORD || '';
const TRUST_MODE = process.env.TRUST_PROXY || ''; // '1' = di belakang proxy (Caddy), 'cloudflare' = lewat Cloudflare Tunnel
const TRUST_PROXY = TRUST_MODE === '1' || TRUST_MODE === 'cloudflare';
const PLACEHOLDER_PW = 'ganti-dengan-sandi-yang-kuat';
const MAX_BODY = 40 * 1024 * 1024;
const TOKEN_DAYS = 90;

fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

/* ---------- rahasia penanda token ---------- */
let SECRET = process.env.POS_SECRET || '';
if (!SECRET) {
  const f = path.join(DATA_DIR, 'secret.key');
  try { SECRET = fs.readFileSync(f, 'utf8').trim(); } catch (e) {}
  if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, SECRET, { mode: 0o600 }); }
}
const b64 = (b) => Buffer.from(b).toString('base64url');
const mac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(u) {
  const p = b64(JSON.stringify({ u: u.id, tv: u.tv, exp: Date.now() + TOKEN_DAYS * 864e5 }));
  return p + '.' + mac(p);
}
/* ---------- sandi: scrypt + garam acak ---------- */
const scryptP = (pw, salt) => new Promise((res, rej) => crypto.scrypt(String(pw), Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k.toString('hex')))));
async function hashPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: await scryptP(pw, salt) }; }
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
async function checkPw(user, pw) { // selalu menjalankan scrypt agar waktu respons tidak membocorkan keberadaan username
  const h = await scryptP(pw, user ? user.salt : DUMMY_SALT);
  if (!user) return false;
  const a = Buffer.from(h, 'hex'), b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const PERMS = ['co', 'inv', 'hist', 'prn', 'set'];
const DEFAULT_STAFF_PERMS = ['co', 'prn'];
const cleanPerms = (a) => [...new Set((Array.isArray(a) ? a : []).filter((x) => PERMS.includes(x)))];
const userPerms = (u) => (u.role === 'owner' ? PERMS.slice() : cleanPerms(JSON.parse(u.perms || '[]')));
const can = (u, p) => u.role === 'owner' || userPerms(u).includes(p);
const meView = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, perms: userPerms(u), active: !!u.active, lastLogin: u.last_login || '', createdAt: u.created_at });

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
CREATE TABLE IF NOT EXISTS co(id INTEGER PRIMARY KEY AUTOINCREMENT, tok TEXT UNIQUE NOT NULL, idem TEXT, day TEXT, num TEXT, name TEXT, tbl TEXT, type TEXT, note TEXT, lines TEXT, sub REAL, tax REAL, total REAL, status TEXT, printed INTEGER DEFAULT 0, claim_at INTEGER DEFAULT 0, sale_no TEXT, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_co_status ON co(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_co_idem ON co(idem) WHERE idem IS NOT NULL;
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, perms TEXT NOT NULL DEFAULT '[]', salt TEXT NOT NULL, hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, tv INTEGER NOT NULL DEFAULT 1, created_at TEXT, last_login TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, uid INTEGER, uname TEXT, action TEXT, detail TEXT);
`);
const uq = {
  count: db.prepare('SELECT COUNT(*) AS n FROM users'),
  byName: db.prepare('SELECT * FROM users WHERE username=?'),
  byId: db.prepare('SELECT * FROM users WHERE id=?'),
  list: db.prepare('SELECT * FROM users ORDER BY (role=\'owner\') DESC, username'),
  ins: db.prepare('INSERT INTO users(username,name,role,perms,salt,hash,active,tv,created_at) VALUES(?,?,?,?,?,?,1,1,?)'),
  upd: db.prepare('UPDATE users SET name=?, role=?, perms=?, active=?, tv=? WHERE id=?'),
  setPw: db.prepare('UPDATE users SET salt=?, hash=?, tv=tv+1 WHERE id=?'),
  del: db.prepare('DELETE FROM users WHERE id=?'),
  login: db.prepare('UPDATE users SET last_login=? WHERE id=?'),
  owners: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='owner' AND active=1"),
  firstOwner: db.prepare("SELECT * FROM users WHERE role='owner' ORDER BY id LIMIT 1"),
  aud: db.prepare('INSERT INTO audit(t,uid,uname,action,detail) VALUES(?,?,?,?,?)'),
  audList: db.prepare('SELECT t,uname,action,detail FROM audit ORDER BY id DESC LIMIT 100'),
  audPrune: db.prepare('DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 2000)'),
};
const audit = (u, action, detail) => { try { uq.aud.run(new Date().toISOString(), u ? u.id : null, u ? u.username : '', action, String(detail || '').slice(0, 300)); } catch (e) {} };
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,23}$/;

/* pertama kali jalan: akun owner dibuat dari POS_PASSWORD */
(() => {
  if (!uq.count.get().n) {
    if (!PASSWORD || PASSWORD.length < 6 || PASSWORD === PLACEHOLDER_PW) {
      console.error('\n[POS SATE] Pertama kali jalan: atur POS_PASSWORD="sandi-anda" (minimal 6 karakter). Sandi ini menjadi sandi akun owner (username: owner).\n');
      process.exit(1);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    uq.ins.run('owner', 'Owner', 'owner', '[]', salt, crypto.scryptSync(PASSWORD, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex'), new Date().toISOString());
    console.log('[POS SATE] Akun owner dibuat. Login dengan username "owner" dan sandi POS_PASSWORD.');
  } else if (process.env.RESET_OWNER_PASSWORD === '1') { // pemulihan bila sandi owner lupa
    if (!PASSWORD || PASSWORD.length < 6 || PASSWORD === PLACEHOLDER_PW) { console.error('[POS SATE] RESET_OWNER_PASSWORD=1 butuh POS_PASSWORD baru (minimal 6 karakter, bukan sandi contoh).'); process.exit(1); }
    const o = uq.firstOwner.get(), salt = crypto.randomBytes(16).toString('hex');
    uq.setPw.run(salt, crypto.scryptSync(PASSWORD, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex'), o.id);
    db.prepare('UPDATE users SET active=1 WHERE id=?').run(o.id);
    audit(null, 'reset-owner', 'sandi owner (' + o.username + ') direset lewat RESET_OWNER_PASSWORD');
    console.log('[POS SATE] Sandi owner "' + o.username + '" direset. Hapus RESET_OWNER_PASSWORD dari pengaturan lalu jalankan ulang.');
  }
})();
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
  if (TRUST_MODE === 'cloudflare') { const c = String(req.headers['cf-connecting-ip'] || '').trim(); if (c) return c; } // diisi Cloudflare, tidak bisa dipalsukan klien
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

/* ---------- halaman pelanggan (QR) ---------- */
const pageCache = new Map();
function pageHtml(file) {
  const f = path.join(PUB, file), st = fs.statSync(f), c = pageCache.get(file);
  if (c && c.m === st.mtimeMs) return c;
  const raw = fs.readFileSync(f), n = { m: st.mtimeMs, raw, gz: zlib.gzipSync(raw, { level: 9 }) };
  pageCache.set(file, n);
  return n;
}

/* ---------- pesanan pelanggan ---------- */
const STORE_TZ = process.env.STORE_TZ || 'Asia/Jakarta';
const dayStr = (d) => { try { return d.toLocaleDateString('sv-SE', { timeZone: STORE_TZ }); } catch (e) { return d.toISOString().slice(0, 10); } };
const coq = {
  ins: db.prepare('INSERT INTO co(tok,idem,day,num,name,tbl,type,note,lines,sub,tax,total,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
  byIdem: db.prepare('SELECT * FROM co WHERE idem=?'),
  byTok: db.prepare('SELECT * FROM co WHERE tok=?'),
  byId: db.prepare('SELECT * FROM co WHERE id=?'),
  cntDay: db.prepare('SELECT COUNT(*) AS n FROM co WHERE day=?'),
  cntNew: db.prepare("SELECT COUNT(*) AS n FROM co WHERE status='new'"),
  list: db.prepare("SELECT * FROM co WHERE status IN ('new','accepted') OR updated_at>? ORDER BY id DESC LIMIT 200"),
  setStatus: db.prepare('UPDATE co SET status=?, sale_no=COALESCE(?,sale_no), updated_at=? WHERE id=?'),
  prune: db.prepare("DELETE FROM co WHERE status IN ('done','cancelled') AND updated_at<?"),
  claim: db.prepare('UPDATE co SET printed=1, claim_at=? WHERE id=? AND (printed=0 OR (printed=1 AND claim_at<?))'),
  prDone: db.prepare('UPDATE co SET printed=2 WHERE id=?'),
  prRel: db.prepare('UPDATE co SET printed=0 WHERE id=? AND printed=1'),
  kvGet: db.prepare('SELECT v FROM kv WHERE k=?'),
  kvSet: db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
  ver: db.prepare('SELECT version FROM doc WHERE id=1'),
};
function coSettings() {
  let o = {}; try { const r = coq.kvGet.get('co'); if (r) o = JSON.parse(r.v); } catch (e) {}
  return { on: o.on !== false, msg: String(o.msg || '').slice(0, 200) };
}
let coRev = Date.now();
const waiters = new Set();
function coBump() {
  coRev++;
  for (const w of [...waiters]) { clearTimeout(w.t); waiters.delete(w); w.fn(); }
}
const staffView = (r) => ({ id: r.id, num: r.num, name: r.name, tbl: r.tbl, type: r.type, note: r.note, lines: JSON.parse(r.lines), sub: r.sub, tax: r.tax, total: r.total, status: r.status, printed: r.printed, saleNo: r.sale_no || '', t: r.created_at, u: r.updated_at });
const custView = (r) => ({ num: r.num, name: r.name, tbl: r.tbl, type: r.type, note: r.note, lines: JSON.parse(r.lines), total: r.total, sub: r.sub, tax: r.tax, status: r.status, t: r.created_at });

/* menu publik: dibangun ulang hanya saat data berubah; gambar disajikan terpisah (bisa di-cache) */
let pub = { ver: -1, menu: null, imgs: new Map() };
function pubBuild() {
  const r = coq.ver.get(), ver = r ? r.version : 0;
  if (pub.ver === ver) return pub;
  const d = ver ? getDoc().data : null;
  const imgs = new Map();
  if (!d) { pub = { ver, menu: null, imgs }; return pub; }
  const putImg = (key, data) => {
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
    if (!m) return '';
    const buf = Buffer.from(m[2], 'base64'), h = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
    imgs.set(key, { type: m[1], buf });
    return `/img/${key}?v=${h}`;
  };
  const s = d.set || {};
  const items = d.items.map((i) => ({ id: String(i.id), name: String(i.name || ''), cat: String(i.cat || ''), price: num(i.price), stock: Math.max(0, Math.floor(num(i.stock))), emoji: String(i.emoji || '🍽️').slice(0, 8), img: /^[\w-]+$/.test(String(i.id)) ? putImg(String(i.id), i.img) : '' }));
  const used = new Set(items.map((i) => i.cat));
  pub = {
    ver, imgs,
    doc: { items: new Map(items.map((i) => [i.id, i])), tax: num(s.tax), dec: Math.max(0, Math.min(4, num(s.dec))) },
    menu: {
      store: String(s.store || 'POS SATE'), logo: putImg('logo', s.logo) || '/icon-192.png',
      cur: String(s.cur || 'Rp'), curPos: s.curPos === 'after' ? 'after' : 'before', dec: Math.max(0, Math.min(4, num(s.dec))), loc: String(s.loc || 'id-ID'),
      tax: num(s.tax), cats: (d.cats || []).filter((c) => used.has(c)).concat([...used].filter((c) => !(d.cats || []).includes(c))), items,
    },
  };
  return pub;
}
const ORDER_RATE = Math.max(1, +process.env.ORDER_RATE || 40); // pesanan per 10 menit per IP (pelanggan satu Wi-Fi berbagi IP)
const orderHits = new Map();
function orderLimited(ip) {
  const now = Date.now(), a = (orderHits.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  if (a.length >= ORDER_RATE) { orderHits.set(ip, a); return true; }
  a.push(now); orderHits.set(ip, a); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of orderHits) if (!a.some((t) => now - t < 10 * 60e3)) orderHits.delete(k); }, 600e3).unref();
setInterval(() => { try { coq.prune.run(new Date(Date.now() - 30 * 864e5).toISOString()); uq.audPrune.run(); } catch (e) {} }, 6 * 3600e3).unref();
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function createOrder(b, ip) {
  const st = coSettings();
  if (!st.on) return [403, { error: 'closed', msg: st.msg }];
  const P = pubBuild();
  if (!P.menu) return [503, { error: 'belum siap' }];
  if (b && b.website) return [400, { error: 'ditolak' }]; // honeypot
  const name = clean(b && b.name, 40);
  if (!name) return [400, { error: 'Nama wajib diisi' }];
  const key = clean(b && b.key, 64) || null;
  if (key) { const ex = coq.byIdem.get(key); if (ex) return [200, { tok: ex.tok, ...custView(ex), dup: true }]; }
  if (orderLimited(ip)) return [429, { error: 'Terlalu banyak pesanan. Coba lagi beberapa menit lagi.' }];
  if (coq.cntNew.get().n >= 300) return [429, { error: 'Antrean penuh, mohon panggil pelayan.' }];
  if (!b || !Array.isArray(b.items) || !b.items.length || b.items.length > 60) return [400, { error: 'Pesanan kosong' }];
  const merged = new Map();
  for (const it of b.items) {
    const id = String(it && it.id), qty = Math.floor(+(it && it.qty));
    if (!P.doc.items.has(id) || !(qty >= 1)) return [400, { error: 'Item tidak valid' }];
    merged.set(id, Math.min(99, (merged.get(id) || 0) + qty));
  }
  const dec = P.doc.dec, rnd = (v) => Math.round(v * 10 ** dec) / 10 ** dec;
  const lines = []; let sub = 0;
  for (const [id, qty] of merged) {
    const i = P.doc.items.get(id);
    if (i.stock < qty) return [409, { error: i.stock <= 0 ? `${i.name} sudah habis` : `${i.name} tinggal ${i.stock}`, id, stock: i.stock }];
    lines.push({ id, name: i.name, price: i.price, qty });
    sub += i.price * qty;
  }
  sub = rnd(sub);
  const tax = rnd(sub * P.doc.tax / 100), total = rnd(sub + tax);
  const now = new Date(), day = dayStr(now), n = coq.cntDay.get(day).n + 1;
  const num = '#' + String(n).padStart(3, '0'), tok = crypto.randomBytes(16).toString('base64url');
  const type = b.type === 'Dine In' ? 'Dine In' : 'Takeaway';
  const r = coq.ins.run(tok, key, day, num, name, clean(b.table, 12), type, clean(b.note, 200), JSON.stringify(lines), sub, tax, total, 'new', now.toISOString(), now.toISOString());
  coBump();
  return [200, { tok, ...custView(coq.byId.get(Number(r.lastInsertRowid))) }];
}

/* ---------- penjaga akses tulis data (karyawan) ----------
 * Aplikasi menyinkronkan satu dokumen utuh, jadi server membandingkan dokumen baru dengan yang sekarang
 * dan menolak perubahan di luar izin karyawan. Owner tidak dibatasi. */
function sj(v) {
  if (v && typeof v === 'object') { if (Array.isArray(v)) return '[' + v.map(sj).join(',') + ']'; return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + sj(v[k])).join(',') + '}'; }
  return JSON.stringify(v);
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/* true bila b sama dengan a, kecuali boleh ada kunci BARU di b (default hasil migrasi aplikasi) */
function additiveOnly(a, b) {
  if (isObj(a) && isObj(b)) { for (const k of Object.keys(a)) { if (!(k in b) || !additiveOnly(a[k], b[k])) return false; } return true; }
  return sj(a) === sj(b);
}
const SET_FREE = new Set(['gv', 'lang', 'fsAuto', 'logoInit', 'logoApp']); // preferensi tampilan per perangkat
function guardWrite(me, cur, next) {
  if (me.role === 'owner') return null;
  if (!cur) return 'Hanya owner yang boleh menyiapkan data awal';
  const perms = userPerms(me), has = (k) => perms.includes(k);
  const co = new Map((cur.orders || []).map((o) => [String(o.no), sj(o)])), nn = new Map((next.orders || []).map((o) => [String(o.no), sj(o)]));
  for (const [k, v] of co) if (nn.get(k) !== v) return 'Riwayat penjualan hanya bisa ditambah, tidak boleh diubah atau dihapus (khusus owner)';
  if (!has('inv')) {
    const ci = new Map(cur.items.map((i) => [String(i.id), i])), ni = new Map(next.items.map((i) => [String(i.id), i]));
    if (ci.size !== ni.size) return 'Anda tidak punya izin menambah/menghapus menu';
    for (const [id, c] of ci) {
      const n = ni.get(id);
      if (!n) return 'Anda tidak punya izin menghapus menu';
      for (const k of Object.keys(c)) if (k !== 'stock' && !additiveOnly(c[k], n[k])) return 'Anda tidak punya izin mengubah menu/harga: ' + String(c.name || id);
    }
    if (sj([...(cur.cats || [])].sort()) !== sj([...(next.cats || [])].sort())) return 'Anda tidak punya izin mengubah kategori';
  }
  for (const k of Object.keys(cur.set || {})) {
    const a = cur.set[k], b = (next.set || {})[k];
    if (b !== undefined && additiveOnly(a, b)) continue;
    if (SET_FREE.has(k) || has('set') || (k === 'prn' && has('prn'))) continue;
    return 'Anda tidak punya izin mengubah pengaturan (' + k + ')';
  }
  return null;
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
function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > max) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function authUser(req) {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Bearer ')) return null;
  const t = h.slice(7), [p, m] = t.split('.');
  if (!p || !m) return null;
  const e = mac(p);
  if (e.length !== m.length || !crypto.timingSafeEqual(Buffer.from(e), Buffer.from(m))) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (!(o.exp > Date.now())) return null;
    const u = uq.byId.get(o.u);
    return u && u.active && u.tv === o.tv ? u : null; // sandi diganti / akun dinonaktifkan / peran berubah = token lama mati
  } catch (e) { return null; }
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
    if (req.method === 'GET' && (p === '/order' || p === '/pesan' || p === '/o')) {
      const c = pageHtml('order.html'), gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      return send(res, 200, gz ? c.gz : c.raw, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex', ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
    }
    const im = req.method === 'GET' && p.match(/^\/img\/([\w-]+)$/);
    if (im) {
      const g = pubBuild().imgs.get(im[1]);
      if (!g) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      return send(res, 200, g.buf, { 'Content-Type': g.type, 'Cache-Control': 'public, max-age=31536000, immutable' });
    }
    if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(302, { Location: '/icon-192.png' }); return res.end(); }

    if (!p.startsWith('/api/')) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });

    if (p === '/api/health') return json(res, 200, { ok: true, pos: true });

    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (locked(ip)) return json(res, 429, { error: 'terlalu banyak percobaan' });
      let b; try { b = JSON.parse(await readBody(req, 4096)); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const un = String((b && b.username) || '').trim().toLowerCase(), user = un ? uq.byName.get(un) : null;
      const good = typeof (b && b.password) === 'string' && await checkPw(user, b.password);
      if (!good) { fail(ip); audit(null, 'login-gagal', un + ' dari ' + ip); return json(res, 401, { error: 'username atau sandi salah' }); }
      fails.delete(ip);
      if (!user.active) return json(res, 403, { error: 'Akun dinonaktifkan. Hubungi owner.' });
      uq.login.run(new Date().toISOString(), user.id);
      audit(user, 'login', ip);
      return json(res, 200, { token: makeToken(user), days: TOKEN_DAYS, me: meView(uq.byId.get(user.id)) });
    }

    /* ----- publik (pelanggan, tanpa login) ----- */
    if (p === '/api/public/menu' && req.method === 'GET') {
      const P = pubBuild(), st = coSettings();
      if (!P.menu) return json(res, 503, { error: 'belum siap' });
      return json(res, 200, { ...P.menu, open: st.on, msg: st.msg });
    }
    if (p === '/api/public/order' && req.method === 'POST') {
      let b; try { b = JSON.parse(await readBody(req, 30 * 1024)); } catch (e) { return json(res, e && e.code === 413 ? 413 : 400, { error: 'bad json' }); }
      const [code, out] = createOrder(b, clientIp(req));
      return json(res, code, out);
    }
    const pm = p.match(/^\/api\/public\/order\/([\w-]{10,40})(\/cancel)?$/);
    if (pm) {
      const r = coq.byTok.get(pm[1]);
      if (!r) return json(res, 404, { error: 'tidak ada' });
      if (pm[2]) {
        if (req.method !== 'POST') return json(res, 405, { error: 'method' });
        if (r.status !== 'new') return json(res, 409, { error: 'Pesanan sudah diproses, hubungi kasir.', status: r.status });
        coq.setStatus.run('cancelled', null, new Date().toISOString(), r.id); coBump();
        return json(res, 200, custView(coq.byId.get(r.id)));
      }
      if (req.method === 'GET') return json(res, 200, custView(r));
    }

    const me = authUser(req);
    if (!me) return json(res, 401, { error: 'unauthorized' });
    const forbid = (m) => json(res, 403, { error: m || 'Anda tidak punya akses untuk ini' });
    const isOwner = me.role === 'owner';
    const rd = async (max) => { try { return JSON.parse((await readBody(req, max || 20 * 1024)) || '{}') || {}; } catch (e) { return null; } };

    /* ----- akun saya ----- */
    if (p === '/api/me' && req.method === 'GET') return json(res, 200, meView(me));
    if (p === '/api/me/password' && req.method === 'POST') {
      const b = await rd(); if (!b) return json(res, 400, { error: 'bad json' });
      if (typeof b.new !== 'string' || b.new.length < 6) return json(res, 400, { error: 'Sandi baru minimal 6 karakter' });
      if (!(await checkPw(me, String(b.old || '')))) return json(res, 403, { error: 'Sandi lama salah' });
      const h = await hashPw(b.new); uq.setPw.run(h.salt, h.hash, me.id);
      audit(me, 'ganti-sandi', '');
      return json(res, 200, { token: makeToken(uq.byId.get(me.id)) });
    }

    /* ----- kelola pengguna (khusus owner) ----- */
    if (p === '/api/users' && req.method === 'GET') { if (!isOwner) return forbid(); return json(res, 200, { users: uq.list.all().map(meView), perms: PERMS }); }
    if (p === '/api/users' && req.method === 'POST') {
      if (!isOwner) return forbid();
      const b = await rd(); if (!b) return json(res, 400, { error: 'bad json' });
      const un = String(b.username || '').trim().toLowerCase(), name = clean(b.name, 40) || un;
      if (!USERNAME_RE.test(un)) return json(res, 400, { error: 'Username 3-24 karakter: huruf kecil, angka, titik, strip, garis bawah' });
      if (typeof b.password !== 'string' || b.password.length < 6) return json(res, 400, { error: 'Sandi minimal 6 karakter' });
      if (uq.byName.get(un)) return json(res, 409, { error: 'Username sudah dipakai' });
      const role = b.role === 'owner' ? 'owner' : 'staff', perms = role === 'owner' ? [] : cleanPerms(b.perms == null ? DEFAULT_STAFF_PERMS : b.perms), h = await hashPw(b.password);
      const r = uq.ins.run(un, name, role, JSON.stringify(perms), h.salt, h.hash, new Date().toISOString());
      audit(me, 'tambah-user', un + ' (' + role + ')');
      return json(res, 200, meView(uq.byId.get(Number(r.lastInsertRowid))));
    }
    const um = p.match(/^\/api\/users\/(\d+)$/);
    if (um) {
      if (!isOwner) return forbid();
      const t = uq.byId.get(+um[1]);
      if (!t) return json(res, 404, { error: 'pengguna tidak ada' });
      if (req.method === 'DELETE') {
        if (t.id === me.id) return json(res, 400, { error: 'Tidak bisa menghapus akun sendiri' });
        if (t.role === 'owner' && t.active && uq.owners.get().n <= 1) return json(res, 400, { error: 'Harus ada minimal satu owner aktif' });
        uq.del.run(t.id); audit(me, 'hapus-user', t.username);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PUT') {
        const b = await rd(); if (!b) return json(res, 400, { error: 'bad json' });
        const role = b.role === undefined ? t.role : (b.role === 'owner' ? 'owner' : 'staff');
        const active = b.active === undefined ? !!t.active : !!b.active;
        const name = b.name === undefined ? t.name : (clean(b.name, 40) || t.name);
        const perms = role === 'owner' ? [] : cleanPerms(b.perms === undefined ? JSON.parse(t.perms || '[]') : b.perms);
        const losesOwner = t.role === 'owner' && t.active && (role !== 'owner' || !active);
        if (losesOwner && uq.owners.get().n <= 1) return json(res, 400, { error: 'Harus ada minimal satu owner aktif' });
        if (t.id === me.id && (role !== 'owner' || !active)) return json(res, 400, { error: 'Tidak bisa menurunkan/menonaktifkan akun sendiri' });
        const tv = (role !== t.role || (!active && t.active)) ? t.tv + 1 : t.tv; // peran berubah / dinonaktifkan: paksa login ulang
        uq.upd.run(name, role, JSON.stringify(perms), active ? 1 : 0, tv, t.id);
        if (b.password !== undefined) {
          if (typeof b.password !== 'string' || b.password.length < 6) return json(res, 400, { error: 'Sandi minimal 6 karakter' });
          const h = await hashPw(b.password); uq.setPw.run(h.salt, h.hash, t.id);
          audit(me, 'reset-sandi', t.username);
        }
        audit(me, 'ubah-user', t.username + ' role=' + role + ' aktif=' + (active ? 1 : 0) + ' izin=' + perms.join(','));
        return json(res, 200, meView(uq.byId.get(t.id)));
      }
    }
    if (p === '/api/audit' && req.method === 'GET') { if (!isOwner) return forbid(); return json(res, 200, { log: uq.audList.all() }); }

    /* ----- kasir: pesanan pelanggan ----- */
    if (p.startsWith('/api/co') && !can(me, 'co')) return forbid('Anda tidak punya izin Pesanan Online');
    if (p === '/api/co' && req.method === 'GET') {
      const rev = +u.searchParams.get('rev') || 0, wait = Math.min(25, +u.searchParams.get('wait') || 0);
      const out = () => json(res, 200, { rev: coRev, set: coSettings(), orders: coq.list.all(new Date(Date.now() - 2 * 864e5).toISOString()).map(staffView) });
      if (rev !== coRev || !wait) return out();
      const w = { fn: out, t: setTimeout(() => { waiters.delete(w); json(res, 200, { rev: coRev, unchanged: true }); }, wait * 1000) };
      waiters.add(w);
      req.on('close', () => { clearTimeout(w.t); waiters.delete(w); });
      return;
    }
    if (p === '/api/co/settings' && req.method === 'PUT') {
      if (!can(me, 'set')) return forbid('Hanya owner atau pengguna dengan izin Pengaturan yang boleh membuka/menutup pemesanan');
      let b; try { b = JSON.parse(await readBody(req, 10 * 1024)); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      coq.kvSet.run('co', JSON.stringify({ on: !(b && b.on === false), msg: clean(b && b.msg, 200) }));
      coBump();
      return json(res, 200, coSettings());
    }
    const cm = p.match(/^\/api\/co\/(\d+)(?:\/(print))?$/);
    if (cm && req.method === 'POST') {
      const r = coq.byId.get(+cm[1]);
      if (!r) return json(res, 404, { error: 'tidak ada' });
      let b = {}; try { b = JSON.parse((await readBody(req, 10 * 1024)) || '{}') || {}; } catch (e) { return json(res, 400, { error: 'bad json' }); }
      if (cm[2]) {
        if (b.action === 'claim') {
          const x = coq.claim.run(Date.now(), r.id, Date.now() - 90e3);
          return json(res, 200, { ok: x.changes === 1 });
        }
        if (b.action === 'done') coq.prDone.run(r.id);
        else if (b.action === 'release') coq.prRel.run(r.id);
        else if (b.action === 'reset') db.prepare('UPDATE co SET printed=0 WHERE id=?').run(r.id);
        else return json(res, 400, { error: 'aksi?' });
        coBump();
        return json(res, 200, { ok: true });
      }
      const to = { accept: 'accepted', cancel: 'cancelled', done: 'done' }[b.action];
      if (!to) return json(res, 400, { error: 'aksi?' });
      if (r.status === 'done' || r.status === 'cancelled') return json(res, 409, { error: 'sudah selesai', status: r.status });
      coq.setStatus.run(to, b.saleNo ? clean(b.saleNo, 40) : null, new Date().toISOString(), r.id);
      coBump();
      return json(res, 200, staffView(coq.byId.get(r.id)));
    }

    if (p === '/api/version' && req.method === 'GET') return json(res, 200, { version: getDoc().version });

    if (p === '/api/data' && req.method === 'GET') {
      const d = getDoc();
      if (u.searchParams.get('since') === String(d.version) && d.version > 0) return json(res, 200, { version: d.version, unchanged: true });
      return json(res, 200, d);
    }
    if (p === '/api/data' && req.method === 'PUT') {
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      if (!b || !validDoc(b.data) || !Number.isInteger(b.baseVersion)) return json(res, 400, { error: 'data tidak valid' });
      const cur0 = getDoc(), gerr = guardWrite(me, cur0.data, b.data);
      if (gerr) { audit(me, 'ditolak', gerr); return json(res, 403, { error: gerr }); }
      const r = saveDoc(b.data, b.baseVersion);
      return json(res, r.conflict ? 409 : 200, r);
    }
    if ((p === '/api/export' || p.startsWith('/api/snapshots')) && !isOwner) return forbid('Khusus owner');
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
