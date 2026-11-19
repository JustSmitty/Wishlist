// Network-first for the app shell, so a new release is picked up straight
// away; the cache is only an offline fallback. Nothing under /api/ is ever
// cached: responses there are per-person.
//
// The server writes the version and file list into this file when it serves
// it (see buildServiceWorker in src/server.mjs). The offline copy is made
// once, completely, when a worker installs, and never patched afterwards, so
// it is always one consistent release.
const CACHE = '__VERSION__';
const SHELL = ['__SHELL__'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/share-target') return;

  event.respondWith((async () => {
    try {
      return await fetch(request);
    } catch {
      const cache = await caches.open(CACHE);
      // App routes (/gifting, /l/…) all share one shell document.
      const cached = await cache.match(request.mode === 'navigate' ? '/' : url.pathname);
      return cached || Response.error();
    }
  })());
});
