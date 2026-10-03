// node tests/route.live.mjs — teste MANUAL contra os serviços públicos reais (precisa de internet). Não faz parte do npm test.
import '../route-core.js';
const RC = globalThis.RouteCore;
const hav = RC.hav;
// rota real Av. Paulista -> Ibirapuera (OSRM), amostrada a cada ~250 m com ruído de 8 m
const r = await (await fetch('https://router.project-osrm.org/route/v1/driving/-46.6559,-23.5614;-46.6333,-23.5505?overview=full&geometries=geojson')).json();
const line = r.routes[0].geometry.coordinates.map(([x, y]) => [y, x]);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
const pts = []; let next = 0, cum = 0; const t0 = Date.now() - 3600e3;
for (let i = 1; i < line.length; i++) {
  const d = hav(...line[i - 1], ...line[i]);
  while (next <= cum + d) { const f = d ? (next - cum) / d : 0;
    pts.push({ lat: line[i-1][0] + (line[i][0]-line[i-1][0])*f + gauss()*8/110574, lon: line[i-1][1] + (line[i][1]-line[i-1][1])*f + gauss()*8/102000, at: new Date(t0 + pts.length * 30000).toISOString(), unc: 10, serviceType: 'GNSS' }); next += 250; }
  cum += d;
}
console.log('pontos', pts.length, 'distância verdadeira', Math.round(r.routes[0].distance), 'm');
const prep = RC.prepare(pts);
let done; const fin = new Promise(r => { done = r; });
const m = RC.createMatcher({ fetch: globalThis.fetch, onUpdate: st => { if (st.state === 'done') done(); } });
const t = Date.now(); m.update(prep.segments); await fin;
const view = RC.computeView(prep, { period: 'all' }, k => m.lookup(k), Date.now());
console.log('estado', JSON.stringify(m.status), 'chamadas', JSON.stringify(m.calls), 'ms', Date.now() - t);
console.log('qualidade', JSON.stringify(view.stats.quality), 'dist ajustada', Math.round(view.stats.distM), 'm (reta:', Math.round(prep.pairs.reduce((s, p) => s + p.straightM, 0)), 'm)');
let maxDev = 0; view.pairs.forEach(p => (p.geom || []).forEach(g => { maxDev = Math.max(maxDev, Math.min(...line.map(l => hav(g[0], g[1], l[0], l[1])))); }));
console.log('desvio máximo da geometria ajustada à rota verdadeira:', Math.round(maxDev), 'm');
