// Basic SW to speed up repeat visits (cache static + images)
const CACHE_NAME = "vinyl-cache-v1";
const IMG_HOST = "wsrv.nl";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) =>
      c.addAll(["/","/index.html","/styles.css","/app.js","/favicon.svg","/manifest.webmanifest"].filter(Boolean))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Cache-first for images from wsrv.nl (album art)
  if (url.hostname.endsWith(IMG_HOST)) {
    e.respondWith(
      caches.match(e.request).then(hit =>
        hit || fetch(e.request).then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
          return res;
        }).catch(()=>hit)
      )
    );
    return;
  }

  // Network-first for everything else
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
      return res;
    }).catch(()=>caches.match(e.request))
  );
});
