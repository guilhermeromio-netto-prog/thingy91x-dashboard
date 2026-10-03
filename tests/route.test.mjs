// node tests/route.test.mjs — lógica pura da trilha (v33): jitter, lacunas, saltos, paradas, lotes, ajuste às vias, filtros
import assert from 'node:assert/strict';
import '../route-core.js';
const RC = globalThis.RouteCore;
let pass = 0;
const t = (name, fn) => { const r = fn(); const fin = () => { pass++; console.log('ok  -', name); }; return r && r.then ? r.then(fin) : fin(); };
const NOW = Date.parse('2026-10-03T15:00:00Z'); // 12:00 BRT
const at = (min) => new Date(NOW - min * 60000).toISOString();
const P = (min, lat, lon, extra = {}) => ({ lat, lon, at: at(min), unc: 10, serviceType: 'GNSS', ...extra });
const M_LAT = 1 / 110574; // graus por metro (lat)
const M_LON = 1 / 102000; // graus por metro (lon, ~-23.5°)
const A = { lat: -23.5505, lon: -46.6333 };
const east = (m) => ({ lat: A.lat, lon: A.lon + m * M_LON });

await t('polyline6 encode/decode ida e volta', () => {
  const c = [[-23.5505, -46.6333], [-23.5614, -46.6559], [-23.55, -46.6]];
  const d = RC.decodePolyline(RC.encodePolyline(c, 6), 6);
  d.forEach((p, i) => { assert.ok(Math.abs(p[0] - c[i][0]) < 2e-6); assert.ok(Math.abs(p[1] - c[i][1]) < 2e-6); });
  assert.equal(RC.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5)[2][0], 43.252);
});

await t('startOfDaySP / hourSP em UTC-3', () => {
  assert.equal(new Date(RC.startOfDaySP(NOW)).toISOString(), '2026-10-03T03:00:00.000Z');
  assert.equal(RC.hourSP(Date.parse('2026-10-03T15:30:00Z')), 12.5);
  assert.equal(new Date(RC.startOfDaySP(Date.parse('2026-10-03T02:00:00Z'))).toISOString(), '2026-10-02T03:00:00.000Z');
});

await t('jitter < 15 m é fundido no mesmo nó (e o tempo é preservado em tEnd)', () => {
  const pts = [P(30, A.lat, A.lon), P(29, A.lat + 5 * M_LAT, A.lon), P(28, A.lat, A.lon + 8 * M_LON), P(27, ...Object.values(east(200)))].map((p, i) => i === 3 ? { ...p, lat: A.lat, lon: A.lon + 200 * M_LON } : p);
  const r = RC.prepare(pts);
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].nodes.length, 2);
  assert.equal(r.segments[0].nodes[0].members.length, 3);
  assert.equal(r.segments[0].nodes[0].tEnd - r.segments[0].nodes[0].t, 2 * 60000);
  const pair = r.pairs[0];
  assert.equal(pair.dtMs, 60000, 'dt conta a partir do último ponto parado, não do primeiro');
});

await t('acurácia ruim (>150 m) fica fora da linha e vai para rejeitados', () => {
  const r = RC.prepare([P(10, A.lat, A.lon), P(9, A.lat, A.lon + 100 * M_LON, { unc: 900, serviceType: 'SCELL' }), P(8, A.lat, A.lon + 200 * M_LON)]);
  assert.equal(r.rejected.length, 1); assert.equal(r.rejected[0].reason, 'acuracia');
  assert.equal(r.segments[0].nodes.length, 2);
});

await t('salto implausível (>250 km/h) é descartado, mas mudança real de local não', () => {
  const r = RC.prepare([P(10, A.lat, A.lon), P(9, A.lat + 0.3, A.lon), P(8, A.lat, A.lon + 300 * M_LON)]);
  assert.deepEqual(r.rejected.map(x => x.reason), ['salto']);
  assert.equal(r.segments[0].nodes.length, 2);
  // deslocamento real longo (avião/trem?) seguido de pontos coerentes = aceita
  const r2 = RC.prepare([P(10, A.lat, A.lon), P(9, A.lat + 0.3, A.lon), P(8, A.lat + 0.3, A.lon + 300 * M_LON)]);
  assert.equal(r2.rejected.length, 0);
});

await t('lacuna > 10 min divide em segmentos (não une)', () => {
  const r = RC.prepare([P(60, A.lat, A.lon), P(59, ...[A.lat, A.lon + 300 * M_LON]), P(30, A.lat, A.lon + 900 * M_LON), P(29, A.lat, A.lon + 1200 * M_LON)]);
  assert.equal(r.segments.length, 2);
  assert.equal(r.pairs.length, 2, 'nenhum par cruza a lacuna');
  const r2 = RC.prepare([P(60, A.lat, A.lon), P(51, A.lat, A.lon + 300 * M_LON)]); // 9 min: une
  assert.equal(r2.segments.length, 1);
  assert.equal(r2.pairs[0].estimated, true, '9 min entre pontos = trecho estimado');
});

await t('detecta paradas > 3 min com duração e ignora < 3 min', () => {
  const pts = [P(40, A.lat, A.lon), P(38, ...[A.lat, A.lon + 400 * M_LON]),
    P(35, A.lat, A.lon + 800 * M_LON), P(33, A.lat + 8 * M_LAT, A.lon + 800 * M_LON), P(31, A.lat, A.lon + 805 * M_LON), P(29, A.lat, A.lon + 800 * M_LON), // parou 6 min
    P(27, A.lat, A.lon + 1300 * M_LON), P(26, A.lat, A.lon + 1301 * M_LON), P(25, A.lat, A.lon + 1700 * M_LON)]; // 1 min: não é parada
  const r = RC.prepare(pts, { now: NOW });
  assert.equal(r.stops.length, 1);
  assert.equal(r.stops[0].durMs, 6 * 60000);
  assert.equal(r.stops[0].count, 4);
  assert.equal(r.stops[0].ongoing, false);
  const stoppedPairs = r.pairs.filter(p => p.stopped);
  assert.equal(stoppedPairs.length, 0, 'tudo dentro da parada foi fundido por jitter; o par de saída é movimento');
  const r3 = RC.prepare([P(10, A.lat, A.lon), P(5, A.lat, A.lon + 20 * M_LON), P(0, A.lat, A.lon + 10 * M_LON)], { now: NOW });
  assert.equal(r3.stops[0].ongoing, true); assert.equal(r3.stops[0].durMs, 10 * 60000);
});

await t('lotes: 80 pontos com 1 de sobreposição, chaves estáveis e independentes de pontos novos', () => {
  const nodes = (n) => Array.from({ length: n }, (_, i) => P(300 - i, A.lat, A.lon + i * 60 * M_LON));
  const r1 = RC.prepare(nodes(200)), c1 = RC.buildChunks(r1.segments, 80);
  assert.deepEqual(c1.map(c => c.nodes.length), [80, 80, 42]);
  assert.equal(c1[0].nodes[79], c1[1].nodes[0], 'sobreposição de 1 ponto liga os lotes');
  const r2 = RC.prepare(nodes(205).map((p, i) => p)), c2 = RC.buildChunks(r2.segments, 80);
  assert.equal(c2[0].key, c1[0].key); assert.equal(c2[1].key, c1[1].key);
  assert.notEqual(c2[2].key, c1[2].key, 'só o lote da ponta muda');
  assert.equal(RC.buildChunks(RC.prepare(nodes(80)).segments, 80).length, 1);
  assert.equal(RC.buildChunks(RC.prepare(nodes(81)).segments, 80).length, 2);
  assert.equal(RC.buildChunks(RC.prepare(nodes(1)).segments, 80).length, 0);
});

// ----- geometria "em L" (rua que dobra a esquina) -----
const corner = { lat: A.lat, lon: A.lon + 600 * M_LON };
const Lshape = [[A.lat, A.lon], [corner.lat, corner.lon], [corner.lat + 600 * M_LAT, corner.lon]]; // 600 m leste, 600 m norte
const Lpts = [P(10, A.lat + 4 * M_LAT, A.lon), P(9, A.lat - 3 * M_LAT, A.lon + 300 * M_LON), P(8, A.lat + 3 * M_LAT, corner.lon + 6 * M_LON), P(7, A.lat + 300 * M_LAT, corner.lon - 4 * M_LON), P(6, A.lat + 600 * M_LAT, corner.lon + 3 * M_LON)];

await t('splitShape segue a esquina e devolve um pedaço por par', () => {
  const r = RC.prepare(Lpts), sp = RC.splitShape(Lshape, r.segments[0].nodes);
  assert.equal(sp.pairs.length, 4);
  sp.pairs.forEach(p => assert.equal(p.q, 'matched'));
  const total = sp.pairs.reduce((s, p) => s + p.lenM, 0);
  assert.ok(Math.abs(total - 1200) < 40, 'comprimento ~1200 m, deu ' + total);
  // o par 2 (leste -> esquina -> norte) tem um vértice na esquina
  assert.ok(sp.pairs[1].g.some(([la, lo]) => Math.abs(la - corner.lat) < 3 * M_LAT && Math.abs(lo - corner.lon) < 3 * M_LON), 'passa pela esquina');
  assert.ok(sp.snaps.every(Boolean));
});

await t('splitShape descarta desvio absurdo e ponto longe da via (vira reta)', () => {
  const far = [P(10, A.lat, A.lon), P(9, A.lat + 2000 * M_LAT, A.lon + 300 * M_LON), P(8, corner.lat + 600 * M_LAT, corner.lon)];
  const r = RC.prepare(far), sp = RC.splitShape(Lshape, r.segments[0].nodes);
  assert.equal(sp.pairs[0].q, 'direct'); assert.equal(sp.snaps[1], null);
  // desvio: dois pontos próximos em linha reta mas a via faz uma volta de 1,2 km
  const U = [[A.lat, A.lon], [A.lat, A.lon + 600 * M_LON], [A.lat + 40 * M_LAT, A.lon + 600 * M_LON], [A.lat + 40 * M_LAT, A.lon]];
  const rr = RC.prepare([P(5, A.lat, A.lon), P(4, A.lat + 40 * M_LAT, A.lon)]);
  const sp2 = RC.splitShape(U, rr.segments[0].nodes);
  assert.equal(sp2.pairs[0].q, 'direct'); assert.equal(sp2.pairs[0].why, 'desvio');
});

// ----- ajuste às vias com serviços simulados -----
const mkRes = (status, body, headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
const valhallaOk = (shape) => mkRes(200, { trip: { legs: [{ shape: RC.encodePolyline(shape, 6) }], summary: { length: 1.2 } } });
const osrmOk = (shape) => mkRes(200, { code: 'Ok', routes: [{ geometry: RC.encodePolyline(shape, 6), distance: 1200 }] });
function mkClock() { const c = { t: 1e12 }; c.now = () => c.t; c.sleep = async (ms) => { c.t += ms; }; return c; }
function mkStorage() { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => { m.set(k, v); }, _m: m }; }
const settle = (matcher) => new Promise(res => { const iv = setInterval(() => { if (!matcher.isRunning()) { clearInterval(iv); res(); } }, 1); });

await t('Valhalla ok: pares ajustados, cache persistido e reutilizado sem nova chamada', async () => {
  const clk = mkClock(), st = mkStorage(), log = [];
  const fetch = async (url, init) => { log.push(url); return url.includes('valhalla') ? valhallaOk(Lshape) : mkRes(500, {}); };
  const prep = RC.prepare(Lpts);
  const m1 = RC.createMatcher({ fetch, storage: st, now: clk.now, sleep: clk.sleep });
  m1.update(prep.segments); await settle(m1);
  assert.equal(log.length, 1); assert.equal(m1.status.state, 'done'); assert.equal(m1.status.done, 1);
  const v = RC.computeView(prep, { period: 'all' }, k => m1.lookup(k), NOW);
  assert.equal(v.stats.quality.matched, 4); assert.equal(v.stats.quality.direct, 0);
  assert.ok(v.stats.distM > 1150 && v.stats.distM < 1250);
  // novo "navegador": mesma localStorage, não pode chamar a rede
  const m2 = RC.createMatcher({ fetch: async () => { throw new Error('não deveria chamar'); }, storage: st, now: clk.now, sleep: clk.sleep });
  m2.update(prep.segments); await settle(m2);
  assert.equal(m2.calls.valhalla, 0); assert.equal(m2.status.done, 1);
  assert.equal(RC.computeView(prep, { period: 'all' }, k => m2.lookup(k), NOW).stats.quality.matched, 4);
});

await t('Valhalla falha (500) -> cai para OSRM (rota entre pontos) e marca "routed"', async () => {
  const clk = mkClock();
  const fetch = async (url) => url.includes('valhalla') ? mkRes(503, {}) : osrmOk(Lshape);
  const prep = RC.prepare(Lpts), m = RC.createMatcher({ fetch, now: clk.now, sleep: clk.sleep });
  m.update(prep.segments); await settle(m);
  const v = RC.computeView(prep, { period: 'all' }, k => m.lookup(k), NOW);
  assert.equal(v.stats.quality.routed, 4); assert.equal(m.calls.valhalla, 1); assert.equal(m.calls.osrm, 1);
});

await t('tudo falha: linha direta, sem exceção, sem martelar o serviço (falha em cache por 10 min) e disjuntor', async () => {
  const clk = mkClock(); let n = 0;
  const fetch = async () => { n++; throw new TypeError('Failed to fetch'); };
  const prep = RC.prepare(Lpts), m = RC.createMatcher({ fetch, now: clk.now, sleep: clk.sleep });
  m.update(prep.segments); await settle(m);
  const v = RC.computeView(prep, { period: 'all' }, k => m.lookup(k), NOW);
  assert.equal(v.stats.quality.direct, 4); assert.equal(v.pairs[0].geom, null);
  assert.equal(n, 2, 'uma tentativa em cada serviço');
  const before = n; m.update(prep.segments); await settle(m);
  assert.equal(n, before, 'não repete dentro da janela de falha');
  assert.equal(m.status.failed, 1);
  clk.t += 11 * 60000; m.update(prep.segments); await settle(m); // janela venceu, mas o disjuntor só abre após 3 falhas
  assert.ok(n > before);
});

await t('HTTP 429 com Retry-After abre pausa do serviço; resposta 400/443 (sem rota) não conta como falha', async () => {
  const clk = mkClock(); const urls = [];
  const fetch = async (url) => { urls.push(url); return url.includes('valhalla') ? mkRes(429, {}, { 'retry-after': '90' }) : osrmOk(Lshape); };
  const prep = RC.prepare(Lpts), m = RC.createMatcher({ fetch, now: clk.now, sleep: clk.sleep });
  m.update(prep.segments); await settle(m);
  assert.equal(m.status.services.valhalla, 'down');
  const f2 = async (url) => url.includes('valhalla') ? mkRes(400, { error_code: 443 }) : osrmOk(Lshape);
  const m2 = RC.createMatcher({ fetch: f2, now: clk.now, sleep: clk.sleep });
  m2.update(prep.segments); await settle(m2);
  assert.equal(m2.status.services.valhalla, 'ok'); assert.equal(m2._svc.valhalla.fails, 0);
});

await t('throttle: lotes sequenciais respeitam o intervalo mínimo', async () => {
  const clk = mkClock(), times = [];
  const fetch = async () => { times.push(clk.now()); return valhallaOk(Lshape); };
  const many = Array.from({ length: 170 }, (_, i) => P(300 - i, A.lat, A.lon + i * 60 * M_LON));
  const prep = RC.prepare(many), m = RC.createMatcher({ fetch, now: clk.now, sleep: clk.sleep, minIntervalMs: 1200 });
  m.update(prep.segments); await settle(m);
  assert.equal(times.length, 3);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 1200, 'intervalo ' + (times[i] - times[i - 1]));
});

await t('incremental: pontos novos só pedem o lote da ponta (os antigos vêm do cache)', async () => {
  const clk = mkClock(), st = mkStorage(); let n = 0;
  const fetch = async (url, init) => { n++; const b = JSON.parse(init.body); return valhallaOk(b.shape.map(s => [s.lat, s.lon])); };
  const mk = (cnt) => RC.prepare(Array.from({ length: cnt }, (_, i) => P(500 - i, A.lat, A.lon + i * 60 * M_LON)));
  const m = RC.createMatcher({ fetch, storage: st, now: clk.now, sleep: clk.sleep });
  m.update(mk(200).segments); await settle(m); assert.equal(n, 3);
  m.update(mk(203).segments); await settle(m); assert.equal(n, 4, 'só o último lote');
});

await t('teto por rodada (maxPerRun) adia o excedente sem falhar', async () => {
  const clk = mkClock();
  const fetch = async (url, init) => valhallaOk(JSON.parse(init.body).shape.map(s => [s.lat, s.lon]));
  const many = Array.from({ length: 400 }, (_, i) => P(900 - i, A.lat, A.lon + i * 60 * M_LON));
  const m = RC.createMatcher({ fetch, now: clk.now, sleep: clk.sleep, maxPerRun: 2 });
  m.update(RC.prepare(many).segments); await settle(m);
  assert.equal(m.calls.valhalla, 2); assert.ok(m.status.deferred >= 3);
});

await t('cache respeita o teto de entradas e sobrevive a quota cheia', async () => {
  const clk = mkClock(), st = mkStorage();
  let boom = true; const real = st.setItem; st.setItem = (k, v) => { if (boom && v.length > 3000) throw new Error('QuotaExceeded'); real(k, v); };
  const fetch = async (url, init) => valhallaOk(JSON.parse(init.body).shape.map(s => [s.lat, s.lon]));
  const m = RC.createMatcher({ fetch, storage: st, now: clk.now, sleep: clk.sleep, maxCacheEntries: 2 });
  const many = Array.from({ length: 400 }, (_, i) => P(900 - i, A.lat, A.lon + i * 60 * M_LON));
  m.update(RC.prepare(many).segments); await settle(m);
  assert.ok(JSON.parse(st._m.get('thingy_rm_cache_v1') || '{}') && Object.keys(JSON.parse(st._m.get('thingy_rm_cache_v1') || '{}')).length <= 2);
  assert.equal(m.status.failed, 0);
});

// ----- filtros e resumo -----
const trip = [ // 12:00 BRT = NOW. Viagem hoje: move 100 m/min ~ 6 km/h?? usa 500 m/min = 30 km/h
  P(50, A.lat, A.lon), P(49, ...[A.lat, A.lon + 500 * M_LON]), P(48, A.lat, A.lon + 1000 * M_LON), P(47, A.lat, A.lon + 1500 * M_LON),
  P(46, A.lat, A.lon + 1500 * M_LON + 2 * M_LON), P(40, A.lat, A.lon + 1503 * M_LON), P(38, A.lat, A.lon + 1500 * M_LON), // parada 8 min
  P(37, A.lat, A.lon + 3500 * M_LON), P(36, A.lat, A.lon + 5500 * M_LON), // 2 km/min = 120 km/h
  P(30, A.lat + 3000 * M_LAT, A.lon + 5500 * M_LON, { serviceType: 'SCELL', unc: 80 }),
  P(20 + 24 * 60, A.lat + 5000 * M_LAT, A.lon) // ontem
].map(p => ({ ...p }));
const prepT = RC.prepare(trip, { now: NOW });
const view = (f) => RC.computeView(prepT, f, null, NOW);

await t('filtro de período: ao vivo 15 min / hoje / ontem / personalizado', () => {
  assert.equal(view({ period: 'live' }).stats.nPoints, 0);
  const today = view({ period: 'today' });
  assert.equal(today.stats.nPoints, 10, 'pontos de hoje (jitter conta como ponto bruto)');
  assert.equal(view({ period: 'yesterday' }).stats.nPoints, 1);
  assert.equal(view({ period: 'all' }).stats.nPoints, today.stats.nPoints + 1 + 0);
  const w = view({ period: 'custom', from: '2026-10-03T14:10:00Z', to: '2026-10-03T14:14:00Z' });
  assert.equal(w.window.t0, Date.parse('2026-10-03T14:10:00Z'));
  assert.equal(w.stats.nPoints, 5);
});

await t('filtros de velocidade, só movimento e só paradas', () => {
  const all = view({ period: 'today' });
  const fast = view({ period: 'today', vmin: 80 });
  assert.ok(fast.pairs.length >= 1 && fast.pairs.every(p => p.kmh >= 80));
  assert.equal(fast.stops.length, 0, 'filtro de velocidade mínima esconde paradas');
  const slow = view({ period: 'today', vmax: 40 });
  assert.ok(slow.pairs.every(p => p.kmh == null || p.kmh <= 40));
  const mov = view({ period: 'today', mode: 'move' });
  assert.equal(mov.stops.length, 0); assert.ok(mov.pairs.every(p => !p.stopped));
  const stp = view({ period: 'today', mode: 'stop' });
  assert.equal(stp.pairs.length, 0); assert.equal(stp.stops.length, 1); assert.equal(stp.stops[0].durMs, 9 * 60000);
  assert.ok(stp.points.every(p => p.stopped));
  assert.ok(all.pairs.length > mov.pairs.length - 1);
  assert.deepEqual(RC.normalizeFilters({ vmin: 90, vmax: 30 }).vmin, 30, 'inverte min/max');
});

await t('filtro de fonte: célula some da linha/pontos, GNSS permanece; acurácia 80 m entra se a fonte estiver ligada', () => {
  const withCell = view({ period: 'today' }), noCell = view({ period: 'today', cell: false });
  assert.equal(withCell.stats.nPoints - noCell.stats.nPoints, 1);
  assert.equal(view({ period: 'today', gnss: false, wifi: false, cell: true }).stats.nPoints, 1);
});

await t('resumo respeita filtros: distância, tempo em movimento, parado, média e máxima', () => {
  const s = view({ period: 'today' }).stats;
  assert.ok(s.distM > 8000 && s.distM < 12000, 'dist ' + s.distM);
  assert.equal(s.stoppedMs, 9 * 60000);
  assert.ok(s.movingMs > 0 && s.avgKmh > 20 && s.avgKmh < 60, 'média ' + s.avgKmh);
  assert.ok(s.maxKmh >= 119 && s.maxKmh <= 121, 'máx ' + s.maxKmh);
  const only = view({ period: 'today', vmin: 100 }).stats;
  assert.ok(only.distM < s.distM && only.distM >= 3900); assert.ok(only.maxKmh >= 119);
  assert.equal(view({ period: 'today', mode: 'move' }).stats.stoppedMs, 0);
});

await t('cores: velocidade verde->amarelo->vermelho, hora cíclica, bateria vermelho->verde', () => {
  assert.equal(RC.speedColor(0), '#22c55e'); assert.equal(RC.speedColor(200), '#dc2626'); assert.equal(RC.speedColor(null), '#94a3b8');
  assert.notEqual(RC.speedColor(55), RC.speedColor(25));
  assert.equal(RC.hourColor(0), RC.hourColor(24));
  assert.equal(RC.batteryColor(100), '#22c55e'); assert.equal(RC.batteryColor(0), '#dc2626');
  assert.equal(RC.batteryPct({ batteryVoltage: 3700 }), 50);
});

console.log(`\n${pass} testes ok`);
