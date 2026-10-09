/**
 * nRF9151 NTN Lab (v35) — armazena/serve o resumo sanitizado dos testes Cat-M / NTN.
 * GET  /.netlify/functions/ntn-lab   -> { ok, data, storedAt }   (público; dados já sanitizados no Mac)
 * POST /.netlify/functions/ntn-lab   -> grava (Authorization: Bearer $NTN_LAB_WRITE_TOKEN)
 * POST /.netlify/functions/ntn-lab?ping=1 -> mensagem de teste da placa (Bearer $NTN_LAB_DEVICE_TOKEN, <=256 B)
 * v36 POST ?ingest=1 -> telemetria/eventos da placa (app v2.0, Bearer $NTN_LAB_DEVICE_TOKEN, <=256 B) em Blobs por dia
 * v36 GET  ?pro=1[&days=N]  -> historico publico sanitizado (posicao arredondada ~100 m) para o Painel Pro
 * Defesa em profundidade: rejeita payload > 256 KB e mascara qualquer sequência de 15+ dígitos (ICCID/IMSI/IMEI).
 */
import { getStore } from '@netlify/blobs';
import { timingSafeEqual, createHash } from 'node:crypto';

const MAX_BYTES = 256 * 1024;
const KEY = 'latest';
const PINGS = 'pings';
const MAX_PINGS = 60;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Cache-Control': 'no-store',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

function tokenOk(header, envName = 'NTN_LAB_WRITE_TOKEN') {
  const want = process.env[envName] || '';
  const got = String(header || '').replace(/^Bearer\s+/i, '');
  if (!want || want.length < 24 || !got) return false;
  const a = createHash('sha256').update(want).digest();
  const b = createHash('sha256').update(got).digest();
  return timingSafeEqual(a, b);
}
function scrub(text) {
  return text.replace(/\d{15,22}/g, (m) => m.slice(0, 5) + '*'.repeat(m.length - 9) + m.slice(-4));
}

const DAY_MAX = 5000;
const dayKey = (iso) => 'pro/' + iso.slice(0, 10);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, n = 16) => (typeof v === 'string' ? v.slice(0, n) : null);
const r3 = (v) => (num(v) != null && v !== 0 ? Math.round(v * 1000) / 1000 : null);
/** Normaliza uma mensagem compacta da placa (app v2.0). Exportado para testes. */
export function normalizeIngest(m, rawLen, rxIso) {
  if (!m || typeof m !== 'object') return null;
  const type = m.t === 'e' ? 'event' : m.t === 'm' ? 'telemetry' : null;
  if (!type) return null;
  const late = Math.max(0, num(m.l) || 0);
  const k = Array.isArray(m.k) ? m.k.map((x) => num(x) ?? 0) : null;
  const rec = {
    type, rx: rxIso, ts: new Date(Date.parse(rxIso) - late * 1000).toISOString(), late, bytes: rawLen,
    seq: num(m.s), up: num(m.u), net: m.n === 'n' ? 'ntn' : m.n === 'c' ? 'catm' : null,
    lat: num(m.la), lon: num(m.lo), acc: num(m.ac), posSrc: ({ g: 'gnss', s: 'salva', i: 'injetada' })[m.ps] || null,
    prevRttMs: num(m.pr) != null && m.pr >= 0 ? m.pr : null,
  };
  if (rec.lat === 0 && rec.lon === 0) { rec.lat = null; rec.lon = null; }
  if (type === 'telemetry') Object.assign(rec, {
    plmn: str(m.p, 8), act: num(m.a), band: str(m.b, 6) || null, rsrp: num(m.r) === 999 ? null : num(m.r), snr: num(m.q) === 999 ? null : num(m.q),
    ce: num(m.c) != null && m.c >= 0 ? m.c : null, mv: num(m.v) != null && m.v >= 0 ? m.v : null, temp: num(m.T) === -99 ? null : num(m.T), regFor: num(m.rg),
    counters: k ? { tries: k[0], ok: k[1], fail: k[2], switches: k[3] } : null,
  });
  else Object.assign(rec, { event: str(m.e, 12), value: num(m.x), info: str(m.i, 40) });
  return rec;
}
/** Versao publica: posicao arredondada (~100 m). */
export function publicView(rec) { return { ...rec, lat: r3(rec.lat), lon: r3(rec.lon) }; }

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const store = getStore({ name: 'ntn-lab', consistency: 'strong' });
  const url = new URL(req.url);
  if (req.method === 'GET' && url.searchParams.get('pro')) {
    const days = Math.min(14, Math.max(1, parseInt(url.searchParams.get('days') || '2', 10) || 2));
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const list = await store.get(dayKey(new Date(Date.now() - i * 86400000).toISOString()), { type: 'json' }).catch(() => null);
      if (Array.isArray(list)) out.push(...list.map(publicView));
    }
    return json(200, { ok: true, schema: 'ntn-pro/1', serverTime: new Date().toISOString(), records: out });
  }
  if (req.method === 'POST' && url.searchParams.get('ingest')) {
    // v36: telemetria/eventos da placa (app v2.0). Resposta minima (poucos bytes no satelite).
    if (!process.env.NTN_LAB_DEVICE_TOKEN) return json(503, { ok: false, error: 'device token not configured' });
    if (!tokenOk(req.headers.get('authorization'), 'NTN_LAB_DEVICE_TOKEN')) return json(401, { ok: false, error: 'unauthorized' });
    const raw = await req.text();
    if (raw.length > 256) return json(413, { ok: false, error: 'payload > 256 B' });
    let m; try { m = JSON.parse(scrub(raw)); } catch { return json(400, { ok: false, error: 'invalid json' }); }
    const rx = new Date().toISOString();
    const rec = normalizeIngest(m, raw.length, rx);
    if (!rec) return json(400, { ok: false, error: 'bad message' });
    const key = dayKey(rec.ts);
    const list = (await store.get(key, { type: 'json' }).catch(() => null)) || [];
    const dup = rec.seq != null && list.some((x) => x.seq === rec.seq && x.type === rec.type);
    if (!dup) { list.push(rec); await store.setJSON(key, list.slice(-DAY_MAX)); }
    return new Response('{"ok":1}', { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  if (req.method === 'GET') {
    const rec = await store.get(KEY, { type: 'json' }).catch(() => null);
    const pings = await store.get(PINGS, { type: 'json' }).catch(() => null);
    return json(200, { ok: true, data: rec ? rec.data : null, storedAt: rec ? rec.storedAt : null, pings: pings || [] });
  }
  if (req.method === 'POST' && url.searchParams.get('ping')) {
    // v35: mensagem de teste enviada direto pela placa (Botao 3), <=256 B, token proprio do dispositivo
    if (!process.env.NTN_LAB_DEVICE_TOKEN) return json(503, { ok: false, error: 'device token not configured' });
    if (!tokenOk(req.headers.get('authorization'), 'NTN_LAB_DEVICE_TOKEN')) return json(401, { ok: false, error: 'unauthorized' });
    const raw = await req.text();
    if (raw.length > 256) return json(413, { ok: false, error: 'payload > 256 B' });
    let m; try { m = JSON.parse(scrub(raw)); } catch { return json(400, { ok: false, error: 'invalid json' }); }
    const pick = (k, t) => (typeof m[k] === t ? m[k] : null);
    const rx = new Date().toISOString();
    const rec = { rx, bytes: raw.length, seq: pick('s', 'number'), up: pick('up', 'number'), net: pick('n', 'string'), plmn: pick('p', 'string'), act: pick('a', 'number'),
      rsrp: pick('r', 'number'), mv: pick('v', 'number'), prevRttMs: pick('pr', 'number'),
      lat: typeof m.la === 'number' && m.la ? Math.round(m.la * 1000) / 1000 : null, lon: typeof m.lo === 'number' && m.lo ? Math.round(m.lo * 1000) / 1000 : null };
    const list = (await store.get(PINGS, { type: 'json' }).catch(() => null)) || [];
    list.push(rec); await store.setJSON(PINGS, list.slice(-MAX_PINGS));
    return json(200, { ok: true, rx, seq: rec.seq });
  }
  if (req.method === 'POST') {
    if (!process.env.NTN_LAB_WRITE_TOKEN) return json(503, { ok: false, error: 'write token not configured' });
    if (!tokenOk(req.headers.get('authorization'))) return json(401, { ok: false, error: 'unauthorized' });
    const raw = await req.text();
    if (raw.length > MAX_BYTES) return json(413, { ok: false, error: 'payload too large' });
    let data;
    try { data = JSON.parse(scrub(raw)); } catch { return json(400, { ok: false, error: 'invalid json' }); }
    if (!data || data.schema !== 'ntn-lab/1') return json(400, { ok: false, error: 'bad schema' });
    const storedAt = new Date().toISOString();
    await store.setJSON(KEY, { data, storedAt });
    return json(200, { ok: true, storedAt });
  }
  return json(405, { ok: false, error: 'method not allowed' });
};
