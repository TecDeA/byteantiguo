/* =========================================================
   Service Worker · Byte (split-flap)
   Estrategia:
     - Navegación  → red primero, caché como respaldo
     - Estáticos   → caché primero con revalidación en 2º plano
   ========================================================= */

const VERSION = 'v1.0.3';
const CACHE_STATIC  = `byte-static-${VERSION}`;
const CACHE_RUNTIME = `byte-runtime-${VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

/* ---------- install ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_STATIC);

    // Precarga resiliente: un 404 no rompe toda la instalación
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        await cache.put(url, res);
      } catch (err) {
        console.warn('[SW] No se pudo precachear:', url, err);
      }
    }));

    await self.skipWaiting();
  })());
});

/* ---------- activate ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== CACHE_STATIC && k !== CACHE_RUNTIME)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();

    // Difunde la versión a todos los clientes (también a los que aún no
    // controla) para que el chip pueda mostrarla de forma proactiva,
    // sin necesidad de que la página la pida explícitamente.
    const clients = await self.clients.matchAll({
      includeUncontrolled: true,
      type: 'window'
    });
    const payload = { type: 'VERSION', version: VERSION };
    clients.forEach((c) => {
      try { c.postMessage(payload); } catch (e) { /* noop */ }
    });
  })());
});

/* ---------- fetch ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Solo gestionamos mismo origen
  if (url.origin !== self.location.origin) return;

  /* --- Navegación: red primero, caché como respaldo --- */
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const copy = res.clone();
        caches.open(CACHE_STATIC).then((c) => c.put('./index.html', copy));
        return res;
      } catch (err) {
        const cached =
          (await caches.match(req, { ignoreSearch: true })) ||
          (await caches.match('./index.html')) ||
          (await caches.match('./'));
        if (cached) return cached;
        return new Response(
          '<h1>Sin conexión</h1><p>Vuelve a intentarlo cuando recuperes la red.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  /* --- Resto: caché primero + revalidación en segundo plano --- */
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });

    const networkPromise = fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_RUNTIME).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => null);

    return cached || (await networkPromise) || Response.error();
  })());
});

/* ---------- mensajes desde la página ---------- */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();

  // Petición de versión desde la página: respondemos por el puerto del canal
  // (o por event.source si no viene canal) para que el chip muestre la versión real.
  if (event.data === 'GET_VERSION') {
    const payload = { type: 'VERSION', version: VERSION };

    if (event.ports && event.ports.length > 0) {
      event.ports[0].postMessage(payload);
    } else if (event.source) {
      event.source.postMessage(payload);
    }
  }
});
