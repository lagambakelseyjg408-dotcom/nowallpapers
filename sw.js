/* 无墙论文查询 · 离线壳：只缓存界面资源，接口永远走网络 */
const CACHE = 'nowall-shell-v3';
const SHELL = ['/', '/index.html', '/style.css?v=1.2.0', '/app.js?v=1.2.0', '/logo-96.png', '/icon.svg', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/files/')) {
    e.respondWith(caches.open('paperfree-pdf').then(async (c) => {
      const hit = await c.match(req);
      return hit || fetch(req);
    }));
    return;
  }

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html'))),
  );
});
