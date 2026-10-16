/* POS SATE — penghubung ke Supabase (dipakai bila config.js mengisi window.POS_SB).
   Aplikasi tetap memanggil "/api/..." seperti biasa; file ini mencegat panggilan itu dan mengirimnya ke
   fungsi database public.pos_api lewat Supabase REST. Tidak ada rahasia di sini: key adalah kunci PUBLISHABLE
   (anon), dan semua pembatasan akses dijaga di database (lihat supabase/setup.sql). */
(function () {
  var C = window.POS_SB;
  if (!C || !C.url || !C.key) return;
  window.POS_CLOUD = true;
  var ep = String(C.url).replace(/\/+$/, '') + '/rest/v1/rpc/pos_api', orig = window.fetch.bind(window);
  var HDR = { 'Content-Type': 'application/json', apikey: C.key };
  if (/^eyJ/.test(C.key)) HDR.Authorization = 'Bearer ' + C.key; // kunci anon lama (JWT); kunci sb_publishable_ tidak memakai header ini
  var MK = 'pos_menu_c';
  function res(s, b) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }); }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function bearer(o) {
    try { var h = new Headers((o && o.headers) || {}).get('authorization') || ''; return h.indexOf('Bearer ') === 0 ? h.slice(7) : ''; } catch (e) { return ''; }
  }
  window.fetch = function (input, o) {
    if (typeof input !== 'string' || input.indexOf('/api/') !== 0) return orig(input, o);
    o = o || {};
    var u = new URL(input, 'http://x'), q = {}, b = {}, isMenu = u.pathname === '/api/public/menu';
    u.searchParams.forEach(function (v, k) { q[k] = v; });
    if (typeof o.body === 'string' && o.body) { try { b = JSON.parse(o.body); } catch (e) { return Promise.resolve(res(400, { error: 'bad json' })); } }
    var cache = isMenu ? lsGet(MK) : null;
    if (cache && cache.ver != null) q.since = String(cache.ver);
    return orig(ep, { method: 'POST', headers: HDR, body: JSON.stringify({ p: { m: o.method || 'GET', u: u.pathname, q: q, b: b, t: bearer(o) } }), signal: o.signal, cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (j) {
        if (!j || typeof j.s !== 'number') { // kesalahan gerbang Supabase (kunci salah / fungsi belum dibuat / project dijeda) — jangan dianggap "belum login"
          var msg = j && (j.message || j.hint || j.error) || 'tidak ada jawaban';
          return res(502, { error: 'Supabase: ' + msg });
        }
        var d = j.b;
        if (isMenu && j.s === 200) {
          if (d.unchanged && cache && cache.menu) d = Object.assign({}, cache.menu, { open: d.open, msg: d.msg });
          else if (!d.unchanged) lsSet(MK, { ver: d.ver, menu: d });
        }
        return res(j.s, d);
      });
  };
})();
