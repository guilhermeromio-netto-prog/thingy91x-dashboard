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
    lat: num(m.la), lon: num(m.lo), acc: num(m.ac), posSrc: ({ g: 'gnss', s: 'salva', i: 'injetada', c: 'celula' })[m.ps] || null,
    gnssAge: num(m.gf), gnssSats: num(m.gv), cell: str(m.cl, 32),
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
/** v37: "cl":"72410,C423,0C5F2C16" (PLMN,TAC hex,ECI hex) -> objeto lte do nRF Cloud ground fix. */
export function parseCell(cl, rsrp) {
  const m = /^(\d{3})(\d{2,3}),([0-9A-Fa-f]{1,8}),([0-9A-Fa-f]{1,8})$/.exec(String(cl || ''));
  if (!m) return null;
  const o = { mcc: +m[1], mnc: +m[2], tac: parseInt(m[3], 16), eci: parseInt(m[4], 16) };
  if (typeof rsrp === 'number' && rsrp < 0 && rsrp > -160) o.rsrp = rsrp;
  return o;
}
async function cellFix(store, lte) {
  const key = 'cell/' + [lte.mcc, lte.mnc, lte.tac, lte.eci].join('-');
  const hit = await store.get(key, { type: 'json' }).catch(() => null);
  if (hit && (hit.lat != null ? Date.now() - hit.at < 30 * 86400000 : !/HTTP 40[13]|sem token/.test(hit.err || '') && Date.now() - hit.at < 3600000)) return hit;
  const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
  const toks = [...new Set([process.env.NRF_LOCATION_TOKEN, process.env.NRF_TEAM_READ_TOKEN, process.env.NRF_TEAM_WRITE_TOKEN].map(clean).filter(Boolean))];
  let out = { lat: null, lon: null, acc: null, at: Date.now(), err: 'sem token' }, authErr = false;
  for (const [i, tok] of toks.entries()) {
    try {
      const r = await fetch('https://api.nrfcloud.com/v1/location/ground-fix', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ lte: [lte] }), signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && typeof j.lat === 'number') { out = { lat: j.lat, lon: j.lon, acc: Math.round(j.uncertainty ?? 0) || null, at: Date.now(), via: j.fulfilledWith || 'SCELL' }; authErr = false; break; }
      authErr = r.status === 401 || r.status === 403;
      out.err = 'nRF Cloud HTTP ' + r.status + (j.message ? ': ' + String(j.message).slice(0, 50) : '') + ` [tok${i} len ${tok.length}${/^[0-9a-f]+$/i.test(tok) ? ' hex' : tok.split('.').length === 3 ? ' jwt' : ' outro'}]`;
    } catch (e) { out.err = 'nRF Cloud: ' + String(e && e.message || e).slice(0, 60); }
  }
  // fallback gratuito sem chave: BeaconDB (API compativel com Mozilla Location Service)
  if (out.lat == null) {
    try {
      const r = await fetch('https://api.beacondb.net/v1/geolocate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'ntn-lab/1.0 (thingy91x-dashboard)' }, body: JSON.stringify({ considerIp: false, cellTowers: [{ radioType: 'lte', mobileCountryCode: lte.mcc, mobileNetworkCode: lte.mnc, locationAreaCode: lte.tac, cellId: lte.eci, ...(lte.rsrp ? { signalStrength: lte.rsrp } : {}) }] }), signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.location) { out = { lat: j.location.lat, lon: j.location.lng, acc: Math.round(j.accuracy || 0) || null, at: Date.now(), via: 'beacondb', nrfErr: out.err }; authErr = false; }
      else out.err = (out.err ? out.err + ' | ' : '') + 'BeaconDB ' + r.status + (r.status === 404 ? ' celula desconhecida' : '');
    } catch (e) { out.err = (out.err || '') + ' | BeaconDB: ' + String(e && e.message || e).slice(0, 40); }
  }
  if (out.lat == null && (authErr || out.err === 'sem token') && !/BeaconDB 404/.test(out.err)) return out;
  await store.setJSON(key, out).catch(() => {});
  return out;
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
    // v37: sem fix GNSS recente -> posicao pela celula servidora (nRF Cloud ground fix, cache por celula)
    if (rec.cell && rec.posSrc !== 'gnss' && rec.net === 'catm') {
      const lte = parseCell(rec.cell, rec.rsrp);
      if (lte) {
        const f = await cellFix(store, lte);
        if (f.lat != null) Object.assign(rec, { lat: f.lat, lon: f.lon, acc: f.acc, posSrc: 'celula', posVia: f.via || null });
        else Object.assign(rec, { lat: null, lon: null, acc: null, posSrc: 'celula sem posicao', posErr: f.err });
      }
    }
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
