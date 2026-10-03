const CACHE = 'thingy91x-v33';
const ASSETS = ['./manifest.json', './icon.svg'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => (k === CACHE ? null : caches.delete(k)))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return; // POST (Valhalla) nunca passa pelo cache
  const url = new URL(e.request.url);
  if (/valhalla|project-osrm|arcgisonline|tile\.openstreetmap/.test(url.host)) return; // mapas/rotas: direto da rede
  if (url.pathname.includes('/api') || url.pathname.includes('nrfcloud') || url.host.includes('tile.openstreetmap')) return;
  // HTML/JS sempre da rede (evita modal antigo)
  if (url.pathname.endsWith('.html') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname === '/' || url.pathname.endsWith('/')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
