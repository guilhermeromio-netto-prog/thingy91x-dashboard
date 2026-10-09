// node tests/ntn-pro.test.mjs — lógica do Painel NTN Pro (pro-core.js) + ingestão ntn-lab (v36)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const ctx = { self: {} }; vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../ntn/pro-core.js', import.meta.url), 'utf8'), ctx);
const P = ctx.self.NtnPro;
const { normalizeIngest, publicView } = await import('../netlify/functions/ntn-lab.js');
let pass = 0; const t = async (n, f) => { await f(); pass++; console.log('ok  -', n); };
const T0 = Date.parse('2026-10-09T18:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const tel = (s, sec, net, o = {}) => ({ type: 'telemetry', seq: s, ts: at(sec), rx: at(sec), net, lat: -23.545, lon: -46.781, bytes: 190, late: 0, rsrp: net === 'ntn' ? -133 : -90, ...o });
const ev = (s, sec, net, event, value, o = {}) => ({ type: 'event', seq: s, ts: at(sec), rx: at(sec), net, event, value, lat: -23.545, lon: -46.781, late: 0, ...o });
const sim = [
  ev(1, 0, 'catm', 'boot', 20), ev(2, 3, 'catm', 'reg', 3),
  tel(3, 60, 'catm', { prevRttMs: null }), tel(4, 120, 'catm', { prevRttMs: 700 }), /* seq 5 perdida */ tel(6, 240, 'catm', { prevRttMs: 900 }),
  ev(7, 300, 'catm', 'sw', 1, { info: 'botao1' }), ev(8, 400, 'catm', 'fix', 100), ev(9, 1150, 'ntn', 'reg', 748),
  tel(10, 1160, 'ntn', { prevRttMs: 800 }), tel(11, 1460, 'ntn', { prevRttMs: 23000, late: 120 }), ev(12, 1500, 'ntn', 'sw', 0), ev(13, 1503, 'catm', 'reg', 3),
  tel(14, 1560, 'catm', { prevRttMs: 25000 }),
];
await t('core: filtro por rede e só comutações', () => {
  assert.equal(P.filterRecords(sim, { net: 'ntn' }, T0 + 2e6).length, 4);
  const sw = P.filterRecords(sim, { switchesOnly: true }, T0 + 2e6);
  assert.ok(sw.every((r) => r.type === 'event' && r.event !== 'boot'));
  assert.equal(P.filterRecords(sim, { period: '1h' }, T0 + 2 * 3600e3).length, 0);
});
await t('core: comutações com tempo até registrar', () => {
  const s = P.switches(sim);
  assert.equal(s.length, 2);
  assert.equal(s[0].to, 'ntn'); assert.equal(s[0].regSec, 748); assert.equal(s[0].fixSec, 100); assert.equal(s[0].ok, true);
  assert.equal(s[1].to, 'catm'); assert.equal(s[1].regSec, 3);
});
await t('core: KPIs (entrega, latência por rede, registro NTN, atrasadas)', () => {
  const k = P.kpis(sim, T0 + 1600e3);
  assert.equal(k.net.catm.received + k.net.ntn.received, 13);
  assert.ok(Math.abs(k.delivery - 13 / 14) < 1e-9, String(k.delivery));
  assert.equal(k.ntnRegAvg, 748); assert.equal(k.late, 1);
  assert.equal(k.net.ntn.rttAvg, (800 + 23000) / 2, 'RTT da msg anterior é atribuído à rede da anterior');
  assert.ok(k.availability > 0 && k.availability < 1);
});
await t('core: status ao vivo e segmentos por rede', () => {
  const s = P.liveStatus(sim, T0 + 1600e3);
  assert.equal(s.net, 'catm'); assert.equal(s.ageSec, 40); assert.equal(s.sinceSec, 100);
  const seg = P.segments(P.mapPoints(sim));
  assert.equal(seg.map((x) => x.net).join(), 'catm,ntn,catm');
});
await t('core: CSV com cabeçalho e escape', () => {
  const csv = P.toCSV([ev(1, 0, 'catm', 'sw', 1, { info: 'a,b' })]);
  assert.match(csv.split('\n')[0], /^ts,rx,type,net,seq/); assert.match(csv, /"a,b"/);
});
await t('core: replay.json real é válido e mostra registro NTN de 748 s', () => {
  const r = JSON.parse(readFileSync(new URL('../ntn/replay.json', import.meta.url), 'utf8'));
  assert.equal(r.replay, true); assert.ok(r.records.every((x) => x.replay));
  const k = P.kpis(r.records);
  assert.equal(k.ntnRegAvg, 748); assert.ok(k.net.ntn.rttAvg > 20000 && k.net.catm.rttAvg < 1000);
});
await t('ingest: telemetria compacta v2.0 <= 256 B normalizada', () => {
  const raw = '{"t":"m","s":42,"u":3600,"n":"n","p":"90198","a":14,"b":"","r":-133,"q":999,"c":2,"v":5200,"T":41,"rg":120,"la":-23.54524,"lo":-46.78111,"ac":11,"ps":"i","k":[10,9,1,2],"pr":23000,"l":90}';
  assert.ok(raw.length <= 256, 'payload de referência cabe em 256 B: ' + raw.length);
  const rec = normalizeIngest(JSON.parse(raw), raw.length, '2026-10-09T18:00:00.000Z');
  assert.equal(rec.net, 'ntn'); assert.equal(rec.snr, null); assert.equal(rec.ce, 2); assert.equal(rec.posSrc, 'injetada');
  assert.equal(rec.ts, '2026-10-09T17:58:30.000Z', 'atrasada: ts = rx - l'); assert.deepEqual(rec.counters, { tries: 10, ok: 9, fail: 1, switches: 2 });
  const pub = publicView(rec); assert.equal(pub.lat, -23.545); assert.equal(pub.lon, -46.781);
});
await t('ingest: evento e mensagem inválida', () => {
  const e = normalizeIngest({ t: 'e', s: 5, u: 10, n: 'c', e: 'reg', x: 3, i: 'Cat-M' }, 60, '2026-10-09T18:00:00.000Z');
  assert.equal(e.type, 'event'); assert.equal(e.event, 'reg'); assert.equal(e.value, 3); assert.equal(e.late, 0);
  assert.equal(normalizeIngest({ t: 'x' }, 5, '2026-10-09T18:00:00.000Z'), null);
});
console.log(`\n${pass} testes OK`);
