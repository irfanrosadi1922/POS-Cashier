# POS SATE di GitHub Pages + Supabase (hanya akun GitHub + iPhone)

Tidak perlu VPS, komputer toko, atau kartu kredit. Semua langkah bisa dari Safari di iPhone.
Anda hanya butuh **akun GitHub**; Supabase cukup dimasuki dengan tombol "Continue with GitHub".

## 1. Buat database (Supabase)
1. Buka **supabase.com** → **Sign in** → **Continue with GitHub**.
2. **New project** → nama `pos-sate`, buat *Database Password* (simpan, tidak dipakai kasir), region **Singapore** → **Create**. Tunggu ±2 menit.
3. Menu **SQL Editor** → **New query** → tempel **seluruh isi `setup.sql`** → **Run**. Harus muncul "Success".
4. **New query** lagi, tempel (ganti sandi sementara Anda, minimal 6 karakter):
   ```sql
   select pos.admin_owner('owner', 'GANTI-SANDI-SEMENTARA');
   select pos.admin_tz('Asia/Jakarta');
   ```
   (zona waktu lain: `Asia/Makassar`, `Asia/Jayapura`, `Asia/Kuala_Lumpur`). **Run**. Setelah login pertama, ganti sandi lewat menu akun di aplikasi.
5. **Project Settings → API** (atau tombol **Connect**): salin **Project URL** dan **Publishable key** (`sb_publishable_…`, atau `anon public`). *Jangan* memakai `secret` / `service_role`.

## 2. Pasang aplikasi (GitHub)
1. github.com → **+** → **New repository** → nama bebas (mis. `pos-sate`) → **Public** → Create.
   (GitHub Pages gratis memerlukan repo Public. Tidak ada data toko di repo: hanya kode. Kunci publishable memang boleh publik.)
2. **Add file → Upload files** → pilih semua berkas dari folder ini (index.html, order.html, config.js, sbapi.js, sw.js, manifest.webmanifest, icon-192.png, icon-512.png, .nojekyll) → **Commit changes**.
3. Buka `config.js` → ikon pensil → isi:
   ```js
   window.POS_SB = { url: 'https://XXXX.supabase.co', key: 'sb_publishable_XXXX' };
   ```
   → **Commit changes**.
4. **Settings → Pages** → *Source*: **Deploy from a branch** → branch `main`, folder `/ (root)` → **Save**. Tunggu 1–2 menit; alamat tampil: `https://NAMAANDA.github.io/pos-sate/`.

## 3. Pakai
- Buka alamat itu di Safari → login `owner` → **Bagikan → Tambah ke Layar Utama**.
- Menu **Pesanan Online → QR** menampilkan QR meja; pelanggan membuka `…/order.html?t=NOMOR_MEJA`.
- Karyawan: menu **Pengguna** (khusus owner) untuk membuat akun dan mengatur izin.
- Domain sendiri (opsional): Settings → Pages → *Custom domain*, lalu buat DNS `CNAME` ke `NAMAANDA.github.io`.

## Batasan yang perlu diketahui
- **Proyek Supabase gratis dijeda bila 1 minggu tanpa aktivitas.** Buka dashboard Supabase → *Restore*; data tidak hilang. Dipakai harian = aman.
- Notifikasi bunyi & **auto-print hanya jalan saat aplikasi terbuka** di layar (iPhone tidak mengizinkan Safari bekerja di latar belakang). Biarkan layar menyala.
- Printer Bluetooth: Safari iPhone tidak punya Web Bluetooth. Pakai browser **Bluefy** (gratis, App Store) atau cetak lewat AirPrint/RawBT di Android.
- Foto menu disimpan di database; pakai foto kecil agar cepat dan hemat kuota gratis (egress 5 GB/bulan).
- Cadangan: Supabase gratis tidak punya cadangan otomatis, tetapi aplikasi menyimpan 30 snapshot harian di database dan menu **Ekspor** mengunduh JSON. Unduh berkala.
- Karyawan yang login tetap menerima data modal/riwayat di perangkatnya (disembunyikan di tampilan, perubahan terlarang ditolak server). Beri akun hanya kepada orang tepercaya.
- Lupa sandi owner: jalankan lagi `select pos.admin_owner('owner','SANDI-BARU');` di SQL Editor.
