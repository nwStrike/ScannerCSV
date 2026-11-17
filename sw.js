/* Service worker de ScannerCSV: app shell en caché + caché en tiempo de ejecución del motor OCR. */
const VERSION = 'v1.0.0';
const SHELL_CACHE = `scannercsv-shell-${VERSION}`;
const RUNTIME_CACHE = 'scannercsv-runtime-v1';

const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/csv.js',
  'js/camera.js',
  'js/ocr.js',
  'js/barcode-worker.js',
  'vendor/zxing/zxing.min.js',
  'vendor/tesseract/tesseract.min.js',
  'vendor/tesseract/worker.min.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'icons/icon-maskable-512.png',
];

// Recursos externos que se guardan al usarse (motor wasm y datos de idioma de Tesseract).
const RUNTIME_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('scannercsv-shell-') && k !== SHELL_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Navegación: red primero (para recibir actualizaciones), caché si no hay conexión.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('index.html', res.clone());
        return res;
      } catch {
        return (await caches.match('index.html', { ignoreSearch: true })) || Response.error();
      }
    })());
    return;
  }

  // App shell: caché primero, actualizando en segundo plano.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (cached) { event.waitUntil(network); return cached; }
      return (await network) || Response.error();
    })());
    return;
  }

  // CDN (Tesseract core y datos de idioma): caché primero; las URL llevan versión fija.
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
      return res;
    })());
  }
});
