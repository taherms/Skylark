// Skylark Weather — service worker
// Bump this on every deploy that changes any cached file, so clients refresh cleanly.
const CACHE_VERSION = 'skylark-v1';
const SHELL_CACHE = `shell-${CACHE_VERSION}`;

// Paths are relative to the service worker's own scope, so this works whether the
// app lives at the domain root or under a GitHub Pages project subpath.
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/weather-scene.js',
  './js/charts.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-16.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name.startsWith('shell-') && name !== SHELL_CACHE)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Only manage requests to our own origin (the app shell). Weather/geocoding/AQ
  // API calls go straight to the network — live data should never be served stale.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      // Stale-while-revalidate: serve the cached shell instantly, refresh in background.
      return cached || network;
    })
  );
});
