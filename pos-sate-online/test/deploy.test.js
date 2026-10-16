'use strict';
/* Tes mode komputer toko + Cloudflare Tunnel: node test/deploy.test.js */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const NODE = ['--disable-warning=ExperimentalWarning'];

/* salinan server di folder sementara agar .env-nya tidak mengganggu proyek asli */
function setup(envText) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-dep-'));
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(d, 'server.js'));
  fs.symlinkSync(path.join(ROOT, 'public'), path.join(d, 'public'));
  if (envText != null) fs.writeFileSync(path.join(d, '.env'), envText);
  return d;
}
async function run(dir, env, fn) {
  const port = 3700 + Math.floor(Math.random() * 90);
  const srv = spawn(process.execPath, [...NODE, path.join(dir, 'server.js')], { cwd: dir, env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: path.join(dir, 'data'), ...env }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch (e) {} await sleep(100); }
    await fn(base);
  } finally { srv.kill(); }
}
const login = (base, user, pw, hdr) => fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(hdr || {}) }, body: JSON.stringify({ username: user, password: pw }) });

(async () => {
  // 1) .env dibaca tanpa Docker
  let d = setup('# komentar\nPOS_PASSWORD="sandi-dari-env-1"\nSTORE_TZ=Asia/Kuala_Lumpur\n');
  await run(d, {}, async (base) => {
    ok((await login(base, 'owner', 'sandi-dari-env-1')).status === 200, '.env dibaca: owner login dengan sandi dari .env (tanda kutip dibuang)');
    ok((await login(base, 'owner', '"sandi-dari-env-1"')).status === 401, '.env: sandi tidak memuat tanda kutip');
  });
  // 2) variabel lingkungan menang atas .env
  d = setup('POS_PASSWORD=dari-env-file\n');
  await run(d, { POS_PASSWORD: 'dari-lingkungan-9' }, async (base) => {
    ok((await login(base, 'owner', 'dari-lingkungan-9')).status === 200, 'variabel lingkungan lebih diutamakan daripada .env');
  });
  // 3) sandi contoh ditolak
  d = setup('POS_PASSWORD=ganti-dengan-sandi-yang-kuat\n');
  const r = spawnSync(process.execPath, [...NODE, path.join(d, 'server.js')], { cwd: d, env: { PATH: process.env.PATH, PORT: '3799', DATA_DIR: path.join(d, 'data') }, encoding: 'utf8', timeout: 8000 });
  ok(r.status === 1 && /POS_PASSWORD/.test(r.stderr), 'sandi contoh dari .env.example ditolak, server tidak jalan');
  // 4) Cloudflare: IP dari CF-Connecting-IP, tidak bisa dipalsukan lewat X-Forwarded-For
  d = setup('POS_PASSWORD=sandi-uji-cf-1\n');
  await run(d, { TRUST_PROXY: 'cloudflare' }, async (base) => {
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await login(base, 'owner', 'salah', { 'CF-Connecting-IP': '9.9.9.9', 'X-Forwarded-For': '10.0.0.' + i })).status;
    ok(last === 429, 'cloudflare: percobaan gagal dari satu IP asli terkunci walau X-Forwarded-For diganti-ganti');
    ok((await login(base, 'owner', 'sandi-uji-cf-1', { 'CF-Connecting-IP': '8.8.8.8' })).status === 200, 'cloudflare: pelanggan lain dengan IP berbeda tidak ikut terkunci');
    ok((await login(base, 'owner', 'sandi-uji-cf-1', { 'CF-Connecting-IP': '9.9.9.9' })).status === 429, 'cloudflare: IP yang terkunci tetap ditolak walau sandinya benar');
  });
  // 5) tanpa mode proxy, header IP palsu diabaikan
  d = setup('POS_PASSWORD=sandi-uji-cf-1\n');
  await run(d, {}, async (base) => {
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await login(base, 'owner', 'salah', { 'CF-Connecting-IP': '7.7.7.' + i })).status;
    ok(last === 429, 'tanpa TRUST_PROXY: header CF-Connecting-IP palsu diabaikan (tidak bisa menghindari pembatas)');
  });
  console.log(fails ? 'ADA YANG GAGAL' : 'ALL PASSED');
  process.exit(fails);
})();
