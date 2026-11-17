// App-shell cache only. Booking data is always fetched live (no offline booking, PLAN §6).
const CACHE = 'tira-v1';
const ROOT = self.registration.scope;               // works at / and at /tira/
const ASSETS = new URL('assets/', ROOT).pathname;
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.add(ROOT))); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(ROOT, cp)); return r; }).catch(() => caches.match(ROOT)));
    return;
  }
  if (u.pathname.startsWith(ASSETS)) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r; })));
  }
});
