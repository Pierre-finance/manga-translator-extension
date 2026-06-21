// Service worker minimal : précache la coquille, puis cache-first pour le
// même-origine (met en cache au passage les gros fichiers Tesseract → OCR hors-ligne
// après la 1ʳᵉ utilisation). Les appels d'API (autres origines) passent direct au réseau.
const CACHE = 'mt-web-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.webmanifest',
  '../sidepanel/providers.js',
  '../lib/tesseract/tesseract.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const sameOrigin = new URL(req.url).origin === location.origin;
  if (!sameOrigin) return; // APIs IA / MyMemory : réseau direct, jamais en cache

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return resp;
    }).catch(() => hit))
  );
});
