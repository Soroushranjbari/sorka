const CACHE = 'co-os-v18-19';
const ASSETS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  // Only GET is cacheable (cache.put rejects for POST/PUT/… with an unhandled
  // rejection) and a cached response must never answer a mutating request.
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // never intercept the sync API
  if (url.pathname.startsWith('/shop')) return; // shop is online-only marketing — no SW, no cache collisions (?plan=…)
  /* App shell (navigations): NETWORK-FIRST. Cache-first here was the root of
     the "new UI appears, then an old shell comes back" flip-flop: the stale
     cached index.html answered instantly while the new SW installed in the
     background, so consecutive loads (and the many open tabs) alternated
     between versions. Online the shell must ALWAYS come from the network;
     the cache is only the offline fallback. */
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request, { ignoreSearch: true })
        .then(r => r || caches.match('./index.html')))
    );
    return;
  }
  // Other same-origin assets: cache-first (they only change with a CACHE bump)
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }))
    );
    return;
  }
  // Cross-origin (fonts): stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then(r => {
      const net = fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => r);
      return r || net;
    })
  );
});
