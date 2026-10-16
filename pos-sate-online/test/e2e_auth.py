"""E2E login & hak akses: owner menambah karyawan lewat UI, karyawan login di HP.
Jalankan: python3 test/e2e_auth.py (server dijalankan otomatis di port 3792)"""
import json, os, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get('SHOTS', tempfile.mkdtemp(prefix='authshots-'))
PORT, PW = 3792, 'sandi-owner-123'
U = f'http://127.0.0.1:{PORT}/'
res = []
def ok(c, m):
    print(('PASS ' if c else 'FAIL ') + m); res.append(bool(c))

srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', os.path.join(ROOT, 'server.js')],
                       env={**os.environ, 'PORT': str(PORT), 'DATA_DIR': tempfile.mkdtemp(prefix='authe2e-'), 'POS_PASSWORD': PW},
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try: urllib.request.urlopen(U + 'api/health', timeout=1); break
        except Exception: time.sleep(.1)
    VIS = "[...document.querySelectorAll('.drawer button[data-v]')].filter(b=>!b.hidden).map(b=>b.dataset.v).sort()"
    with sync_playwright() as p:
        b = p.chromium.launch()
        def page(w, h, mobile):
            c = b.new_context(viewport={'width': w, 'height': h}, is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1)
            pg = c.new_page(); pg.errs = []; pg.on('pageerror', lambda e: pg.errs.append(str(e)))
            pg.goto(U); pg.wait_for_selector('#login:not([hidden])'); pg.wait_for_timeout(1900); return c, pg  # tunggu splash selesai
        def login(pg, user, pw):
            pg.fill('#loginUser', user); pg.fill('#loginPw', pw); pg.click('#loginBtn')

        # --- halaman login & validasi
        cO, O = page(1280, 800, False)
        O.screenshot(path=f'{OUT}/login_desktop.png')
        login(O, 'owner', 'salah-total'); O.wait_for_function("document.querySelector('#loginErr').textContent.length>0")
        ok('salah' in O.inner_text('#loginErr').lower(), 'login: sandi salah menampilkan pesan')
        O.fill('#loginUser', ''); O.fill('#loginPw', ''); O.click('#loginBtn')
        ok('username' in O.inner_text('#loginErr').lower(), 'login: kolom kosong ditolak di layar')
        ok(O.evaluate("document.querySelector('#loginPw').type")=='password', 'login: sandi tersembunyi')
        O.click('#loginEye'); ok(O.evaluate("document.querySelector('#loginPw').type")=='text', 'login: tombol Tampilkan membuka sandi')
        login(O, 'OWNER', PW); O.wait_for_selector('#login', state='hidden'); O.wait_for_function("CL.st==='ok'&&!CL.dirty&&!CL.busy", timeout=10000)
        ok(O.evaluate("CL.me.role")=='owner', 'owner login (username tidak peka huruf besar)')
        ok(set(O.evaluate(VIS)) >= {'pos','inv','hist','rc','prn','set','usr'}, 'owner melihat semua menu termasuk Pengguna')

        # --- owner menambah karyawan lewat UI
        O.evaluate("go('usr')"); O.wait_for_selector('#usrList .coc')
        O.evaluate("usrForm(0)"); O.fill('#uName', 'Rina'); O.fill('#uUser', 'rina'); O.fill('#uPw', 'rina-123456')
        O.screenshot(path=f'{OUT}/owner_add_user.png')
        O.evaluate("usrSave(0)"); O.wait_for_function("document.querySelector('#usrList').innerText.includes('Rina')", timeout=8000)
        ok(True, 'owner: karyawan "Rina" ditambahkan lewat UI')
        O.screenshot(path=f'{OUT}/owner_users.png')

        # --- karyawan login di HP
        cS, S = page(390, 780, True)
        S.screenshot(path=f'{OUT}/login_mobile.png')
        login(S, 'rina', 'rina-123456'); S.wait_for_selector('#login', state='hidden'); S.wait_for_function("CL.st==='ok'&&!CL.dirty&&!CL.busy", timeout=10000)
        ok(S.evaluate("CL.me.role")=='staff', 'karyawan login')
        vis = set(S.evaluate(VIS))
        ok(vis == {'pos','co','prn'}, f'karyawan hanya melihat Kasir, Pesanan Online, Printer (terlihat: {sorted(vis)})')
        S.evaluate("toggleDrawer()"); S.wait_for_timeout(400); S.screenshot(path=f'{OUT}/staff_drawer.png'); S.evaluate("closeAll()")
        S.evaluate("go('inv')"); ok(S.evaluate("S.view")=='pos', 'karyawan: membuka Inventori dialihkan ke Kasir')
        S.evaluate("go('usr')"); ok(S.evaluate("S.view")=='pos', 'karyawan: membuka Pengguna dialihkan ke Kasir')
        S.screenshot(path=f'{OUT}/staff_home.png')

        # --- karyawan tetap bisa berjualan dan nama kasir tercatat
        ids = S.evaluate("db.items.map(i=>i.id)"); x = ids[0]; st0 = S.evaluate(f"find('{x}').stock")
        S.evaluate(f"chg('{x}',1);payForm();document.querySelector('#pPaid').value=999999;checkout()")
        S.wait_for_function("CL.st==='ok'&&!CL.dirty&&!CL.busy", timeout=10000)
        ok(S.evaluate("db.orders[0].cashier")=='Rina' and S.evaluate(f"find('{x}').stock")==st0-1, 'karyawan menjual: transaksi tercatat atas nama Rina, stok berkurang')
        S.evaluate("closeModal()")

        # --- upaya menembus lewat API ditolak server
        code = S.evaluate("""(async()=>{const d=await (await api('/api/data')).json();d.data.items[0].price=1;
          const r=await api('/api/data',{method:'PUT',body:JSON.stringify({baseVersion:d.version,data:d.data})});return r.status})()""")
        ok(code == 403, f'karyawan mengubah harga lewat API ditolak server (HTTP {code})')
        code = S.evaluate("api('/api/users').then(r=>r.status)"); ok(code == 403, 'karyawan membuka daftar pengguna ditolak (403)')
        code = S.evaluate("api('/api/export').then(r=>r.status)"); ok(code == 403, 'karyawan mengunduh ekspor data ditolak (403)')

        # --- owner memberi izin Riwayat + Inventori, karyawan melihat perubahan tanpa login ulang
        uid = O.evaluate("USR.list.find(u=>u.username==='rina').id")
        O.evaluate(f"api('/api/users/{uid}',{{method:'PUT',body:JSON.stringify({{perms:['co','prn','hist','inv']}})}})")
        S.wait_for_function("CL.me.perms.includes('inv')&&CL.me.perms.includes('hist')", timeout=25000)
        ok(set(S.evaluate(VIS)) == {'pos','co','prn','hist','inv'}, 'izin baru dari owner muncul di menu karyawan tanpa login ulang')
        S.evaluate("go('hist')"); S.wait_for_timeout(300); ok('Rina' in S.inner_text('#histBody'), 'riwayat menampilkan nama kasir')
        S.screenshot(path=f'{OUT}/staff_hist.png')

        # --- owner menonaktifkan -> karyawan terlempar ke halaman login
        O.evaluate(f"api('/api/users/{uid}',{{method:'PUT',body:JSON.stringify({{active:false}})}})")
        S.wait_for_selector('#login:not([hidden])', timeout=25000)
        ok(True, 'akun dinonaktifkan: karyawan otomatis keluar ke halaman login')
        login(S, 'rina', 'rina-123456'); S.wait_for_function("document.querySelector('#loginErr').textContent.length>0")
        ok('tidak aktif' in S.inner_text('#loginErr').lower() or 'nonaktif' in S.inner_text('#loginErr').lower(), 'login akun nonaktif: pesan jelas -> ' + S.inner_text('#loginErr'))
        errs = O.errs + S.errs
        ok(not errs, 'tidak ada error JS ' + (str(errs[:2]) if errs else ''))
        b.close()
finally:
    srv.terminate()
print('SCREENSHOTS', OUT)
print('ALL PASSED' if all(res) else f'ADA YANG GAGAL ({res.count(False)})')
sys.exit(0 if all(res) else 1)
