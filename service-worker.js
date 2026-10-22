/* service-worker.js: PWA offline da Plataforma NTN 2.0 (RF-07, H2).
   Estratégias:
   - HTML, JS, CSS e JSON do próprio site: Network First (versão nova sempre chega), cache como reserva offline.
   - Fontes Google e Leaflet (unpkg): Stale While Revalidate.
   - API ntn-lab: Network First; só GET com status 200 vai para o cache, com __cachedAt (ISO) injetado no JSON.
   - Tiles, Valhalla, OSRM, nRF Cloud e qualquer POST: direto da rede, nunca em cache. */
const VERSION = 'ntn-v36';
const STATIC = VERSION + '-static';
const CDN = VERSION + '-cdn';
const API_CACHE = VERSION + '-api';
const API_MAX_AGE_MS = 48 * 3600 * 1000;

const ASSETS_V2 = [
  './', './index.html', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png',
  './api-core.js', './pwa.js', './health-badge.js', './switch-timeline.js', './apresentacao.js',
  './ntn/', './ntn/index.html', './ntn/pro-core.js', './ntn/pro.js', './ntn/sim.js', './ntn/satsig.js',
  './ntn/pointing.js', './ntn/busca-ui.js', './ntn/hero.js', './ntn/trajeto.js', './ntn/insights.js',
  './ntn/alerts-ui.js', './ntn/replay.json', './ntn/pro.css', './ntn/hero.css', './ntn/ntn.css', './ntn/deck-theme.css',
  './utilities/', './utilities/index.html', './utilities/utilities.js', './utilities/sat-live.js',
  './utilities/hero-u.js', './utilities/alerts-u.js', './utilities/utilities.css',
  './consumo/', './consumo/index.html', './consumo/consumo.js',
];

const NETWORK_ONLY = /valhalla|project-osrm|arcgisonline|tile\.openstreetmap|nrfcloud/i;
const CDN_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com|unpkg\.com/i;
const isApi = (url) => url.pathname.includes('/.netlify/functions/ntn-lab');

// Chave estável da API: remove o parâmetro anti-cache t=...
function apiKey(url) {
  const u = new URL(url.href); u.searchParams.delete('t'); u.searchParams.sort();
  return new Request(u.href, { method: 'GET' });
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(STATIC);
    // Cache individual: um asset ausente não derruba o install.
    await Promise.all(ASSETS_V2.map(async (a) => {
      try { const r = await fetch(a, { cache: 'reload' }); if (r.ok) await c.put(a, r); } catch (err) { /* segue sem esse asset */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = [STATIC, CDN, API_CACHE];
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function networkFirstStatic(req) {
  const c = await caches.open(STATIC);
  try {
    const res = await fetch(req);
    if (res && res.status === 200 && res.type === 'basic') c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(req) || await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') { const idx = await c.match('./ntn/'); if (idx) return idx; }
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const c = await caches.open(CDN);
  const hit = await c.match(req);
  const net = fetch(req).then((res) => { if (res && (res.status === 200 || res.type === 'opaque')) c.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || Response.error();
}

async function networkFirstApi(req, url) {
  const c = await caches.open(API_CACHE);
  const key = apiKey(url);
  try {
    const res = await fetch(req);
    if (res && res.status === 200) {
      try {
        const j = await res.clone().json();
        if (j && typeof j === 'object' && !Array.isArray(j)) {
          j.__cachedAt = new Date().toISOString();
          await c.put(key, new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
        }
      } catch (err) { /* resposta não é JSON: não guarda */ }
    }
    return res;
  } catch (err) {
    const hit = await c.match(key);
    if (hit) {
      try {
        const j = await hit.clone().json();
        if (Date.now() - Date.parse(j.__cachedAt) <= API_MAX_AGE_MS) return hit;
      } catch (e2) { /* ignora */ }
    }
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // POST (Valhalla etc.) nunca passa pelo cache
  const url = new URL(req.url);
  if (isApi(url)) { e.respondWith(networkFirstApi(req, url)); return; }
  if (NETWORK_ONLY.test(url.host) || NETWORK_ONLY.test(url.pathname)) return;
  if (CDN_HOSTS.test(url.host)) { e.respondWith(staleWhileRevalidate(req)); return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/.netlify/functions/') || url.pathname.includes('/api')) return;
  e.respondWith(networkFirstStatic(req));
});
