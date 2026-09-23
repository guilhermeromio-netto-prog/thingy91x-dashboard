const MEMFAULT_HOST = 'https://api.memfault.com';
const NRF_HOST = 'https://api.nrfcloud.com';
const DEFAULT_ORG = process.env.MEMFAULT_ORG || 'telekom';
const DEFAULT_PROJECT = process.env.MEMFAULT_PROJECT || 'nrf-project';
const ONLINE_MS = Number(process.env.MEMFAULT_ONLINE_MS || 15 * 60 * 1000);

const UNSUPPORTED_WRITES = [
  { re: /^\/(?:firmware|firmwares|fota)(?:\/|$|\?)/i, feature: 'legacy FOTA' },
];

function normalizeDesiredBody(raw) {
  let payload = raw;
  if (typeof raw === 'string') {
    try { payload = JSON.parse(raw); } catch { return raw; }
  }
  if (!payload || typeof payload !== 'object') return raw;
  const hasDesiredWrapper = Object.prototype.hasOwnProperty.call(payload, 'desired');
  const desiredIn = hasDesiredWrapper
    ? (payload.desired && typeof payload.desired === 'object' ? { ...payload.desired } : {})
    : { ...payload };
  const config = { ...(desiredIn.config && typeof desiredIn.config === 'object' ? desiredIn.config : {}) };
  const desired = { ...desiredIn };
  if (desired.gpsInterval != null && config.sample_interval == null) {
    const n = Number(desired.gpsInterval);
    if (Number.isFinite(n) && n > 0) config.sample_interval = Math.round(n);
    delete desired.gpsInterval;
  }
  if (desired.sample_interval != null && config.sample_interval == null) {
    config.sample_interval = desired.sample_interval; delete desired.sample_interval;
  }
  if (desired.update_interval != null && config.update_interval == null) {
    config.update_interval = desired.update_interval; delete desired.update_interval;
  }
  if (desired.storage_threshold != null && config.storage_threshold == null) {
    config.storage_threshold = desired.storage_threshold; delete desired.storage_threshold;
  }
  if (desired.led != null && config.led == null) config.led = desired.led;
  if (desired.buzzer != null && config.buzzer == null) config.buzzer = desired.buzzer;
  if (Object.keys(config).length) desired.config = config;
  return hasDesiredWrapper ? { ...payload, desired } : { desired };
}

function normalizeC2dBody(raw, deviceId) {
  let payload = raw;
  if (typeof raw === 'string') {
    try { payload = JSON.parse(raw); } catch { return raw; }
  }
  if (!payload || typeof payload !== 'object') {
    return { message: { appId: 'PING', data: payload, messageType: 'DATA' }, topic: `m/d/${deviceId}/c2d` };
  }
  if (payload.message != null || payload.topic != null) return payload;
  return {
    message: payload.appId ? payload : { appId: 'PING', data: payload, messageType: 'DATA' },
    topic: `m/d/${deviceId}/c2d`,
  };
}

function resolveNrfAuth(rawH, memfaultAuth) {
  const team = (rawH['x-nrf-team-key'] || rawH['X-Nrf-Team-Key'] || '').trim().replace(/^(Bearer)\s+/i, '');
  if (team) return `Bearer ${team}`;
  return memfaultAuth;
}

function projectBase(org, project) {
  return `/api/v0/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}`;
}

function authVariants(auth) {
  const variants = [];
  if (!auth) return variants;
  variants.push(auth);
  const m = auth.match(/^Basic\s+(.+)$/i);
  if (m) {
    try {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx >= 0) {
        const key = decoded.slice(idx + 1);
        if (key) variants.push(`Bearer ${key}`);
      }
    } catch { /* ignore */ }
  }
  return [...new Set(variants)];
}

function looksLikeMemfaultDevice(obj) {
  return obj && typeof obj === 'object' && (obj.device_serial != null || (obj.last_seen != null && obj.hardware_version != null));
}

function unwrapDevicePayload(data) {
  if (!data || typeof data !== 'object') return data;
  if (looksLikeMemfaultDevice(data)) return data;
  if (looksLikeMemfaultDevice(data.data)) return data.data;
  return data;
}

function deepMerge(a, b) {
  if (!b || typeof b !== 'object') return a;
  if (!a || typeof a !== 'object') return b;
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function flattenAttributes(attrs) {
  const out = {};
  const list = Array.isArray(attrs) ? attrs : (attrs?.data || attrs?.items || []);
  for (const it of list) {
    const key = it.string_key || it.metric_config?.string_key || it.key;
    const val = it.state?.value ?? it.value;
    if (key != null && val !== undefined) out[key] = val;
  }
  return out;
}

function normalizeDevice(raw, extras = {}) {
  const d = unwrapDevicePayload(raw);
  if (!d || typeof d !== 'object') return d;
  const serial = d.device_serial || d.id || d.name || extras.nrfId;
  const lastSeen = d.last_seen || d.updated_date || d.created_date || extras.nrfUpdated || null;
  let connected;
  if (lastSeen) {
    const age = Date.now() - new Date(lastSeen).getTime();
    connected = Number.isFinite(age) ? age < ONLINE_MS : undefined;
  }
  const nrfReported = extras.nrfState?.reported || extras.nrfState?.state?.reported || null;
  if (nrfReported?.connected === true || nrfReported?.connected === false) connected = nrfReported.connected;
  const flat = flattenAttributes(extras.attributes);
  const fwVer =
    d.last_seen_release?.version ||
    d.last_seen_software_version?.version ||
    d.software_version ||
    nrfReported?.device?.deviceInfo?.appVersion ||
    extras.nrfFirmware ||
    flat.app_version ||
    flat.zephyr_version ||
    null;
  const modemFw = flat.modem_fw_version || flat.modemFirmware || nrfReported?.device?.deviceInfo?.modemFirmware;
  const baseReported = {
    connected,
    device: {
      deviceInfo: {
        appVersion: fwVer || undefined,
        modemFirmware: modemFw || undefined,
        imei: flat.imei || undefined,
      },
      networkInfo: {},
    },
  };
  const reported = nrfReported ? deepMerge(baseReported, nrfReported) : baseReported;
  if (reported.device?.deviceInfo) {
    if (fwVer && !reported.device.deviceInfo.appVersion) reported.device.deviceInfo.appVersion = fwVer;
    if (modemFw && !reported.device.deviceInfo.modemFirmware) reported.device.deviceInfo.modemFirmware = modemFw;
    if (flat.imei && !reported.device.deviceInfo.imei) reported.device.deviceInfo.imei = flat.imei;
  }
  // Soft-map Memfault attribute keys into networkInfo / simInfo when shadow empty
  if (reported.device) {
    const ni = reported.device.networkInfo || (reported.device.networkInfo = {});
    const si = reported.device.simInfo || (reported.device.simInfo = {});
    const mapNi = [
      ['mccmnc', ['mccmnc', 'mcc_mnc', 'plmn']],
      ['currentBand', ['current_band', 'lte_band', 'band']],
      ['areaCode', ['area_code', 'tac']],
      ['cellID', ['cell_id', 'cellid', 'eci']],
      ['networkMode', ['network_mode', 'access_tech']],
      ['rsrp', ['rsrp']],
      ['rsrq', ['rsrq']],
      ['ipAddress', ['ip_address', 'ip']],
    ];
    for (const [dst, keys] of mapNi) {
      if (ni[dst] != null && ni[dst] !== '') continue;
      for (const k of keys) {
        if (flat[k] != null && flat[k] !== '') { ni[dst] = flat[k]; break; }
      }
    }
    if (!si.iccid && (flat.iccid || flat.sim_iccid)) si.iccid = flat.iccid || flat.sim_iccid;
    if (!si.imsi && (flat.imsi || flat.sim_imsi)) si.imsi = flat.imsi || flat.sim_imsi;
  }
  return {
    id: String(serial),
    name: d.nickname || d.name || extras.nrfName || String(serial),
    device_serial: d.device_serial || String(serial),
    hardware_version: d.hardware_version,
    cohort: d.cohort,
    firmware: fwVer ? { app: { version: fwVer } } : (d.firmware || extras.nrfFirmwareObj || {}),
    $meta: { updatedAt: lastSeen || extras.nrfUpdated || null },
    state: { reported },
    last_seen: lastSeen,
    last_seen_release: d.last_seen_release,
    _memfault: d,
    _attributes: extras.attributes || undefined,
    _nrf: extras.nrfRaw || undefined,
  };
}

function normalizeList(data) {
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (Array.isArray(data?.data)) list = data.data;
  else if (Array.isArray(data?.items)) list = data.items;
  else if (Array.isArray(data?.data?.data)) list = data.data.data;
  return { items: list.map((x) => normalizeDevice(x)), total: list.length };
}

function mapPath(pathname, search, org, project) {
  const p = pathname || '/';
  const q = search || '';
  if (p.startsWith('/api/v0/')) return { host: MEMFAULT_HOST, path: p + q, normalize: null, kind: 'memfault' };
  if (/^\/messages\/?$/.test(p)) {
    return { host: NRF_HOST, path: `/v1/messages${q}`, normalize: null, kind: 'nrf-messages' };
  }
  if (/^\/location\/history\/?$/.test(p)) {
    return {
      host: NRF_HOST,
      path: `/v1/location/history${q}`,
      normalize: null,
      kind: 'nrf-location',
      altPath: `/v1/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/location/history${q}`,
    };
  }
  const base = projectBase(org, project);
  if (/^\/devices\/?$/.test(p)) {
    const params = new URLSearchParams(q.startsWith('?') ? q.slice(1) : q);
    if (params.has('pageLimit') && !params.has('per_page')) {
      params.set('per_page', params.get('pageLimit'));
      params.delete('pageLimit');
    }
    params.delete('pageSort');
    params.delete('includeState');
    params.delete('includeStateMeta');
    const qs = params.toString();
    return { host: MEMFAULT_HOST, path: `${base}/devices${qs ? `?${qs}` : ''}`, normalize: 'list', kind: 'memfault-list' };
  }
  const stateM = p.match(/^\/devices\/([^/]+)\/state\/?$/);
  if (stateM) {
    const id = decodeURIComponent(stateM[1]);
    return { host: NRF_HOST, path: `/v1/devices/${encodeURIComponent(id)}/state${q}`, normalize: null, kind: 'nrf-state', deviceId: id, write: true };
  }
  const msgM = p.match(/^\/devices\/([^/]+)\/messages\/?$/);
  if (msgM) {
    const id = decodeURIComponent(msgM[1]);
    return { host: NRF_HOST, path: `/v1/devices/${encodeURIComponent(id)}/messages${q}`, normalize: null, kind: 'nrf-c2d', deviceId: id, write: true };
  }
  const m = p.match(/^\/devices\/([^/]+)(\/attributes)?\/?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const suffix = m[2] || '';
    return {
      host: MEMFAULT_HOST,
      path: `${base}/devices/${encodeURIComponent(id)}${suffix}${q}`,
      normalize: suffix ? null : 'device',
      kind: suffix ? 'memfault-attributes' : 'memfault-device',
      deviceId: id,
    };
  }
  return null;
}

function resolveAuth(rawH) {
  const auth = rawH.authorization || rawH.Authorization || '';
  const emailHdr = (rawH['x-user-email'] || rawH['X-User-Email'] || '').trim();
  const rawKey = (rawH['x-user-api-key'] || rawH['X-User-Api-Key'] || '').trim();
  if (/^Basic\s+/i.test(auth) || /^Bearer\s+/i.test(auth)) return auth;
  if (emailHdr && (rawKey || auth)) {
    const key = rawKey || auth.replace(/^Bearer\s+/i, '').trim();
    return `Basic ${Buffer.from(`${emailHdr}:${key}`, 'utf8').toString('base64')}`;
  }
  if (rawKey) return `Bearer ${rawKey}`;
  return auth || null;
}

async function upstreamFetch(url, method, auth, body, label, { tryBearerFallback = false } = {}) {
  const variants = tryBearerFallback ? authVariants(auth) : [auth];
  let last = null;
  for (let i = 0; i < variants.length; i++) {
    const a = variants[i];
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: a,
      },
      body,
    });
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json().catch(() => null) : await res.text();
    const mode = /^Bearer/i.test(a) ? 'Bearer' : (/^Basic/i.test(a) ? 'Basic' : 'Auth');
    console.log(`[nrfcloud-fn] ${label || method} ${url} → ${res.status} (${mode})`);
    last = { res, data, contentType };
    if (tryBearerFallback && (res.status === 401 || res.status === 403) && i < variants.length - 1) continue;
    return last;
  }
  return last;
}

async function enrichDevice(memfaultAuth, nrfAuth, org, project, deviceId, memfaultRaw) {
  const extras = {};
  const base = projectBase(org, project);
  try {
    const attrUrl = `${MEMFAULT_HOST}${base}/devices/${encodeURIComponent(deviceId)}/attributes?q=*`;
    const { res, data } = await upstreamFetch(attrUrl, 'GET', memfaultAuth, undefined, 'MEMFAULT attributes');
    if (res.ok) extras.attributes = data;
  } catch { /* soft */ }

  // Prefer team Simple Token for FetchDevice(includeState) — User OAT often omits full shadow
  let nrfRaw = null;
  const authOrder = [...new Set([nrfAuth, memfaultAuth].filter(Boolean))];
  for (const qs of ['?includeState=true', '']) {
    let got = false;
    for (const a of authOrder) {
      try {
        const url = `${NRF_HOST}/v1/devices/${encodeURIComponent(deviceId)}${qs}`;
        const { res, data } = await upstreamFetch(url, 'GET', a, undefined, 'NRF FetchDevice', { tryBearerFallback: true });
        if (res.ok && data) { nrfRaw = data; got = true; break; }
      } catch { /* soft */ }
    }
    if (got) break;
  }
  if (nrfRaw) {
    extras.nrfRaw = nrfRaw;
    extras.nrfId = nrfRaw.id || nrfRaw.deviceId;
    extras.nrfName = nrfRaw.name;
    extras.nrfUpdated = nrfRaw.$meta?.updatedAt || nrfRaw.updatedAt;
    extras.nrfState = nrfRaw.state || nrfRaw;
    extras.nrfFirmware = nrfRaw.firmware?.app?.version;
    extras.nrfFirmwareObj = nrfRaw.firmware;
  }
  return normalizeDevice(memfaultRaw, extras);
}

/** CORS: public dashboard on github.io calls this Netlify function cross-origin. */
const CORS_ALLOW_HEADERS =
  'Authorization, Content-Type, X-User-Email, X-User-Api-Key, X-Memfault-Org, X-Memfault-Project, X-Org-Slug, X-Project-Slug, X-Nrf-Team-Key, X-Device-Id, Cache-Control';

function corsOrigin(event) {
  const origin = (event?.headers?.origin || event?.headers?.Origin || '').toString();
  // Mirror existing *: no credentials on fetch. Prefer echoing known public origins.
  if (
    origin === 'https://guilhermeromio-netto-prog.github.io' ||
    /\.github\.io$/i.test((() => { try { return new URL(origin).hostname; } catch { return ''; } })()) ||
    /\.netlify\.app$/i.test((() => { try { return new URL(origin).hostname; } catch { return ''; } })()) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
  ) {
    return origin || '*';
  }
  return '*';
}

function corsHeaders(event, extra = {}) {
  return {
    'Access-Control-Allow-Origin': corsOrigin(event),
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    ...extra,
  };
}

function json(statusCode, body, extraHeaders = {}, event = null) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(event),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(event),
      body: '',
    };
  }

  let path = (event.path || '').replace('/.netlify/functions/nrfcloud', '') || '/';
  if (!path.startsWith('/')) path = '/' + path;
  const query = event.queryStringParameters
    ? '?' + new URLSearchParams(event.queryStringParameters).toString()
    : '';

  const rawH = event.headers || {};
  const org = (rawH['x-memfault-org'] || rawH['X-Memfault-Org'] || rawH['x-org-slug'] || DEFAULT_ORG).toString().trim() || DEFAULT_ORG;
  const project = (rawH['x-memfault-project'] || rawH['X-Memfault-Project'] || rawH['x-project-slug'] || DEFAULT_PROJECT).toString().trim() || DEFAULT_PROJECT;

  for (const u of UNSUPPORTED_WRITES) {
    if (u.re.test(path + query)) {
      return json(501, {
        error: 'Not implemented on Memfault/nRF dual proxy',
        feature: u.feature,
        detail: `Write/FOTA sem mapeamento. Org=${org} Project=${project}.`,
      });
    }
  }

  const mapped = mapPath(path, query, org, project);
  if (!mapped) return json(501, { error: 'Unmapped path', path: path + query });

  const auth = resolveAuth(rawH);
  if (!auth) {
    return json(401, { error: 'Missing Authorization', detail: 'Basic email:UserAPIKey ou Bearer OAT' });
  }
  const nrfAuth = resolveNrfAuth(rawH, auth);

  const method = event.httpMethod;
  let body;
  if (['GET', 'HEAD'].includes(method)) body = undefined;
  else if (mapped.kind === 'nrf-state') body = JSON.stringify(normalizeDesiredBody(event.body ? JSON.parse(event.body) : {}));
  else if (mapped.kind === 'nrf-c2d') {
    const parsed = event.body ? (typeof event.body === 'string' ? JSON.parse(event.body) : event.body) : {};
    body = JSON.stringify(normalizeC2dBody(parsed, mapped.deviceId));
  } else body = event.body;

  try {
    if (mapped.kind === 'nrf-location') {
      let primary = await upstreamFetch(`${mapped.host}${mapped.path}`, method, nrfAuth, body, 'NRF location', { tryBearerFallback: true });
      if (!primary.res.ok && mapped.altPath && [404, 400, 501, 405].includes(primary.res.status)) {
        const alt = await upstreamFetch(`${mapped.host}${mapped.altPath}`, method, nrfAuth, body, 'NRF location-org', { tryBearerFallback: true });
        if (alt.res.ok || alt.res.status < primary.res.status) primary = alt;
      }
      return {
        statusCode: primary.res.status,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(event),
          'X-Proxy-Upstream': `${mapped.host}${mapped.path}`,
        },
        body: typeof primary.data === 'string' ? JSON.stringify({ raw: primary.data }) : JSON.stringify(primary.data),
      };
    }

    const url = `${mapped.host}${mapped.path}`;
    const useNrf = mapped.kind.startsWith('nrf-');
    const upAuth = useNrf ? nrfAuth : auth;
    const { res, data, contentType } = await upstreamFetch(url, method, upAuth, body, mapped.kind.toUpperCase(), { tryBearerFallback: useNrf });
    if (mapped.write && (res.status === 401 || res.status === 403)) {
      return json(res.status, {
        error: 'Upstream auth failed for device write',
        feature: mapped.kind,
        detail: 'Shadow PATCH / c2d need team Simple Token (X-Nrf-Team-Key) with write scope.',
        docs: 'https://docs.memfault.com/docs/legacy-nrfcloud/tokens-and-keys',
        upstream: typeof data === 'object' && data ? data : { raw: data },
      });
    }
    let out = data;
    if (res.ok && typeof data === 'object' && data !== null) {
      if (mapped.normalize === 'list') out = normalizeList(data);
      else if (mapped.normalize === 'device' && mapped.deviceId) {
        out = await enrichDevice(auth, nrfAuth, org, project, mapped.deviceId, data);
      }
    }
    return {
      statusCode: res.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(event),
        'X-Proxy-Upstream': url,
      },
      body: typeof out === 'string' ? JSON.stringify({ raw: out }) : JSON.stringify(out),
    };
  } catch (err) {
    return json(502, { error: 'Bad gateway', detail: err.message });
  }
}
