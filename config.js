/* Pengaturan koneksi. Biarkan "null" bila memakai server Node/Docker.
   Untuk GitHub Pages + Supabase isi seperti contoh (nilai ada di Supabase > Project Settings > API):
   window.POS_SB = { url: 'https://abcdxyz.supabase.co', key: 'sb_publishable_xxxxxxxx' };
   key = kunci PUBLISHABLE / anon (boleh publik). JANGAN PERNAH memakai secret / service_role. */
window.POS_SB = null;
