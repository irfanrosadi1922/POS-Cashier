'use strict';
/* Tes API server: node test/api.test.js */
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const PORT = 3900 + Math.floor(Math.random() * 90);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-'));
const base = `http://127.0.0.1:${PORT}`;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const doc = (n) => ({ items: [{ id: 'a', name: 'Sate', cat: 'Sate', price: 25000, cost: 12000, stock: 10 }], orders: n ? [{ no: 'INV-1', t: '2026-10-14T10:00:00Z', type: 'Takeaway', method: 'Tunai', total: 27500, tax: 2500, lines: [{ name: 'Sate', qty: 1, price: 25000, cost: 12000 }] }] : [], cats: ['Sate'], log: [], set: { store: 'POS SATE' }, seq: 1 });

(async () => {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DIR, POS_PASSWORD: 'rahasia123' }, stdio: 'inherit' });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch (e) {} await sleep(100); }
    ok((await (await fetch(base + '/api/health')).json()).pos === true, 'health');
    ok((await fetch(base + '/api/data')).status === 401, 'tanpa token ditolak');
    ok((await fetch(base + '/api/data', { headers: { Authorization: 'Bearer palsu.palsu' } })).status === 401, 'token palsu ditolak');
    const bad = await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'salah' }) });
    ok(bad.status === 401, 'sandi salah = 401');
    const lr = await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'rahasia123' }) });
    const tok = (await lr.json()).token;
    ok(lr.status === 200 && !!tok, 'login benar');
    const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
    let r = await (await fetch(base + '/api/data', { headers: H })).json();
    ok(r.version === 0 && r.data === null, 'server kosong: version 0');
    let p = await fetch(base + '/api/data', { method: 'PUT', headers: H, body: JSON.stringify({ baseVersion: 0, data: doc(0) }) });
    ok(p.status === 200 && (await p.json()).version === 1, 'PUT pertama -> version 1');
    p = await fetch(base + '/api/data', { method: 'PUT', headers: H, body: JSON.stringify({ baseVersion: 0, data: doc(1) }) });
    const c = await p.json();
    ok(p.status === 409 && c.conflict && c.version === 1 && c.data.items.length === 1, 'baseVersion lama -> 409 + data server');
    p = await fetch(base + '/api/data', { method: 'PUT', headers: H, body: JSON.stringify({ baseVersion: 1, data: doc(1) }) });
    ok(p.status === 200 && (await p.json()).version === 2, 'PUT dengan baseVersion benar -> version 2');
    p = await fetch(base + '/api/data', { method: 'PUT', headers: H, body: JSON.stringify({ baseVersion: 2, data: { foo: 1 } }) });
    ok(p.status === 400, 'data tidak valid -> 400');
    r = await (await fetch(base + '/api/data?since=2', { headers: H })).json();
    ok(r.unchanged === true, 'since=versi terbaru -> unchanged');
    ok((await (await fetch(base + '/api/version', { headers: H })).json()).version === 2, '/api/version');
    const sn = await (await fetch(base + '/api/snapshots', { headers: H })).json();
    ok(sn.snapshots.length === 1, 'snapshot harian dibuat (1)');
    const day = sn.snapshots[0].day, one = await (await fetch(base + '/api/snapshots/' + day, { headers: H })).json();
    ok(one.version === 1 && one.data.orders.length === 0, 'snapshot = kondisi sebelum perubahan pertama hari itu');
    const ex = await fetch(base + '/api/export', { headers: H });
    ok(ex.status === 200 && /attachment/.test(ex.headers.get('content-disposition')) && (await ex.json()).orders.length === 1, 'export JSON');
    // tabel SQL turunan
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(path.join(DIR, 'pos.db'));
    ok(d.prepare('SELECT COUNT(*) n FROM items').get().n === 1 && d.prepare('SELECT total FROM orders').get().total === 27500 && d.prepare('SELECT COUNT(*) n FROM order_lines').get().n === 1, 'tabel items/orders/order_lines terisi');
    d.close();
    // statis
    const idx = await fetch(base + '/');
    const html = await idx.text();
    ok(idx.status === 200 && /window\.POS_CLOUD=true/.test(html) && /manifest\.webmanifest/.test(html), 'halaman utama disuntik POS_CLOUD + manifest');
    ok((await fetch(base + '/manifest.webmanifest')).status === 200 && (await fetch(base + '/sw.js')).status === 200 && (await fetch(base + '/icon-192.png')).status === 200, 'manifest, sw.js, ikon');
    ok((await fetch(base + '/server.js')).status === 404 && (await fetch(base + '/..%2fserver.js')).status === 404, 'file server tidak bisa diunduh');
    ok(idx.headers.get('x-content-type-options') === 'nosniff', 'header keamanan');
    // batas percobaan login
    let last = 0; for (let i = 0; i < 10; i++) last = (await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ password: 'x' + i }) })).status;
    ok(last === 429, 'terlalu banyak percobaan -> 429');
    ok((await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'rahasia123' }) })).status === 429, 'login benar pun ditahan saat terkunci');
    // data bertahan setelah restart
    srv.kill('SIGTERM'); await sleep(500);
    const srv2 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: PORT + 1000, DATA_DIR: DIR, POS_PASSWORD: 'rahasia123' }, stdio: 'inherit' });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT + 1000}/api/health`)).ok) break; } catch (e) {} await sleep(100); }
    const t2 = (await (await fetch(`http://127.0.0.1:${PORT + 1000}/api/login`, { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'rahasia123' }) })).json()).token;
    ok(t2 === tok || !!t2, 'login setelah restart');
    const after = await (await fetch(`http://127.0.0.1:${PORT + 1000}/api/data`, { headers: { Authorization: 'Bearer ' + tok } })).json();
    ok(after.version === 2 && after.data.orders.length === 1, 'data & token lama tetap berlaku setelah restart');
    srv2.kill('SIGTERM');
    // tanpa sandi: tidak mau start
    const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-empty-'));
    const bare = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: PORT + 2000, DATA_DIR: EMPTY, POS_PASSWORD: '' }, stdio: 'ignore' });
    const code = await new Promise((r) => bare.on('exit', r));
    ok(code === 1, 'pertama kali tanpa POS_PASSWORD: server menolak jalan');
    const srv3 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: PORT + 3000, DATA_DIR: DIR, POS_PASSWORD: '' }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT + 3000}/api/health`)).ok) break; } catch (e) {} await sleep(100); }
    ok((await fetch(`http://127.0.0.1:${PORT + 3000}/api/health`)).ok, 'setelah akun owner ada, server jalan tanpa POS_PASSWORD');
    srv3.kill('SIGTERM'); fs.rmSync(EMPTY, { recursive: true, force: true });
  } catch (e) { console.error(e); fails = 1; }
  try { srv.kill('SIGTERM'); } catch (e) {}
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(fails ? 'SOME FAILED' : 'ALL PASSED'); process.exit(fails);
})();
