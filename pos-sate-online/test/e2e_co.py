"""E2E pesanan QR: kasir (2 perangkat) + pelanggan (HP) di Chromium.
Jalankan: python3 test/e2e_co.py  (server dijalankan otomatis di port 3790)"""
import json, os, subprocess, sys, tempfile, time, base64
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get('SHOTS', tempfile.mkdtemp(prefix='coshots-'))
PORT, PW = 3790, 'sandi-uji-123'
U = f'http://127.0.0.1:{PORT}/'
res = []
def ok(c, m):
    print(('PASS ' if c else 'FAIL ') + m); res.append(bool(c))

data = tempfile.mkdtemp(prefix='coe2e-')
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', os.path.join(ROOT, 'server.js')],
                       env={**os.environ, 'PORT': str(PORT), 'DATA_DIR': data, 'POS_PASSWORD': PW},
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try:
            import urllib.request
            urllib.request.urlopen(U + 'api/health', timeout=1); break
        except Exception:
            time.sleep(.1)

    FAKE = "window.__sent=[];window.sendBLE=async d=>{window.__sent.push(Array.from(d))};db.set.prn.mode='ble';save()"
    with sync_playwright() as p:
        b = p.chromium.launch()
        def cashier(w=1280, h=800, mobile=False):
            c = b.new_context(viewport={'width': w, 'height': h}, is_mobile=mobile, has_touch=mobile,
                              permissions=['notifications'])
            pg = c.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e))); pg.errs = errs
            pg.goto(U); pg.wait_for_selector('#login:not([hidden])')
            pg.fill('#loginUser', 'owner'); pg.fill('#loginPw', PW); pg.click('#loginBtn'); pg.wait_for_selector('#login', state='hidden')
            pg.wait_for_function("CL.st==='ok'&&!CL.dirty&&!CL.busy", timeout=10000)
            return c, pg
        cA, A = cashier()
        ok(A.evaluate("document.getElementById('coBell').hidden")==False and A.evaluate("document.getElementById('coNav').hidden")==False, 'mode online: lonceng & menu Pesanan Online tampil')
        A.evaluate(FAKE)
        A.wait_for_function("CL.st==='ok'&&!CL.dirty&&!CL.busy", timeout=10000)

        # --- pelanggan memesan lewat QR meja 7
        cC = b.new_context(viewport={'width': 390, 'height': 780}, device_scale_factor=2, is_mobile=True, has_touch=True)
        C = cC.new_page(); cerr = []; C.on('pageerror', lambda e: cerr.append(str(e)))
        C.goto(U + 'order?t=7'); C.wait_for_selector('#vMenu:not([hidden])')
        ok('Meja 7' in C.inner_text('#tbBadge'), 'pelanggan: nomor meja dari QR terbaca')
        C.screenshot(path=f'{OUT}/c_menu.png')
        ids = C.evaluate("M.items.filter(i=>i.stock>=3).slice(0,2).map(i=>i.id)")
        nm = C.evaluate(f"M.items.find(i=>i.id==='{ids[0]}').name")
        C.evaluate(f"chg('{ids[0]}',1);chg('{ids[0]}',1);chg('{ids[1]}',1)")
        C.evaluate("openCart()"); C.fill('#cName', 'Budi'); C.fill('#cNote', 'tanpa pedas')
        C.screenshot(path=f'{OUT}/c_cart.png')
        C.click('#sendBtn'); C.wait_for_selector('#vDone:not([hidden])', timeout=8000)
        ok('#001' in C.inner_text('#vDone') and 'Budi' in C.inner_text('#vDone'), 'pelanggan: nomor pesanan #001 & nama tampil')
        C.screenshot(path=f'{OUT}/c_done.png')

        # --- kasir menerima notifikasi + auto print
        A.wait_for_function("coNew().length===1", timeout=8000)
        ok(A.evaluate("document.getElementById('coBellN').textContent")=='1' and not A.evaluate("document.getElementById('coBellN').hidden"), 'kasir: lencana lonceng menunjukkan 1 pesanan baru')
        ok(A.evaluate("document.title").startswith('(1)'), 'kasir: judul tab menunjukkan jumlah pesanan baru')
        A.wait_for_function("window.__sent.length===1", timeout=8000)
        sent = bytes(A.evaluate("window.__sent[0]")).decode('latin1')
        ok('PESANAN ONLINE' in sent and '#001' in sent and 'Budi' in sent and 'tanpa pedas' in sent and nm[:10] in sent and 'BELUM DIBAYAR' in sent, 'kasir: tiket ESC/POS otomatis tercetak (nama, nomor, catatan, item)')
        A.wait_for_function("CO.list.length&&CO.list[0].printed===2", timeout=8000)
        ok(True, 'kasir: status tercetak tersimpan di server')
        A.wait_for_timeout(1500)
        ok(A.evaluate("window.__sent.length")==1, 'kasir: tidak mencetak dobel')

        # --- halaman Pesanan Online
        A.evaluate("go('co')"); A.wait_for_selector('.coc.new')
        t = A.inner_text('#coList')
        ok('Budi' in t and 'Meja 7' in t and 'Dine In' in t and 'tanpa pedas' in t and 'tercetak' in t, 'kasir: kartu pesanan lengkap (nama, meja, tipe, catatan, tercetak)')
        A.screenshot(path=f'{OUT}/a_co_desktop.png')

        # --- QR dalam modal: decode dari gambar layar
        A.evaluate("coQr()"); A.fill('#qrT', '7')
        qpng = A.locator('#qrBox svg').screenshot(path=f'{OUT}/a_qr.png')
        try:
            import cv2, numpy as np
            img = cv2.imdecode(np.frombuffer(qpng, np.uint8), cv2.IMREAD_GRAYSCALE)
            det = cv2.QRCodeDetector(); val = ''
            for sc in (1.0, 2.0, 0.7, 3.0):
                im2 = cv2.resize(img, None, fx=sc, fy=sc, interpolation=cv2.INTER_NEAREST)
                val, _, _ = det.detectAndDecode(im2)
                if val: break
            ok(val == f'http://127.0.0.1:{PORT}/order?t=7', 'QR di layar kasir bisa dipindai -> ' + val)
        except ImportError:
            print('SKIP decode QR (cv2 tidak ada)')
        A.screenshot(path=f'{OUT}/a_qr_modal.png')
        A.evaluate("closeModal()")

        # --- perangkat kedua: hanya satu yang mencetak
        cD, D = cashier(); D.evaluate(FAKE); D.wait_for_function("CL.st==='ok'&&!CL.dirty&&!CL.busy", timeout=10000)
        D.wait_for_function("CO.list.length===1", timeout=8000)
        ok(D.evaluate("window.__sent.length")==0, 'perangkat 2: pesanan lama yang sudah tercetak tidak dicetak ulang')
        A.evaluate("window.__sent=[]"); D.evaluate("window.__sent=[]")
        C.evaluate("backToMenu()")
        C.evaluate(f"chg('{ids[1]}',1);openCart()"); C.fill('#cName', 'Sari'); C.click('#sendBtn'); C.wait_for_selector('#vDone:not([hidden])')
        A.wait_for_function("coNew().length===2", timeout=8000); D.wait_for_function("coNew().length===2", timeout=8000)
        A.wait_for_function("CO.list.filter(o=>o.printed===2).length===2", timeout=10000)
        time.sleep(1.5)
        n = A.evaluate("window.__sent.length") + D.evaluate("window.__sent.length")
        ok(n == 1, f'dua kasir terbuka: pesanan #002 hanya dicetak satu kali (total {n})')

        # --- terima -> status di HP pelanggan berubah
        id1 = A.evaluate("CO.list.find(o=>o.num==='#001').id")
        A.evaluate(f"coAct({id1},'accept')")
        C.evaluate("backToMenu()")  # pastikan halaman status pesanan pertama tidak terbuka; cek lewat API publik
        st = C.evaluate(f"fetch('/api/public/order/'+LS.g('co_tok')).then(r=>r.json())")
        A.wait_for_function(f"CO.list.find(o=>o.id=={id1}).status==='accepted'", timeout=8000)
        ok(True, 'kasir: pesanan diterima (tersinkron ke perangkat lain)')
        D.wait_for_function(f"CO.list.find(o=>o.id=={id1}).status==='accepted'", timeout=8000)
        ok(True, 'perangkat 2 ikut melihat status diterima')

        # --- bayar di kasir: keranjang terisi dari pesanan, stok berkurang, tertaut ke pesanan
        stock0 = A.evaluate(f"find('{ids[0]}').stock")
        A.evaluate(f"coPay({id1})")
        ok(A.evaluate("document.querySelector('#pCust').value")=='Budi / Meja 7', 'bayar: nama pelanggan & meja terisi di form pembayaran')
        ok(A.evaluate(f"S.cart['{ids[0]}']")==2 and A.evaluate("S.type")=='Dine In', 'bayar: keranjang terisi dari pesanan (2x item pertama, Dine In)')
        A.screenshot(path=f'{OUT}/a_pay.png')
        A.evaluate("document.querySelector('#pPaid').value=999999999;checkout()")
        A.wait_for_function("CL.st==='ok'&&!CL.dirty&&!CL.busy", timeout=10000)
        no = A.evaluate("db.orders[0].no")
        ok(A.evaluate("db.orders[0].cust")=='Budi / Meja 7' and A.evaluate(f"find('{ids[0]}').stock")==stock0-2, 'bayar: penjualan tercatat, stok berkurang 2')
        A.wait_for_function(f"CO.list.find(o=>o.id=={id1}).status==='done'", timeout=8000)
        ok(A.evaluate(f"CO.list.find(o=>o.id=={id1}).saleNo")==no, 'pesanan online tertaut ke nomor invoice ' + no)
        A.evaluate("go('co')"); A.screenshot(path=f'{OUT}/a_co_after.png')

        # --- tutup pemesanan -> pelanggan melihat tutup
        A.evaluate("coSetOpen(false)")
        cE = b.new_context(viewport={'width': 390, 'height': 780}, device_scale_factor=2, is_mobile=True, has_touch=True)
        E = cE.new_page(); E.goto(U + 'order'); E.wait_for_selector('#closed:not([hidden])', timeout=8000)
        ok('ditutup' in E.inner_text('#closed').lower(), 'pelanggan baru: menu menampilkan pemesanan ditutup')
        E.screenshot(path=f'{OUT}/c_closed.png')

        # --- tampilan HP kasir
        cM, M_ = cashier(390, 780, True)
        M_.evaluate("go('co')"); M_.wait_for_selector('.coc'); M_.screenshot(path=f'{OUT}/a_co_mobile.png')
        M_.evaluate("go('pos')"); M_.screenshot(path=f'{OUT}/a_pos_mobile.png')

        errs = A.errs + D.errs + M_.errs + cerr
        ok(not errs, 'tidak ada error JS di semua halaman ' + (str(errs[:2]) if errs else ''))
        b.close()
finally:
    srv.terminate()
print('SCREENSHOTS', OUT)
print('ALL PASSED' if all(res) else f'ADA YANG GAGAL ({res.count(False)})')
sys.exit(0 if all(res) else 1)
