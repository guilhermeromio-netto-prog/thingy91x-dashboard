/**
 * Alerts on-demand (v27) — avalia regras simples a partir da nuvem.
 * GET /.netlify/functions/alerts?deviceId=UUID
 * Auth: mesmos headers do nrfcloud (Authorization / X-User-* / X-Nrf-Team-Key)
 *      + env NRF_TEAM_WRITE_TOKEN (ou NRF_TEAM_READ_TOKEN) para schedule sem headers.
 * Geofence NÃO é avaliada no worker (só no cliente) — sem store server-side.
 * Nunca retorna segredos.
 */
const MEMFAULT_HOST = 'https://api.memfault.com';
const NRF_HOST = 'https://api.nrfcloud.com';
const DEFAULT_ORG = process.env.MEMFAULT_ORG || 'telekom';
const DEFAULT_PROJECT = process.env.MEMFAULT_PROJECT || 'nrf-project';

const RULES = {
  OFFLINE_STALE_MS: Number(process.env.ALERT_OFFLINE_MS || 20 * 60 * 1000),
  BATTERY_LOW: Number(process.env.ALERT_BATTERY_LOW || 20),
  BATTERY_CRIT: Number(process.env.ALERT_BATTERY_CRIT || 10),
  RSRP_WEAK: Number(process.env.ALERT_RSRP_WEAK || -110),
  DATA_STALE_MS: Number(process.env.ALERT_DATA_STALE_MS || 30 * 60 * 1000),
};

const CORS_ALLOW_HEADERS =
  'Authorization, Content-Type, X-User-Email, X-User-Api-Key, X-Memfault-Org, X-Memfault-Project, X-Org-Slug, X-Project-Slug, X-Nrf-Team-Key, X-Device-Id, Cache-Control';

function corsOrigin(event) {
  const origin = (event.headers?.origin || event.headers?.Origin || '').toString();
  if (
    !origin ||
    /github\.io$/i.test(origin) ||
    /netlify\.app$/i.test(origin) ||
    /localhost(:\d+)?$/i.test(origin) ||
    /127\.0\.0\.1(:\d+)?$/i.test(origin)
  ) {
    return origin || '*';
  }
  return '*';
}

function corsHeaders(event, extra = {}) {
  return {
    'Access-Control-Allow-Origin': corsOrigin(event),
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    ...extra,
  };
}

function json(statusCode, body, event = null) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(event) },
    body: JSON.stringify(body),
  };
}

function stripBearer(s) {
  return (s || '').trim().replace(/^(Bearer)\s+/i, '');
}

function resolveAuth(rawH) {
  const auth = rawH.authorization || rawH.Authorization || '';
  const emailHdr = (rawH['x-user-email'] || rawH['X-User-Email'] || '').trim();
  const rawKey = (rawH['x-user-api-key'] || rawH['X-User-Api-Key'] || '').trim();
  if (/^Basic\s+/i.test(auth) || /^Bearer\s+/i.test(auth)) return auth;
  if (emailHdr && (rawKey || auth)) {
    const key = rawKey || stripBearer(auth);
    return `Basic ${Buffer.from(`${emailHdr}:${key}`, 'utf8').toString('base64')}`;
  }
  if (rawKey) return `Bearer ${rawKey}`;
  // Schedule / env-only: MEMFAULT_OAT or MEMFAULT_USER_API_KEY (+ optional MEMFAULT_EMAIL)
  const oat = stripBearer(process.env.MEMFAULT_OAT || process.env.MEMFAULT_USER_API_KEY || '');
  const email = (process.env.MEMFAULT_EMAIL || '').trim();
  if (oat && email) return `Basic ${Buffer.from(`${email}:${oat}`, 'utf8').toString('base64')}`;
  if (oat) return `Bearer ${oat}`;
  return auth || null;
}

function resolveNrfAuth(rawH, memfaultAuth) {
  const team = stripBearer(rawH['x-nrf-team-key'] || rawH['X-Nrf-Team-Key'] || '');
  const envTok = stripBearer(
    process.env.NRF_TEAM_WRITE_TOKEN || process.env.NRF_TEAM_READ_TOKEN || ''
  );
  if (team) return `Bearer ${team}`;
  if (envTok) return `Bearer ${envTok}`;
  return memfaultAuth;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function voltToPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  let volts = Number(v);
  if (volts > 1000) volts = volts / 1000;
  return Math.max(0, Math.min(100, Math.round(((volts - 3.2) / 1.0) * 100)));
}

async function upstreamGet(url, auth, label) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: auth },
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  console.log(`[alerts] ${label} ${url} → ${res.status}`);
  return { res, data };
}

function pickBatteryPct(device, msgs) {
  const state = device?.state || device?.nrfRaw?.state || device?.shadow?.state || {};
  const reported = state.reported || state || {};
  const bat = reported.device?.batteryStatus || reported.battery || {};
  let pct = numOrNull(bat.percent ?? bat.percentage ?? bat.SoC ?? bat.soc ?? bat.level ?? bat.battery);
  if (pct == null) pct = voltToPct(bat.voltage ?? bat.batteryVoltage ?? bat.v);
  if (pct != null) return pct;
  // scan recent messages
  const list = Array.isArray(msgs) ? msgs : msgs?.items || msgs?.messages || [];
  for (const m of list.slice(0, 40)) {
    const app = (m.appId || m.app || '').toUpperCase();
    const d = m.data ?? m.message?.data ?? m;
    if (app === 'BATTERY' || app === 'BAT' || app === 'DEVICE') {
      const p = numOrNull(d?.percent ?? d?.percentage ?? d?.battery ?? d?.SoC);
      if (p != null) return p;
      const vv = numOrNull(d?.voltage ?? d?.batteryVoltage ?? d?.v);
      if (vv != null) return voltToPct(vv);
    }
  }
  return null;
}

function pickRsrp(device, msgs) {
  const state = device?.state || device?.nrfRaw?.state || {};
  const reported = state.reported || state || {};
  const ni = reported.networkInfo || reported.roam || {};
  let r = numOrNull(ni.rsrp ?? reported.rsrp);
  if (r != null) return r;
  const list = Array.isArray(msgs) ? msgs : msgs?.items || msgs?.messages || [];
  for (const m of list.slice(0, 40)) {
    const app = (m.appId || m.app || '').toUpperCase();
    const d = m.data ?? m.message?.data ?? m;
    if (app === 'RSRP' || app === 'SCELL' || app === 'DEVICE' || app === 'NETWORK') {
      const v = numOrNull(typeof d === 'number' ? d : d?.rsrp ?? d?.value);
      if (v != null) return v;
    }
  }
  return null;
}

function pickLastSeen(device, msgs) {
  const candidates = [
    device?.last_seen,
    device?.lastSeen,
    device?.nrfRaw?.$meta?.updatedAt,
    device?.state?.reported?.$meta?.updatedAt,
  ];
  for (const c of candidates) {
    if (c) {
      const t = new Date(c).getTime();
      if (Number.isFinite(t)) return t;
    }
  }
  const list = Array.isArray(msgs) ? msgs : msgs?.items || msgs?.messages || [];
  let best = null;
  for (const m of list.slice(0, 20)) {
    const at = m.receivedAt || m.ts || m.timestamp || m.insertedAt;
    if (!at) continue;
    const t = new Date(at).getTime();
    if (Number.isFinite(t) && (best == null || t > best)) best = t;
  }
  return best;
}

function connectedFlag(device) {
  if (typeof device?.connected === 'boolean') return device.connected;
  if (typeof device?.nrfRaw?.connected === 'boolean') return device.nrfRaw.connected;
  return null;
}

function evaluateAlerts({ deviceId, device, msgs }) {
  const alerts = [];
  const push = (level, id, text) => alerts.push({ level, id, text, source: 'server' });
  const lastSeenMs = pickLastSeen(device, msgs);
  const age = lastSeenMs != null ? Date.now() - lastSeenMs : null;
  const connected = connectedFlag(device);
  const offline =
    connected === false ||
    (age != null && age > RULES.OFFLINE_STALE_MS);
  if (offline) {
    const mins = age != null ? Math.round(age / 60000) : '?';
    push('crítico', 'offline', `Offline / sem dados há ~${mins} min`);
  } else if (age != null && age > RULES.DATA_STALE_MS) {
    push('atenção', 'stale', `Dados antigos (~${Math.round(age / 60000)} min)`);
  }

  const pct = pickBatteryPct(device, msgs);
  if (pct != null && pct < RULES.BATTERY_CRIT) {
    push('crítico', 'bat-crit', `Bateria crítica (${pct}%)`);
  } else if (pct != null && pct < RULES.BATTERY_LOW) {
    push('atenção', 'bat-low', `Bateria baixa (${pct}%)`);
  }

  const rsrp = pickRsrp(device, msgs);
  if (rsrp != null && rsrp < RULES.RSRP_WEAK) {
    push('atenção', 'rsrp-weak', `Sinal fraco (RSRP ${rsrp} dBm)`);
  }

  const rank = { crítico: 0, atenção: 1, ok: 2 };
  alerts.sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9));
  return {
    deviceId,
    evaluatedAt: new Date().toISOString(),
    rules: {
      offlineStaleMin: Math.round(RULES.OFFLINE_STALE_MS / 60000),
      batteryLow: RULES.BATTERY_LOW,
      batteryCrit: RULES.BATTERY_CRIT,
      rsrpWeak: RULES.RSRP_WEAK,
      dataStaleMin: Math.round(RULES.DATA_STALE_MS / 60000),
      geofence: false,
      note: 'Geofence só no cliente (sem store server-side nesta geração).',
    },
    snapshot: {
      connected,
      lastSeenMs,
      batteryPct: pct,
      rsrp,
    },
    writeTokenConfigured: !!(process.env.NRF_TEAM_WRITE_TOKEN || '').trim(),
    alerts: alerts.slice(0, 8),
  };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(event), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' }, event);
  }

  const qs = event.queryStringParameters || {};
  const rawH = event.headers || {};
  const deviceId = (
    qs.deviceId ||
    qs.device ||
    rawH['x-device-id'] ||
    rawH['X-Device-Id'] ||
    process.env.ALERT_DEFAULT_DEVICE_ID ||
    ''
  ).toString().trim();

  if (!deviceId) {
    return json(400, {
      error: 'Missing deviceId',
      detail: 'Use ?deviceId=UUID ou X-Device-Id. Schedule: ALERT_DEFAULT_DEVICE_ID no Netlify.',
    }, event);
  }

  const org = (rawH['x-memfault-org'] || rawH['X-Memfault-Org'] || rawH['x-org-slug'] || DEFAULT_ORG).toString().trim() || DEFAULT_ORG;
  const project = (rawH['x-memfault-project'] || rawH['X-Memfault-Project'] || rawH['x-project-slug'] || DEFAULT_PROJECT).toString().trim() || DEFAULT_PROJECT;

  const auth = resolveAuth(rawH);
  if (!auth) {
    return json(401, {
      error: 'Missing Authorization',
      detail: 'Headers do cliente ou env MEMFAULT_OAT / MEMFAULT_USER_API_KEY (+ MEMFAULT_EMAIL opcional).',
    }, event);
  }
  const nrfAuth = resolveNrfAuth(rawH, auth);

  try {
    const base = `/api/v0/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}`;
    let device = null;
    const mem = await upstreamGet(
      `${MEMFAULT_HOST}${base}/devices/${encodeURIComponent(deviceId)}`,
      auth,
      'MEMFAULT device'
    );
    if (mem.res.ok) device = mem.data?.data || mem.data;

    // nRF FetchDevice for connected/state
    try {
      const nrf = await upstreamGet(
        `${NRF_HOST}/v1/devices/${encodeURIComponent(deviceId)}?includeState=true`,
        nrfAuth,
        'NRF device'
      );
      if (nrf.res.ok && nrf.data) {
        device = { ...(device || {}), nrfRaw: nrf.data, connected: nrf.data.connected ?? device?.connected };
      }
    } catch { /* soft */ }

    let msgs = [];
    try {
      const mq = new URLSearchParams({ deviceId, pageLimit: '50' });
      const mr = await upstreamGet(`${NRF_HOST}/v1/messages?${mq}`, nrfAuth, 'NRF messages');
      if (mr.res.ok) {
        const d = mr.data;
        msgs = Array.isArray(d) ? d : d?.items || d?.messages || d?.data || [];
      }
    } catch { /* soft */ }

    const out = evaluateAlerts({ deviceId, device, msgs });
    // Netlify schedule warm: ?warm=1 just evaluates + logs
    if (qs.warm === '1' || event.headers?.['x-nf-scheduled']) {
      console.log(`[alerts] warm device=${deviceId} n=${out.alerts.length}`);
    }
    return json(200, out, event);
  } catch (err) {
    return json(502, { error: 'Bad gateway', detail: err.message }, event);
  }
}
