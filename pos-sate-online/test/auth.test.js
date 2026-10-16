'use strict';
/* Tes akun, peran, dan izin: node test/auth.test.js */
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const PORT = 3600 + Math.floor(Math.random() * 90);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-auth-'));
const base = `http://127.0.0.1:${PORT}`;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json' };
const call = (m, u, b, tok) => fetch(base + u, { method: m, headers: { ...J, ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
const doc = () => ({
  items: [{ id: 'a', name: 'Sate', cat: 'Sate', price: 25000, cost: 12000, stock: 10 }, { id: 'b', name: 'Teh', cat: 'Minum', price: 5000, cost: 1000, stock: 20 }],
  orders: [{ no: 'INV-1', t: '2026-10-14T10:00:00Z', type: 'Takeaway', method: 'Tunai', total: 27500, tax: 2500, lines: [{ name: 'Sate', qty: 1, price: 25000, cost: 12000 }] }],
  cats: ['Sate', 'Minum'], log: [], set: { store: 'POS SATE', tax: 10, lang: 'id', gv: { cols: 2 }, prn: { mode: 'browser' } }, seq: 2,
});
const clone = (o) => JSON.parse(JSON.stringify(o));
let srv;
async function start(env) {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DIR, ORDER_RATE: '1000', ...env }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/health')).ok) return; } catch (e) {} await sleep(100); }
}
const login = async (u, p) => { const r = await call('POST', '/api/login', { username: u, password: p }); return { status: r.status, j: await r.json() }; };

(async () => {
  await start({ POS_PASSWORD: 'rahasia123' });
  try {
    /* ----- login ----- */
    let r = await login('owner', 'salah');
    ok(r.status === 401 && /salah/.test(r.j.error), 'sandi salah ditolak');
    r = await login('tidakada', 'rahasia123');
    const r2 = await login('owner', 'salah');
    ok(r.status === 401 && r.j.error === r2.j.error, 'username tidak ada & sandi salah memberi pesan sama (tidak membocorkan username)');
    r = await call('POST', '/api/login', { password: 'rahasia123' });
    ok(r.status === 401, 'login tanpa username ditolak');
    r = await login('OWNER', 'rahasia123');
    const O = r.j.token;
    ok(r.status === 200 && r.j.me.role === 'owner' && r.j.me.perms.length === 5, 'owner login (username tidak peka huruf besar), semua izin');
    const rawDb = fs.readFileSync(path.join(DIR, 'pos.db')).toString('latin1');
    ok(!rawDb.includes('rahasia123'), 'sandi tidak tersimpan sebagai teks biasa di database');

    /* ----- kelola pengguna ----- */
    r = await call('POST', '/api/users', { username: 'AB', name: 'x', password: 'abcdef' }, O); ok(r.status === 400, 'username terlalu pendek ditolak');
    r = await call('POST', '/api/users', { username: 'kasir1', name: 'Siti', password: '123' }, O); ok(r.status === 400, 'sandi < 6 karakter ditolak');
    r = await call('POST', '/api/users', { username: 'kasir1', name: 'Siti', password: 'sandi-siti' }, O);
    const siti = await r.json();
    ok(r.status === 200 && siti.role === 'staff' && siti.perms.join() === 'co,prn', 'tambah karyawan: izin bawaan = Pesanan Online + Printer');
    r = await call('POST', '/api/users', { username: 'kasir1', name: 'Lain', password: 'sandi-lain' }, O); ok(r.status === 409, 'username kembar ditolak');
    r = await call('POST', '/api/users', { username: 'x y', name: 'Lain', password: 'sandi-lain' }, O); ok(r.status === 400, 'username dengan spasi ditolak');

    /* karyawan sebelum data awal ada */
    const S1 = (await login('kasir1', 'sandi-siti')).j.token;
    r = await call('PUT', '/api/data', { baseVersion: 0, data: doc() }, S1);
    ok(r.status === 403, 'karyawan tidak boleh menyiapkan data awal');
    r = await call('PUT', '/api/data', { baseVersion: 0, data: doc() }, O); ok(r.status === 200, 'owner menyiapkan data awal');
    let ver = 1;

    /* ----- halaman khusus owner ditolak untuk karyawan ----- */
    for (const [m, u] of [['GET', '/api/users'], ['POST', '/api/users'], ['PUT', '/api/users/1'], ['DELETE', '/api/users/1'], ['GET', '/api/audit'], ['GET', '/api/export'], ['GET', '/api/snapshots']]) {
      r = await call(m, u, m === 'GET' ? undefined : {}, S1);
      ok(r.status === 403, `karyawan ditolak: ${m} ${u}`);
    }
    r = await call('GET', '/api/data', undefined, S1); ok(r.status === 200 && (await r.json()).version === ver, 'karyawan boleh membaca data (untuk berjualan)');
    r = await call('GET', '/api/me', undefined, S1); ok((await r.json()).username === 'kasir1', '/api/me menampilkan akun sendiri');

    /* ----- penjaga tulis data ----- */
    const put = async (tok, d) => { const x = await call('PUT', '/api/data', { baseVersion: ver, data: d }, tok); const j = await x.json(); if (x.status === 200) ver = j.version; return { s: x.status, j }; };
    let d = clone(doc()); d.items[0].stock = 9;
    d.orders.unshift({ no: 'INV-2', t: '2026-10-15T10:00:00Z', type: 'Takeaway', method: 'Tunai', total: 27500, tax: 2500, lines: [{ name: 'Sate', qty: 1, price: 25000, cost: 12000 }] });
    d.seq = 3; d.log = [{ t: 'x', name: 'Sate', d: -1 }];
    r = await put(S1, d); ok(r.s === 200, 'karyawan boleh menjual (tambah transaksi + stok berkurang)');
    const base = clone(d);

    d = clone(base); d.items[0].price = 1; r = await put(S1, d); ok(r.s === 403 && /harga|menu/i.test(r.j.error), 'karyawan TIDAK boleh mengubah harga');
    d = clone(base); d.items[0].cost = 1; r = await put(S1, d); ok(r.s === 403, 'karyawan TIDAK boleh mengubah modal');
    d = clone(base); d.items[0].name = 'Hack'; r = await put(S1, d); ok(r.s === 403, 'karyawan TIDAK boleh mengubah nama menu');
    d = clone(base); d.items.pop(); r = await put(S1, d); ok(r.s === 403, 'karyawan TIDAK boleh menghapus menu');
    d = clone(base); d.items.push({ id: 'z', name: 'Baru', cat: 'Sate', price: 1, stock: 1 }); r = await put(S1, d); ok(r.s === 403, 'karyawan TIDAK boleh menambah menu');
    d = clone(base); d.cats = ['Sate']; r = await put(S1, d); ok(r.s === 403, 'karyawan TIDAK boleh mengubah kategori');
    d = clone(base); d.orders.pop(); r = await put(S1, d); ok(r.s === 403 && /riwayat/i.test(r.j.error), 'karyawan TIDAK boleh menghapus riwayat penjualan');
    d = clone(base); d.orders = []; r = await put(S1, d); ok(r.s === 403, 'karyawan TIDAK boleh mengosongkan riwayat');
    d = clone(base); d.orders[0].total = 1; r = await put(S1, d); ok(r.s === 403, 'karyawan TIDAK boleh mengubah nilai transaksi');
    d = clone(base); d.set.tax = 0; r = await put(S1, d); ok(r.s === 403, 'karyawan TIDAK boleh mengubah pajak');
    d = clone(base); d.set.store = 'X'; r = await put(S1, d); ok(r.s === 403, 'karyawan TIDAK boleh mengubah nama toko');
    d = clone(base); d.set.gv = { cols: 3 }; d.set.newDefault = true; d.set.lang = 'en'; r = await put(S1, d); ok(r.s === 200, 'preferensi tampilan & kunci default baru diperbolehkan');
    let base2 = clone(d);
    d = clone(base2); d.set.prn.mode = 'ble'; r = await put(S1, d); ok(r.s === 200, 'karyawan dengan izin Printer boleh mengganti mode printer');
    base2 = clone(d);

    /* ----- izin diatur owner, berlaku langsung tanpa login ulang ----- */
    r = await call('PUT', '/api/users/' + siti.id, { perms: ['co', 'inv'] }, O); ok(r.status === 200, 'owner memberi izin Inventori');
    d = clone(base2); d.set.prn.mode = 'serial'; r = await put(S1, d); ok(r.s === 403, 'izin Printer dicabut: langsung berlaku tanpa login ulang');
    d = clone(base2); d.items[0].price = 30000; r = await put(S1, d); ok(r.s === 200, 'dengan izin Inventori: boleh ubah harga');
    const base3 = clone(d);
    d = clone(base3); d.orders.pop(); r = await put(S1, d); ok(r.s === 403, 'izin Inventori tetap TIDAK boleh menghapus riwayat');
    d = clone(base3); d.set.tax = 0; r = await put(S1, d); ok(r.s === 403, 'izin Inventori tidak mencakup pengaturan toko');
    await call('PUT', '/api/users/' + siti.id, { perms: ['co', 'set'] }, O);
    d = clone(base3); d.set.tax = 11; r = await put(S1, d); ok(r.s === 200, 'dengan izin Pengaturan: boleh ubah pajak');
    d = clone(d); d.items[1].price = 1; r = await put(S1, d); ok(r.s === 403, 'izin Pengaturan tidak mencakup harga menu');
    const cs = await call('PUT', '/api/co/settings', { on: false }, S1); ok(cs.status === 200, 'izin Pengaturan: boleh buka/tutup pemesanan QR');
    await call('PUT', '/api/co/settings', { on: true }, S1);
    await call('PUT', '/api/users/' + siti.id, { perms: ['prn'] }, O);
    r = await call('GET', '/api/co', undefined, S1); ok(r.status === 403, 'tanpa izin Pesanan Online: /api/co ditolak');
    r = await call('PUT', '/api/co/settings', { on: false }, S1); ok(r.status === 403, 'tanpa izin Pengaturan: tidak boleh menutup pemesanan');
    d = clone(base3); d.set.tax = 11; r = await put(O, d); ok(r.s === 200, 'owner tidak dibatasi (ubah pajak)');
    d = clone(d); d.orders.pop(); r = await put(O, d); ok(r.s === 200, 'owner boleh menghapus riwayat');

    /* ----- sandi & sesi ----- */
    r = await call('POST', '/api/me/password', { old: 'salah', new: 'sandi-baru1' }, S1); ok(r.status === 403, 'ganti sandi: sandi lama salah ditolak');
    r = await call('POST', '/api/me/password', { old: 'sandi-siti', new: '123' }, S1); ok(r.status === 400, 'ganti sandi: sandi baru terlalu pendek ditolak');
    r = await call('POST', '/api/me/password', { old: 'sandi-siti', new: 'sandi-baru1' }, S1);
    const S1b = (await r.json()).token;
    ok(r.status === 200 && !!S1b, 'ganti sandi berhasil, sesi ini tetap hidup (token baru)');
    r = await call('GET', '/api/me', undefined, S1); ok(r.status === 401, 'token lama mati setelah ganti sandi');
    ok((await login('kasir1', 'sandi-siti')).status === 401 && (await login('kasir1', 'sandi-baru1')).status === 200, 'sandi lama tidak berlaku, sandi baru berlaku');
    r = await call('PUT', '/api/users/' + siti.id, { password: 'reset-owner1' }, O); ok(r.status === 200, 'owner mereset sandi karyawan');
    r = await call('GET', '/api/me', undefined, S1b); ok(r.status === 401, 'token karyawan mati setelah sandi direset owner');
    const S2 = (await login('kasir1', 'reset-owner1')).j.token; ok(!!S2, 'karyawan login dengan sandi hasil reset');
    r = await call('PUT', '/api/users/' + siti.id, { active: false }, O); ok(r.status === 200, 'owner menonaktifkan karyawan');
    r = await call('GET', '/api/me', undefined, S2); ok(r.status === 401, 'sesi karyawan langsung mati saat dinonaktifkan');
    r = await login('kasir1', 'reset-owner1'); ok(r.status === 403 && /nonaktif/i.test(r.j.error), 'login akun nonaktif ditolak dengan pesan jelas');
    r = await login('kasir1', 'salah-banget'); ok(r.status === 401, 'sandi salah di akun nonaktif tetap pesan umum');
    await call('PUT', '/api/users/' + siti.id, { active: true, role: 'staff' }, O);

    /* ----- melindungi owner terakhir ----- */
    const me = await (await call('GET', '/api/me', undefined, O)).json();
    r = await call('PUT', '/api/users/' + me.id, { role: 'staff' }, O); ok(r.status === 400, 'owner tidak bisa menurunkan dirinya sendiri');
    r = await call('PUT', '/api/users/' + me.id, { active: false }, O); ok(r.status === 400, 'owner tidak bisa menonaktifkan dirinya sendiri');
    r = await call('DELETE', '/api/users/' + me.id, undefined, O); ok(r.status === 400, 'owner tidak bisa menghapus dirinya sendiri');
    r = await call('POST', '/api/users', { username: 'owner2', name: 'Istri', password: 'sandi-owner2', role: 'owner' }, O);
    const o2 = await r.json(); ok(r.status === 200 && o2.role === 'owner', 'tambah owner kedua');
    const O2 = (await login('owner2', 'sandi-owner2')).j.token;
    r = await call('GET', '/api/users', undefined, O2); ok(r.status === 200 && (await r.json()).users.length === 3, 'owner kedua bisa mengelola pengguna');
    r = await call('PUT', '/api/users/' + me.id, { role: 'staff' }, O2); ok(r.status === 200, 'owner kedua boleh menurunkan owner pertama');
    r = await call('GET', '/api/users', undefined, O); ok(r.status === 401, 'token owner yang diturunkan langsung mati');
    r = await call('DELETE', '/api/users/' + o2.id, undefined, O2); ok(r.status === 400, 'tidak bisa menghapus diri sendiri / owner terakhir');
    await call('PUT', '/api/users/' + me.id, { role: 'owner' }, O2);
    r = await call('GET', '/api/audit', undefined, O2); const au = await r.json();
    ok(r.status === 200 && au.log.some((x) => x.action === 'login') && au.log.some((x) => x.action === 'tambah-user') && au.log.some((x) => x.action === 'ditolak'), 'log aktivitas mencatat login, penambahan user, dan upaya ditolak');
    r = await call('DELETE', '/api/users/' + siti.id, undefined, O2); ok(r.status === 200, 'owner menghapus karyawan');
    ok((await login('kasir1', 'reset-owner1')).status === 401, 'akun terhapus tidak bisa login');

    /* ----- pemulihan sandi owner ----- */
    srv.kill('SIGTERM'); await sleep(500);
    await start({ POS_PASSWORD: 'sandi-pemulihan', RESET_OWNER_PASSWORD: '1' });
    ok((await login('owner', 'sandi-pemulihan')).status === 200, 'RESET_OWNER_PASSWORD: owner pertama bisa masuk dengan sandi baru');
    ok((await login('owner', 'rahasia123')).status === 401, 'sandi lama owner tidak berlaku lagi');
    srv.kill('SIGTERM'); await sleep(500);
    await start({ POS_PASSWORD: 'rahasia123' });
    ok((await login('owner', 'sandi-pemulihan')).status === 200, 'tanpa flag reset, POS_PASSWORD tidak menimpa sandi yang sudah ada');
  } catch (e) { console.error(e); fails = 1; }
  try { srv.kill('SIGTERM'); } catch (e) {}
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(fails ? 'ADA YANG GAGAL' : 'ALL PASSED'); process.exit(fails);
})();
