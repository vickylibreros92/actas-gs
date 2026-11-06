/* Service worker: deja la app disponible sin internet, se actualiza sola
   y sube las actas pendientes en segundo plano (Android/Chrome). */
importScripts('envio-core.js');
const VERSION = '20261106111024';
const CACHE = 'acta-gam006-' + VERSION;
const ARCHIVOS = ['./', 'index.html', 'pdf-lib.min.js', 'plantilla.pdf', 'envio-core.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'favicon-32.png'];

self.addEventListener('install', e => {
  // descarga la versión nueva completa y la activa de inmediato
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Con señal: siempre la versión más reciente del servidor. Sin señal: la copia guardada.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(req, { cache: 'no-cache', signal: ctrl.signal }); clearTimeout(t);
      if (r && r.ok) c.put(req, r.clone());
      return r;
    } catch (err) {
      const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await c.match('index.html') : null);
      return hit || new Response('Sin conexión', { status: 503 });
    }
  })());
});
// Background Sync: el navegador lo dispara al recuperar la conexión, aunque la app esté cerrada
self.addEventListener('sync', e => {
  if (e.tag !== 'subir-actas') return;
  e.waitUntil(ENVIO.procesar(true).then(r => { if (r.pendientes > 0) throw new Error('Quedan actas pendientes'); }));
});
self.addEventListener('message', e => {
  if (e.data === 'procesar') e.waitUntil(ENVIO.procesar(true));
  if (e.data === 'version' && e.source) e.source.postMessage({ version: VERSION });
});
