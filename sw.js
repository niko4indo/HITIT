const CACHE_NAME = 'hitit-static-v39-clear-password-keypad-000';
const baseUrl = new URL('./', self.registration.scope);
const coreFiles = ['index.html', 'storage.js', 'backup.js', 'cloud-sync.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'].map(file => new URL(file, baseUrl).toString());
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(coreFiles)));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('hitit-static-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const url = new URL(request.url);
  if (!url.pathname.startsWith(new URL(baseUrl).pathname)) return;
  event.respondWith(caches.open(CACHE_NAME).then(async cache => {
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      return cache.match(new URL('index.html', baseUrl).toString());
    }
  }));
});


