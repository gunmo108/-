// Service Worker: オフライン対応 + オンライン時は最新を取得
// 方式: network-first（同一オリジンGET）。オンラインなら常に最新を配信し
// キャッシュを更新、オフライン時のみキャッシュ→index.html にフォールバック。
const CACHE = 'ern-rounds-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './css/style.css',
  './js/app.js',
  './js/ui.js',
  './js/db.js',
  './js/logic.js',
  './js/clinical.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then(cached => cached || caches.match('./index.html')))
  );
});
