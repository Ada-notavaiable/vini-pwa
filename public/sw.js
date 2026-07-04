// Vini PWA — service worker
// Cache-first per gli asset statici, network-only per le API.

const CACHE_NAME = 'vinipwa-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/negozi.html',
  '/stats.html',
  '/storage.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // API e foto: solo rete.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(new Request(req, { cache: 'no-store' }))
        .catch(() => new Response(JSON.stringify({ error: 'offline' }), {
          status: 503, headers: { 'Content-Type': 'application/json' }
        }))
    );
    return;
  }
  if (url.pathname.startsWith('/photos/')) {
    event.respondWith(
      fetch(req).catch(() => caches.match('/icon-192.png'))
    );
    return;
  }

  // Asset statici: cache-first, fallback rete → cache → offline index.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && req.method === 'GET') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => {
        if (req.mode === 'navigate') return caches.match('/index.html');
        return new Response('', { status: 504 });
      });
    })
  );
});

// Permette all'app di forzare un update via postMessage.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
