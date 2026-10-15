import json, time
from playwright.sync_api import sync_playwright
U='http://localhost:3777/'
PW='sandi-uji-123'
res=[]
def ok(c,m):
    print(('PASS ' if c else 'FAIL ')+m); res.append(bool(c))
def login(pg,pw=PW):
    pg.fill('#loginPw',pw); pg.click('.loginc .btn')
def wait_ok(pg,t=8000):
    pg.wait_for_function("CL.st==='ok'&&!CL.dirty&&!CL.busy",timeout=t)
with sync_playwright() as p:
    b=p.chromium.launch()
    def dev():
        c=b.new_context(viewport={'width':390,'height':780},device_scale_factor=2,is_mobile=True,has_touch=True)
        pg=c.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e))); pg.errs=errs; return c,pg
    cA,A=dev(); A.goto(U); A.wait_for_selector('#login:not([hidden])')
    ok(A.evaluate("CL.on===true"),'mode online aktif (POS_CLOUD)')
    A.screenshot(path='/tmp/e2e_login.png')
    login(A,'salah'); A.wait_for_function("document.querySelector('#loginErr').textContent.length>0")
    ok('salah' in A.inner_text('#loginErr').lower(),'sandi salah ditolak di UI')
    login(A); A.wait_for_selector('#login',state='hidden'); wait_ok(A)
    srv=lambda: json.loads(A.evaluate("api('/api/data').then(r=>r.text())"))
    s=srv(); ok(s['version']==1 and len(s['data']['items'])>10,'login A: data awal terunggah ke server (v1)')
    ids=A.evaluate("db.items.map(i=>i.id)"); x=ids[0]; y=ids[1]
    stock0=A.evaluate(f"find('{x}').stock")
    # B: perangkat baru
    cB,B=dev(); B.goto(U); B.wait_for_selector('#login:not([hidden])'); login(B); B.wait_for_selector('#login',state='hidden'); wait_ok(B)
    ok(B.evaluate("db.items.map(i=>i.id)")==ids,'B: memakai data server (id item sama, tanpa duplikat)')
    ok(B.evaluate("db.set.store")=='POS SATE' and B.evaluate("CL.ver")==1,'B: versi sinkron = 1')
    # A jual 1 x
    A.evaluate(f"chg('{x}',1);payForm();document.querySelector('#pPaid').value=200000;checkout()"); wait_ok(A)
    ok(srv()['version']==2,'A: penjualan tersinkron (v2)')
    B.evaluate("syncNow()"); wait_ok(B)
    ok(B.evaluate("db.orders.length")==1 and B.evaluate(f"find('{x}').stock")==stock0-1,'B: pesanan & stok dari A muncul setelah sinkron')
    ono=B.evaluate("db.orders[0].no"); ok('-' in ono and len(ono.split('-'))==4,'nomor invoice memuat kode perangkat: '+ono)
    # B offline: jual 2 x + ubah y; A online jual 1 x
    cB.set_offline(True)
    B.evaluate(f"chg('{x}',2);payForm();document.querySelector('#pPaid').value=500000;checkout()")
    B.evaluate(f"find('{y}').price=77000;save()")
    B.wait_for_function("CL.dirty===true"); ok(True,'B offline: perubahan menunggu (dirty)')
    B.evaluate("syncNow()"); B.wait_for_function("CL.st==='offline'",timeout=8000); ok(B.evaluate("CL.st")=='offline','B: status offline, aplikasi tetap bisa dipakai')
    A.evaluate(f"chg('{x}',1);payForm();document.querySelector('#pPaid').value=200000;checkout()"); wait_ok(A)
    A.evaluate(f"find('{y}').stock=find('{y}').stock-3;save()"); wait_ok(A)
    cB.set_offline(False)
    B.evaluate("syncNow()"); wait_ok(B,12000)
    s=srv(); d=s['data']
    ok(len(d['orders'])==3,'gabung: 3 pesanan (A,B,A) tidak ada yang hilang → '+str(len(d['orders'])))
    ok(len({o['no'] for o in d['orders']})==3,'gabung: nomor invoice unik semua')
    xs=[i for i in d['items'] if i['id']==x][0]['stock']; ok(xs==stock0-4,f'gabung: stok x = {stock0}-1-2-1 = {stock0-4} (dapat {xs})')
    yi=[i for i in d['items'] if i['id']==y][0]; ok(yi['price']==77000 and yi['stock']==A.evaluate(f"find('{y}').stock") ,'gabung: harga y dari B + stok y dari A sama-sama terpakai')
    A.evaluate("syncNow()"); wait_ok(A)
    ok(A.evaluate("db.orders.length")==3,'A menerima gabungan (3 pesanan)')
    ok(A.evaluate(f"find('{x}').stock")==stock0-4,'A: stok x sama dengan server')
    # reload: token tersimpan, tidak minta login, data tetap
    A.reload(); A.wait_for_timeout(800)
    ok(A.evaluate("document.querySelector('#login').hidden")==True,'reload: tetap login (token tersimpan)')
    wait_ok(A); ok(A.evaluate("db.orders.length")==3,'reload: data utuh')
    # hapus data lokal total (localStorage + IndexedDB) -> pulih dari server
    A.evaluate("localStorage.removeItem('sushi_pos_v1');localStorage.removeItem('pos_sync')")
    A.evaluate("indexedDB.deleteDatabase('sushi_pos_db')")
    A.reload(); A.wait_for_timeout(1500); wait_ok(A,12000)
    ok(A.evaluate("db.orders.length")==3,'data lokal dihapus total: pulih otomatis dari server')
    # logout
    A.evaluate("cloudLogout()"); ok(A.evaluate("document.querySelector('#login').hidden")==False,'logout menampilkan login')
    # drawer status + settings screenshots
    login(A); A.wait_for_selector('#login',state='hidden'); wait_ok(A)
    A.evaluate("toggleDrawer()"); A.wait_for_timeout(400); A.screenshot(path='/tmp/e2e_drawer.png'); A.evaluate("closeAll();go('set')")
    A.wait_for_timeout(800); A.evaluate("document.querySelector('#dbForm').scrollIntoView()"); A.wait_for_timeout(300); A.screenshot(path='/tmp/e2e_settings.png')
    ok(len(A.errs)==0 and len(B.errs)==0,'tanpa error JS: '+str(A.errs+B.errs))
    b.close()
print('ALL PASSED' if all(res) else 'SOME FAILED')
