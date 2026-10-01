const CACHE_NAME = 'veritas-shell-v1';
const CORE_ASSETS = [
  '/', '/index.html', '/manifest.webmanifest',
  '/icons/icon-72.png', '/icons/icon-96.png', '/icons/icon-128.png',
  '/icons/icon-144.png', '/icons/icon-152.png', '/icons/icon-180.png',
  '/icons/icon-192.png', '/icons/icon-384.png', '/icons/icon-512.png',
];

function sameOriginStaticUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin && /\.(?:m?js|css|woff2?|ttf|otf|png|svg|ico)$/i.test(url.pathname);
  } catch { return false; }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(CORE_ASSETS.map(async path => {
      try {
        const response = await fetch(path, { cache: 'reload' });
        if (response.ok) await cache.put(path, response);
      } catch { /* Leave unavailable optional shell entries uncached. */ }
    }));
    try {
      const response = await fetch('/index.html', { cache: 'reload' });
      if (response.ok) {
        await cache.put('/index.html', response.clone());
        await cache.put('/', response.clone());
        const html = await response.text();
        const links = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)].map(match => match[1]).filter(sameOriginStaticUrl);
        await Promise.all(links.map(async path => {
          try {
            const asset = await fetch(path, { cache: 'reload' });
            if (asset.ok) await cache.put(path, asset);
          } catch { /* Runtime requests can fill this cache when online. */ }
        }));
      }
    } catch { /* The offline shell can still use any prior cache. */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('veritas-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put('/index.html', response.clone());
          await cache.put('/', response.clone());
        }
        return response;
      } catch {
        return (await caches.match('/')) || (await caches.match('/index.html')) || Response.error();
      }
    })());
    return;
  }

  if (!['script', 'style', 'font', 'image', 'manifest'].includes(request.destination) && !sameOriginStaticUrl(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
      return response;
    } catch {
      return Response.error();
    }
  })());
});
