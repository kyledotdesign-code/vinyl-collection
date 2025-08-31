// sw.js — minimal, safe, network-first for same-origin only
const VERSION = 'v9';
const APP_CACHE = `app-${VERSION}`;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('app-') && k !== APP_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Let the browser handle cross-origin, non-GET, or range requests
  if (req.method !== 'GET' || req.headers.has('range') || url.origin !== location.origin) {
    return;
  }

  // Same-origin: network-first, cache fallback
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      // Cache a copy, but don't block the response
      caches.open(APP_CACHE).then((c) => c.put(req, fresh.clone())).catch(() => {});
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      // Always return a valid Response so we never hit "Failed to convert value to 'Response'"
      return new Response('', { status: 504, statusText: 'Gateway Timeout' });
    }
  })());
});
