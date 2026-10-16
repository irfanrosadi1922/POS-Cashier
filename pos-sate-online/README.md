# POS SATE Online

Aplikasi kasir POS SATE yang berjalan online: data tersimpan otomatis di **database SQLite di server**, disinkronkan ke semua perangkat (HP, tablet, komputer), dan tetap bisa dipakai saat internet putus.

- Tanpa dependensi npm. Cukup **Node.js 22.13 atau lebih baru** (memakai `node:sqlite` bawaan), atau Docker.
- Login dengan kata sandi, HTTPS otomatis lewat Caddy, snapshot harian, dan backup file harian.
- Bisa dipasang sebagai aplikasi layar penuh (PWA) dari browser.

## 1. Coba di komputer sendiri

```bash
POS_PASSWORD="sandi-anda" npm start
# buka http://localhost:3000  ->  login: username "owner", sandi = POS_PASSWORD
```

(Windows PowerShell: `$env:POS_PASSWORD="sandi-anda"; npm start`)

## 2. Online dengan domain streetsateoriginal.my.id (VPS + Docker)

Perlu: satu VPS Linux (Ubuntu, RAM 512 MB sudah cukup) dengan IP publik, dan akses ke pengaturan DNS domain Anda.

1. **DNS.** Di panel DNS tempat domain didaftarkan, buat record:
   - `A` untuk `streetsateoriginal.my.id` mengarah ke IP VPS.
   - (opsional) `A` untuk `www` ke IP yang sama.
   Tunggu beberapa menit sampai aktif.
2. **Pasang Docker** di VPS (`curl -fsSL https://get.docker.com | sh`).
3. **Unggah folder ini** ke VPS (mis. `scp -r pos-sate-online user@IP:~/`).
4. Di folder itu: `cp .env.example .env` lalu isi `POS_PASSWORD` dengan sandi yang kuat. Sandi ini hanya dipakai **sekali**, untuk membuat akun owner pertama (username `owner`). Setelah itu sandi diganti dari dalam aplikasi.
5. Jalankan: `docker compose up -d --build`
6. Buka **https://streetsateoriginal.my.id**. Sertifikat HTTPS diurus otomatis oleh Caddy (port 80 dan 443 harus terbuka di firewall VPS).

Untuk domain lain, ubah baris pertama `Caddyfile`.

### Alternatif tanpa VPS sendiri
Railway, Fly.io, atau layanan sejenis bisa dipakai, **asalkan** ada *persistent volume* yang di-mount ke `/data` (di situ database disimpan). Jangan pakai paket gratis tanpa disk permanen (mis. Render free): data akan hilang saat server restart. Atur variabel `POS_PASSWORD`, `DATA_DIR=/data`, `TRUST_PROXY=1`, lalu arahkan domain sesuai petunjuk layanan tersebut.

## 2b. Tanpa VPS: komputer toko + Cloudflare Tunnel (gratis)

Aplikasi berjalan di satu komputer di toko, dan **Cloudflare Tunnel** menyambungkannya ke `https://streetsateoriginal.my.id` dengan HTTPS, tanpa membuka port router dan tanpa IP publik. GitHub Pages, Netlify, dan Vercel **tidak bisa** menjalankan aplikasi ini karena hanya melayani file statis.

Syarat: satu komputer Windows 10/11 (laptop lama cukup) yang menyala dan online selama toko buka.

**A. Jalankan server di komputer toko**
1. Pasang **Node.js LTS (versi 22 atau lebih baru)** dari nodejs.org.
2. Ekstrak folder `pos-sate-online` ke `C:\pos-sate-online` (atau `git clone` dari repo privat Anda).
3. Salin `.env.example` menjadi `.env`, buka dengan Notepad, lalu isi `POS_PASSWORD` dengan sandi owner Anda (bukan sandi contoh).
4. Klik dua kali `windows\jalankan-pos.bat`. Jika tertulis `POS SATE berjalan di http://localhost:3000`, buka alamat itu di komputer yang sama dan coba login (username `owner`).
5. Klik kanan `windows\pasang-otomatis.bat` → **Run as administrator**. Server lalu menyala otomatis setiap komputer hidup, hidup lagi jika berhenti, dan komputer tidak tidur saat dicolok listrik.

**B. Pindahkan domain ke Cloudflare (sekali saja)**
1. Daftar di cloudflare.com (gratis), pilih **Add a site**, masukkan `streetsateoriginal.my.id`, pilih paket **Free**.
2. Cloudflare menampilkan dua *nameserver*. Ganti nameserver domain Anda dengan keduanya di tempat Anda membeli domain, lalu tunggu status menjadi *Active* (beberapa menit sampai 24 jam). Salin juga record DNS lain yang sudah ada (mis. email) bila ada.
3. Di tab **DNS**, **hapus** record lama yang menuju GitHub Pages (A ke `185.199.108.153` dan sejenisnya, atau CNAME ke `github.io`). Di repo GitHub, matikan Pages (Settings → Pages), supaya tidak bentrok.

**C. Buat tunnel**
1. Di Cloudflare buka **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**, beri nama `pos-sate`, pilih **Windows**.
2. Cloudflare menampilkan satu perintah (`cloudflared.exe service install ...`). Jalankan di **PowerShell sebagai Administrator** di komputer toko. Status tunnel menjadi *Healthy*.
3. Tab **Public Hostname**: subdomain dikosongkan, domain `streetsateoriginal.my.id`, **Type `HTTP`**, **URL `localhost:3000`**. Simpan.
4. Buka `https://streetsateoriginal.my.id/`: halaman login muncul.

Cloudflare kadang meminta kartu atau PayPal untuk verifikasi saat mengaktifkan Zero Trust. Paket Free tidak ditagih. Jika Anda tidak mau memberi kartu, tunnel juga bisa dibuat lewat perintah (`cloudflared tunnel login`, `cloudflared tunnel create pos-sate`, `cloudflared tunnel route dns pos-sate streetsateoriginal.my.id`, lalu `config.yml` dengan `service: http://localhost:3000`). Nama menu Cloudflare bisa berubah; ikuti panduan resminya jika tampilannya berbeda.

**Yang perlu diketahui**
- **Komputer mati atau offline = aplikasi tidak bisa dibuka di perangkat lain.** Kasir yang sudah terbuka tetap bisa berjualan secara offline dan mengirim datanya begitu server hidup lagi, tetapi pesanan QR pelanggan tidak masuk selama server mati.
- Matikan mode tidur dan pastikan Windows Update tidak memulai ulang komputer saat jam buka. Pasang UPS/colokan yang stabil bila bisa.
- Data ada di komputer itu, di folder `data`. Server membuat backup harian di `data\backups`. **Salin folder `data` ke flash disk atau Google Drive secara berkala**, dan unduh ekspor data dari menu Pengaturan.
- Memperbarui aplikasi: ganti isi folder (kecuali `data` dan `.env`) dengan versi baru lalu restart komputer atau jalankan ulang `jalankan-pos.bat`.
- Di Mac/Linux jalankan `node server.js` dengan `TRUST_PROXY=cloudflare` di `.env`.

## 2c. Tanpa server sendiri dan tanpa komputer: Railway (bisa diatur dari iPhone)

Railway menjalankan aplikasi langsung dari repo GitHub Anda memakai `Dockerfile` yang sudah ada. Semua langkah bisa dilakukan lewat browser di HP.

1. Pastikan repo GitHub berisi isi folder `pos-sate-online` (file `Dockerfile` dan `server.js` di bagian atas repo), dan repo dalam mode **Private**. Jangan unggah `.env` dan folder `data`.
2. Daftar di railway.com dengan akun GitHub → **New Project → Deploy from GitHub repo** → pilih repo ini.
3. Buka layanan yang terbuat → tab **Variables**, tambahkan:
   - `POS_PASSWORD` = sandi owner Anda (bukan sandi contoh)
   - `RAILWAY_RUN_UID` = `0` (agar aplikasi boleh menulis ke volume)
   - `STORE_TZ` = `Asia/Jakarta` (atau `Asia/Kuala_Lumpur`)
4. Tab **Settings → Volumes → New Volume**, **Mount path** `/data`. Tanpa volume, data hilang setiap kali server dipasang ulang.
5. Tab **Settings → Networking → Generate Domain**. Buka alamat yang muncul (`xxxx.up.railway.app`): halaman login tampil. Login dengan username `owner`.
6. Domain sendiri: di **Networking → Custom Domain** masukkan `streetsateoriginal.my.id`, lalu buat record DNS yang diminta Railway. Ketersediaan fitur ini untuk paket gratis belum dipastikan; jika tidak ada, pakai alamat Railway di atas untuk kasir dan kartu QR.

**Yang perlu diketahui**
- Paket gratis Railway memberi kredit **$1 per bulan**, dengan volume 0,5 GB. Jika kredit habis, layanan berhenti ([ketentuan resmi](https://docs.railway.com/reference/pricing/plans)). Pantau pemakaian di dashboard. Untuk kasir yang dipakai tiap hari, paket berbayar terendah lebih aman.
- Data berada di volume Railway. Unduh ekspor data dari menu Pengaturan secara berkala sebagai cadangan.
- Memperbarui aplikasi: kirim perubahan ke GitHub, Railway memasang ulang otomatis; data di volume tetap.

## 3. Cara kerja

- Setiap perubahan (penjualan, edit menu, stok, pengaturan) disimpan dulu di perangkat, lalu **otomatis dikirim ke server** dalam sekitar 1 detik. Perangkat lain menerimanya dalam beberapa detik (cek berkala dan saat aplikasi dibuka kembali).
- Titik hijau di tombol menu = tersinkron, oranye = sedang sinkron, merah = offline atau perlu login. Ketuk kotak "Tersinkron" di menu samping untuk sinkron manual.
- **Offline:** kasir tetap berjalan. Begitu online lagi, perubahan dikirim.
- **Dua perangkat mengubah data bersamaan:** server memakai nomor versi. Jika bentrok, aplikasi menggabungkan otomatis:
  - semua transaksi dari kedua sisi dipertahankan (nomor invoice memuat kode perangkat, mis. `INV-20261014-K7P-0005`, jadi tidak kembar);
  - stok digabung sebagai selisih (stok 40, perangkat A jual 1 dan B jual 2 → 37);
  - perubahan lain digabung per kolom; jika kolom yang sama diubah di dua tempat, perubahan perangkat yang sedang sinkron yang dipakai.
- Database `data/pos.db` (SQLite) berisi dokumen utama plus tabel `items`, `orders`, `order_lines` yang bisa Anda query langsung untuk laporan, mis.
  `sqlite3 data/pos.db "select date(t), sum(total) from orders group by 1"`.

## 3a. Pesanan pelanggan lewat QR

Pelanggan memesan sendiri dari HP. Halamannya **terpisah** dari aplikasi kasir:

| | Alamat | Login |
|---|---|---|
| Aplikasi kasir | `https://streetsateoriginal.my.id/` | pakai kata sandi |
| Menu pelanggan | `https://streetsateoriginal.my.id/order` | tanpa login |

**Cara pakai**
1. Di aplikasi kasir buka **Pesanan Online** (ikon lonceng) lalu **Tampilkan / Cetak QR**. Isi nomor meja bila ingin QR per meja (`/order?t=5`), lalu cetak kartu QR atau unduh PNG-nya dan tempel di meja.
2. Pelanggan scan, **mengisi nama** (wajib), memilih menu, lalu **Kirim Pesanan**. Mereka mendapat nomor antrean (`#001`, reset tiap hari) dan bisa melihat status: terkirim, disiapkan, selesai.
3. Di kasir pesanan muncul seketika dengan bunyi, lencana di lonceng, dan tiket **tercetak otomatis** (nama, meja, item, catatan).
4. Tekan **Terima** (pelanggan melihat "disiapkan"), lalu **Bayar** saat pelanggan membayar: keranjang terisi otomatis dari pesanan, nama pelanggan terisi, stok berkurang, dan pesanan tertaut ke nomor invoice.

**Aturan sistem**
- Harga dan stok selalu dihitung ulang server dari data kasir. Harga yang dikirim dari HP diabaikan; menu habis ditolak.
- Pembayaran tetap di kasir (belum ada pembayaran online). Tiket bertuliskan "BELUM DIBAYAR".
- Pelanggan hanya bisa membatalkan selama pesanan belum diterima kasir.
- Tombol **Terima pesanan dari pelanggan** menutup/membuka pemesanan. Saat ditutup, pelanggan melihat pesan yang Anda tulis.
- Satu pesanan hanya dicetak oleh **satu** perangkat, meski beberapa kasir terbuka sekaligus. Matikan "Cetak tiket otomatis" di perangkat yang tidak terhubung printer.
- Batas anti-spam: 40 pesanan per 10 menit per alamat IP (atur dengan `ORDER_RATE`). Zona waktu antrean harian diatur dengan `STORE_TZ` (default `Asia/Jakarta`).

**Batasan yang perlu diketahui**
- Notifikasi dan cetak otomatis jalan selama **aplikasi kasir terbuka** di satu perangkat (layar dijaga tetap menyala secara default). Jika aplikasi ditutup, pesanan tetap tersimpan di server dan langsung tercetak begitu aplikasi dibuka lagi. Notifikasi push saat aplikasi tertutup belum ada.
- Cetak **tanpa dialog** hanya bisa lewat printer Bluetooth, USB-serial, atau RawBT. Pada mode "Cetak browser" setiap tiket memunculkan dialog cetak; untuk menghilangkannya jalankan Chrome dengan `--kiosk-printing`.
- Setelah halaman dimuat ulang, Bluetooth tersambung kembali otomatis hanya jika Chrome mengizinkan (fitur izin permanen). Jika tidak, tekan **Sambungkan printer** sekali; tiket yang menunggu langsung tercetak.
- Peramban lama tanpa Web Audio/Notification tetap berfungsi, hanya tanpa bunyi/notifikasi sistem.

## 3b. Login, pengguna, dan hak akses

Aplikasi kasir memakai halaman login (**username + kata sandi**). Ada dua peran:

| | Owner | Karyawan |
|---|---|---|
| Kasir (berjualan, tambah/kurangi item, bayar, cetak struk) | ✅ | ✅ |
| Pesanan Online (QR), menutup/membuka pemesanan | ✅ | izin **Pesanan Online** |
| Inventori (menu, harga, modal, stok, urutan menu) | ✅ | izin **Inventori** |
| Riwayat penjualan | ✅ | izin **Riwayat** |
| Printer | ✅ | izin **Printer** |
| Pengaturan toko, desain struk, bahasa, mata uang | ✅ | izin **Pengaturan** |
| Menghapus/mengubah riwayat penjualan, backup & ekspor data | ✅ | ❌ (khusus owner) |
| Kelola pengguna, log aktivitas | ✅ | ❌ (khusus owner) |

- Owner menambah karyawan di menu **Pengguna**: nama, username, sandi awal, lalu centang izin tambahan. Izin bawaan karyawan baru: Pesanan Online + Printer.
- Perubahan izin, reset sandi, dan penonaktifan akun **langsung berlaku** (menu karyawan menyesuaikan dalam ~12 detik; sesi yang dinonaktifkan otomatis keluar).
- Setiap transaksi mencatat nama kasir (tampil di Riwayat dan, bila dinyalakan di Desain Struk, di struk).
- Setiap orang bisa mengganti sandinya sendiri lewat kartu nama di bawah menu samping. Owner bisa mereset sandi karyawan dan menambah owner lain.
- Server menolak (HTTP 403) setiap perubahan di luar izin, jadi karyawan tidak bisa menembusnya walau memakai alat pengembang browser. Sistem tidak mengizinkan owner terakhir dihapus, dinonaktifkan, atau diturunkan.
- **Lupa sandi owner?** Di VPS isi `RESET_OWNER_PASSWORD=1` dan `POS_PASSWORD=sandi-baru` di `.env`, jalankan `docker compose up -d`, login, lalu hapus `RESET_OWNER_PASSWORD` dan jalankan ulang.

**Yang perlu diketahui**
- Karena aplikasi menyinkronkan seluruh data ke tiap perangkat, perangkat karyawan tetap *menerima* data modal dan riwayat (hanya disembunyikan di layar). Yang dijamin server adalah mereka tidak bisa *mengubahnya*. Jika data modal harus benar-benar rahasia dari karyawan, itu butuh pemisahan data di server (belum ada).
- Harga dan diskon pada transaksi baru dari karyawan tidak diperiksa ulang server; pantau lewat Riwayat dan nama kasir.
- Sandi disimpan sebagai hash scrypt. Login dibatasi 8 kali salah per alamat IP (ditahan 10 menit).

## 4. Keamanan

- Semua API (kecuali login dan halaman pelanggan `/order`) butuh token per pengguna. Mengganti sandi, mereset sandi, mengubah peran, atau menonaktifkan akun **mematikan token lama** pengguna itu. `POS_PASSWORD` tidak lagi dipakai setelah akun owner pertama dibuat.
- Login dibatasi: 8 kali salah dari satu alamat IP → ditahan 10 menit.
- Selalu pakai HTTPS (otomatis lewat Caddy). Web Bluetooth untuk printer juga hanya bisa di HTTPS atau localhost.
- Akun dan peran terpisah per orang (lihat 3b). Aktivitas penting (login, gagal login, perubahan pengguna, upaya ditolak) tercatat di log yang hanya dilihat owner.

## 5. Backup dan pemulihan

Data aman berlapis:

1. Database SQLite di volume Docker `pos-data` (`/data`).
2. **Snapshot server harian**, 30 hari terakhir: Pengaturan > Database & Penyimpanan > Snapshot Server > Pulihkan.
3. **File JSON harian** di `data/backups/` (30 hari terakhir).
4. Di aplikasi: **Unduh dari Server** menghasilkan satu file JSON; **Pulihkan dari File** mengembalikannya.

Disarankan menyalin volume ke tempat lain secara berkala, mis. cron harian:

```bash
docker run --rm -v pos-sate-online_pos-data:/data -v $HOME/backup:/backup alpine \
  tar czf /backup/pos-$(date +%F).tgz -C /data .
```

Memulihkan: hentikan server, ganti isi `/data` dengan backup, jalankan lagi.

## 6. Memperbarui aplikasi

Ganti `public/index.html` dengan versi baru lalu `docker compose up -d --build`. Perangkat memuat versi baru saat dibuka (service worker memakai jaringan lebih dulu).

## 7. Batasan yang perlu diketahui

- Gambar menu disimpan di dalam dokumen data, jadi setiap sinkron mengirim seluruh dokumen (biasanya beberapa ratus KB). Untuk puluhan item itu wajar; jika foto banyak dan besar, kecilkan fotonya.
- Cakupan satu toko/satu database. Belum ada multi-cabang.
- Printer Bluetooth tetap perlu Chrome di Android/Windows/Mac. iPhone butuh browser seperti Bluefy, atau pakai mode cetak browser.

## 8. Pengujian

```bash
npm test                 # tes API server + tes pesanan pelanggan
python3 test/e2e.py      # tes browser dua perangkat (perlu playwright dan server berjalan di :3777)
node test/deploy.test.js # tes mode komputer toko + Cloudflare (.env, IP asli)
python3 test/e2e_auth.py # tes browser login, pengguna, dan hak akses (server dijalankan otomatis)
python3 test/e2e_co.py   # tes browser pesanan QR: pelanggan -> notifikasi -> cetak -> bayar (server dijalankan otomatis)
```
