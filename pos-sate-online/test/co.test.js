'use strict';
/* Tes pesanan pelanggan (QR): node test/co.test.js */
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const PORT = 3800 + Math.floor(Math.random() * 90);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-co-'));
const base = `http://127.0.0.1:${PORT}`;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const doc = () => ({
  items: [
    { id: 'a', name: 'Sate Ayam', cat: 'Sate', price: 25000, cost: 12000, stock: 10, img: PNG },
    { id: 'b', name: 'Es Teh', cat: 'Minum', price: 5000, cost: 1000, stock: 2 },
    { id: 'c', name: 'Habis', cat: 'Minum', price: 7000, cost: 1000, stock: 0 },
  ],
  orders: [], cats: ['Sate', 'Minum'], log: [], set: { store: 'POS SATE', tax: 10, dec: 0, cur: 'Rp' }, seq: 1,
});
const post = (u, b, H) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(H || {}) }, body: JSON.stringify(b || {}) });

(async () => {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DIR, POS_PASSWORD: 'rahasia123', ORDER_RATE: '8' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch (e) {} await sleep(100); }
    const tok = (await (await post('/api/login', { username: 'owner', password: 'rahasia123' })).json()).token;
    const H = { Authorization: 'Bearer ' + tok };

    ok((await fetch(base + '/api/public/menu')).status === 503, 'menu belum siap sebelum ada data kasir');
    await fetch(base + '/api/data', { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ baseVersion: 0, data: doc() }) });

    /* halaman & menu publik */
    const pg = await fetch(base + '/order');
    const html = await pg.text();
    ok(pg.status === 200 && /<html/i.test(html) && !/POS_CLOUD/.test(html) && !/Bayar & Cetak/.test(html), 'halaman /order terpisah dari aplikasi kasir');
    const idx = await (await fetch(base + '/')).text();
    ok(/Bayar & Cetak/.test(idx) && !/id="cName"/.test(idx), 'aplikasi kasir tetap di /');
    const menuRes = await fetch(base + '/api/public/menu');
    const menu = await menuRes.json();
    ok(menuRes.status === 200 && menu.items.length === 3 && menu.open === true, 'menu publik tanpa login');
    ok(!JSON.stringify(menu).includes('"cost"') && !JSON.stringify(menu).includes('12000'), 'menu publik tidak membocorkan harga modal');
    ok(/^\/img\/a\?v=/.test(menu.items[0].img), 'gambar disajikan lewat /img');
    const im = await fetch(base + menu.items[0].img);
    ok(im.status === 200 && im.headers.get('content-type') === 'image/png', 'gambar menu dapat diambil');
    ok((await fetch(base + '/api/data')).status === 401, 'data kasir tetap butuh login');
    ok((await fetch(base + '/api/co')).status === 401, 'daftar pesanan kasir butuh login');

    /* membuat pesanan */
    let r = await post('/api/public/order', { name: '', items: [{ id: 'a', qty: 1 }] });
    ok(r.status === 400, 'nama wajib diisi');
    r = await post('/api/public/order', { name: 'Budi', items: [] });
    ok(r.status === 400, 'pesanan kosong ditolak');
    r = await post('/api/public/order', { name: 'Budi', items: [{ id: 'zzz', qty: 1 }] });
    ok(r.status === 400, 'item tidak dikenal ditolak');
    r = await post('/api/public/order', { name: 'Bot', items: [{ id: 'a', qty: 1 }], website: 'http://spam' });
    ok(r.status === 400, 'honeypot menolak bot');
    r = await post('/api/public/order', { name: 'Budi', items: [{ id: 'c', qty: 1 }] });
    ok(r.status === 409, 'stok habis ditolak');
    r = await post('/api/public/order', { name: 'Budi', items: [{ id: 'b', qty: 3 }] });
    const lim = await r.json();
    ok(r.status === 409 && lim.stock === 2, 'melebihi stok ditolak dengan sisa stok');

    r = await post('/api/public/order', { name: '  Budi\n<b>Santoso</b> ', table: '5', type: 'Dine In', note: 'tanpa pedas', key: 'kunci-12345678', items: [{ id: 'a', qty: 2, price: 1 }, { id: 'b', qty: 1 }, { id: 'a', qty: 1 }] });
    const o1 = await r.json();
    ok(r.status === 200 && o1.num === '#001' && !!o1.tok, 'pesanan pertama dibuat, nomor #001');
    ok(o1.sub === 80000 && o1.tax === 8000 && o1.total === 88000, 'harga dihitung server (3x25000 + 5000, pajak 10%), harga kiriman diabaikan');
    ok(o1.lines.length === 2 && o1.lines.find((l) => l.id === 'a').qty === 3, 'baris item yang sama digabung');
    ok(o1.name === 'Budi <b>Santoso</b>' && o1.tbl === '5' && o1.type === 'Dine In', 'nama dirapikan, meja & tipe tersimpan');
    r = await post('/api/public/order', { name: 'Budi', key: 'kunci-12345678', items: [{ id: 'a', qty: 1 }] });
    const dup = await r.json();
    ok(r.status === 200 && dup.dup === true && dup.num === '#001' && dup.tok === o1.tok, 'kunci idempotensi: kirim ulang tidak membuat pesanan ganda');

    /* kasir melihat pesanan */
    let list = await (await fetch(base + '/api/co', { headers: H })).json();
    ok(list.orders.length === 1 && list.orders[0].status === 'new' && list.orders[0].printed === 0, 'kasir melihat pesanan baru (belum tercetak)');
    const id = list.orders[0].id;

    /* long-poll: terbangun saat ada pesanan baru */
    const t0 = Date.now();
    const lp = fetch(base + `/api/co?rev=${list.rev}&wait=10`, { headers: H }).then((x) => x.json());
    await sleep(400);
    r = await post('/api/public/order', { name: 'Sari', items: [{ id: 'a', qty: 1 }] });
    const o2 = await r.json();
    const lj = await lp;
    ok(o2.num === '#002' && !lj.unchanged && lj.orders.length === 2 && Date.now() - t0 < 4000, 'long-poll langsung terbangun saat pesanan masuk');
    const lp2 = await (await fetch(base + `/api/co?rev=${lj.rev}&wait=1`, { headers: H })).json();
    ok(lp2.unchanged === true, 'long-poll tanpa perubahan -> unchanged');

    /* klaim cetak atomik */
    const [c1, c2] = await Promise.all([post(`/api/co/${id}/print`, { action: 'claim' }, H), post(`/api/co/${id}/print`, { action: 'claim' }, H)]);
    const cs = [(await c1.json()).ok, (await c2.json()).ok];
    ok(cs.filter(Boolean).length === 1, 'dua perangkat berebut cetak: hanya satu yang berhasil');
    r = await post(`/api/co/${id}/print`, { action: 'release' }, H);
    ok((await (await post(`/api/co/${id}/print`, { action: 'claim' }, H)).json()).ok === true, 'setelah release, bisa diklaim lagi');
    await post(`/api/co/${id}/print`, { action: 'done' }, H);
    list = await (await fetch(base + '/api/co', { headers: H })).json();
    ok(list.orders.find((x) => x.id === id).printed === 2, 'status tercetak tersimpan');
    ok((await (await post(`/api/co/${id}/print`, { action: 'claim' }, H)).json()).ok === false, 'pesanan tercetak tidak bisa diklaim lagi');

    /* status pelanggan & aksi kasir */
    let cv = await (await fetch(base + '/api/public/order/' + o1.tok)).json();
    ok(cv.status === 'new' && cv.num === '#001', 'pelanggan bisa melihat status pesanannya');
    ok((await fetch(base + '/api/public/order/' + 'x'.repeat(20))).status === 404, 'token acak = 404');
    r = await post(`/api/co/${id}`, { action: 'accept' }, H);
    ok(r.status === 200 && (await r.json()).status === 'accepted', 'kasir menerima pesanan');
    cv = await (await fetch(base + '/api/public/order/' + o1.tok)).json();
    ok(cv.status === 'accepted', 'pelanggan melihat status diterima');
    r = await post(`/api/public/order/${o1.tok}/cancel`);
    ok(r.status === 409, 'pelanggan tidak bisa batal setelah diterima');
    r = await post(`/api/co/${id}`, { action: 'done', saleNo: 'INV-20261016-ABC-0001' }, H);
    const dn = await r.json();
    ok(dn.status === 'done' && dn.saleNo === 'INV-20261016-ABC-0001', 'selesai + nomor invoice tertaut');
    ok((await post(`/api/co/${id}`, { action: 'cancel' }, H)).status === 409, 'pesanan selesai tidak bisa dibatalkan');
    r = await post(`/api/public/order/${o2.tok}/cancel`);
    ok(r.status === 200 && (await r.json()).status === 'cancelled', 'pelanggan membatalkan pesanan yang masih baru');

    /* nomor antrean per hari & batas laju */
    let last = 0;
    for (let i = 0; i < 7; i++) { r = await post('/api/public/order', { name: 'T' + i, items: [{ id: 'a', qty: 1 }] }); last = r.status; if (r.status === 429) break; }
    ok(last === 429, 'batas laju: terlalu banyak pesanan dari satu IP -> 429');

    /* tutup pemesanan */
    r = await fetch(base + '/api/co/settings', { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false, msg: 'Dapur tutup' }) });
    ok(r.status === 200, 'kasir menutup pemesanan');
    const m2 = await (await fetch(base + '/api/public/menu')).json();
    ok(m2.open === false && m2.msg === 'Dapur tutup', 'menu publik menampilkan status tutup');
    r = await post('/api/public/order', { name: 'Telat', items: [{ id: 'a', qty: 1 }] });
    ok(r.status === 403, 'pesanan ditolak saat ditutup');
    r = await fetch(base + '/api/co/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });
    ok(r.status === 401, 'pengaturan butuh login kasir');
  } catch (e) { console.error(e); fails = 1; }
  srv.kill();
  console.log(fails ? 'ADA YANG GAGAL' : 'ALL PASSED');
  process.exit(fails);
})();
