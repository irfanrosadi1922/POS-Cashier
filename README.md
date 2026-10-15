# POS SATE Online

Aplikasi kasir POS SATE yang berjalan online: data tersimpan otomatis di **database SQLite di server**, disinkronkan ke semua perangkat (HP, tablet, komputer), dan tetap bisa dipakai saat internet putus.

- Tanpa dependensi npm. Cukup **Node.js 22.13 atau lebih baru** (memakai `node:sqlite` bawaan), atau Docker.
- Login dengan kata sandi, HTTPS otomatis lewat Caddy, snapshot harian, dan backup file harian.
- Bisa dipasang sebagai aplikasi layar penuh (PWA) dari browser.

## 1. Coba di komputer sendiri

```bash
POS_PASSWORD="sandi-anda" npm start
# buka http://localhost:3000
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
4. Di folder itu: `cp .env.example .env` lalu isi `POS_PASSWORD` dengan sandi yang kuat.
5. Jalankan: `docker compose up -d --build`
6. Buka **https://streetsateoriginal.my.id**. Sertifikat HTTPS diurus otomatis oleh Caddy (port 80 dan 443 harus terbuka di firewall VPS).

Untuk domain lain, ubah baris pertama `Caddyfile`.

### Alternatif tanpa VPS sendiri
Railway, Fly.io, atau layanan sejenis bisa dipakai, **asalkan** ada *persistent volume* yang di-mount ke `/data` (di situ database disimpan). Jangan pakai paket gratis tanpa disk permanen (mis. Render free): data akan hilang saat server restart. Atur variabel `POS_PASSWORD`, `DATA_DIR=/data`, `TRUST_PROXY=1`, lalu arahkan domain sesuai petunjuk layanan tersebut.

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

## 4. Keamanan

- Semua API (kecuali halaman login) butuh token. Token berlaku 90 hari di perangkat; **mengganti `POS_PASSWORD` membuat semua token lama tidak berlaku**.
- Login dibatasi: 8 kali salah dari satu alamat IP → ditahan 10 menit.
- Selalu pakai HTTPS (otomatis lewat Caddy). Web Bluetooth untuk printer juga hanya bisa di HTTPS atau localhost.
- Satu kata sandi untuk semua kasir. Belum ada akun/peran terpisah.

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
python3 test/e2e_co.py   # tes browser pesanan QR: pelanggan -> notifikasi -> cetak -> bayar (server dijalankan otomatis)
```
