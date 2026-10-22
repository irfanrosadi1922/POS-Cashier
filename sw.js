/* Service worker: aplikasi tetap terbuka saat internet putus. Data tidak di-cache di sini (disimpan lokal oleh aplikasi). */
const V = 'pos-sate-v5';
const SHELL = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || /\/(api|img)\//.test(u.pathname) || /\/(order|pesan|o)(\.html)?$/.test(u.pathname) || u.pathname.endsWith('/config.js')) return;
  e.respondWith(
    fetch(r).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(V).then((c) => c.put(r, copy)); }
      return res;
    }).catch(() => caches.match(r).then((m) => m || caches.match('./')))
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const c = cs.find((x) => x.url.startsWith(self.registration.scope)) || cs[0];
    if (c) return c.focus();
    return self.clients.openWindow(self.registration.scope);
  }));
});

/* notifikasi push dari server saat pesanan online masuk (aplikasi boleh tertutup) */
self.addEventListener('push', (e) => {
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    if (cs.some((c) => c.visibilityState === 'visible')) return;   // aplikasi sedang terbuka: bunyi & notifikasi diurus aplikasi
    return self.registration.showNotification('Pesanan online baru', {
      body: 'Ketuk untuk membuka kasir', tag: 'co', renotify: true, icon: 'icon-192.png', badge: 'icon-192.png', vibrate: [250, 100, 250, 100, 400], requireInteraction: true
    });
  }));
});
