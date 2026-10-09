/**
 * nRF9151 NTN Lab (v34) — armazena/serve o resumo sanitizado dos testes Cat-M / NTN.
 * GET  /.netlify/functions/ntn-lab   -> { ok, data, storedAt }   (público; dados já sanitizados no Mac)
 * POST /.netlify/functions/ntn-lab   -> grava (Authorization: Bearer $NTN_LAB_WRITE_TOKEN)
 * Defesa em profundidade: rejeita payload > 256 KB e mascara qualquer sequência de 15+ dígitos (ICCID/IMSI/IMEI).
 */
import { getStore } from '@netlify/blobs';
import { timingSafeEqual, createHash } from 'node:crypto';

const MAX_BYTES = 256 * 1024;
const KEY = 'latest';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Cache-Control': 'no-store',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

function tokenOk(header) {
  const want = process.env.NTN_LAB_WRITE_TOKEN || '';
  const got = String(header || '').replace(/^Bearer\s+/i, '');
  if (!want || want.length < 24 || !got) return false;
  const a = createHash('sha256').update(want).digest();
  const b = createHash('sha256').update(got).digest();
  return timingSafeEqual(a, b);
}
function scrub(text) {
  return text.replace(/\d{15,22}/g, (m) => m.slice(0, 5) + '*'.repeat(m.length - 9) + m.slice(-4));
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const store = getStore({ name: 'ntn-lab', consistency: 'strong' });
  if (req.method === 'GET') {
    const rec = await store.get(KEY, { type: 'json' }).catch(() => null);
    return json(200, { ok: true, data: rec ? rec.data : null, storedAt: rec ? rec.storedAt : null });
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
