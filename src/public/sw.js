// Network-first for the app shell so a new release is picked up straight
// away; the cache is only an offline fallback. Nothing under /api/ is ever
// cached: responses there are per-person.
const CACHE = 'hushlist-shell-v3';
const SHELL = [
  '/', '/styles.css', '/manifest.webmanifest', '/fonts/fraunces-latin.woff2', '/icons/icon.svg',
  '/js/theme.js', '/js/main.js', '/js/app.js', '/js/dom.js', '/js/api.js', '/js/icons.js', '/js/parts.js',
  '/js/art.js', '/js/qr.js', '/js/confetti.js',
  '/js/views/home.js', '/js/views/list.js', '/js/views/gifting.js', '/js/views/gifts.js',
  '/js/views/circles.js', '/js/views/inbox.js', '/js/views/admin.js', '/js/views/welcome.js'
];

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
      const fresh = await fetch(request);
      if (fresh.ok && SHELL.includes(url.pathname)) {
        const cache = await caches.open(CACHE);
        cache.put(url.pathname, fresh.clone());
      }
      return fresh;
    } catch {
      const cache = await caches.open(CACHE);
      // App routes (/gifting, /l/…) all share one shell document.
      const cached = await cache.match(request.mode === 'navigate' ? '/' : url.pathname);
      return cached || Response.error();
    }
  })());
});
