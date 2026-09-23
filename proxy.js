import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3001;
const MEMFAULT_HOST = 'https://api.memfault.com';
const NRF_HOST = 'https://api.nrfcloud.com';
const DEFAULT_ORG = process.env.MEMFAULT_ORG || 'telekom';
const DEFAULT_PROJECT = process.env.MEMFAULT_PROJECT || 'nrf-project';
const ONLINE_MS = Number(process.env.MEMFAULT_ONLINE_MS || 15 * 60 * 1000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));


const SERIAL_JSON_CANDIDATES = [
  path.join(__dirname, 'serial-telemetry.json'),
  '/tmp/thingy-serial-telemetry.json',
];

function readSerialTelemetry() {
  for (const fp of SERIAL_JSON_CANDIDATES) {
    try {
      if (!fs.existsSync(fp)) continue;
      const raw = fs.readFileSync(fp, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') return { ...obj, _path: fp };
    } catch (e) {
      console.log(`[Proxy] serial read fail ${fp}: ${e.message}`);
    }
  }
  return null;
}

function softMessagesFromSerial(serial, deviceId) {
  if (!serial || !serial.ok) return [];
  const now = serial.updatedAt || new Date().toISOString();
  const did = deviceId || 'serial';
  const msgs = [];
  const push = (appId, data) => {
    if (data == null) return;
    msgs.push({
      receivedAt: now,
      deviceId: did,
      message: { appId, data, messageType: 'DATA' },
      _source: 'serial',
    });
  };
  if (serial.temperatureC != null) push('TEMP', { value: serial.temperatureC });
  if (serial.humidityPct != null) push('HUMID', { value: serial.humidityPct });
  if (serial.pressure != null) {
    let pv = Number(serial.pressure);
    if (pv >= 50 && pv <= 120) pv = pv * 10; // kPa → hPa
    else if (pv >= 50000 && pv <= 120000) pv = pv / 100;
    push('AIR_PRESS', { value: pv, unit: 'hPa' });
  }
  if (serial.batteryMv != null) push('BATTERY', { voltage: serial.batteryMv / 1000, v: serial.batteryMv / 1000, batteryVoltage: serial.batteryMv / 1000 });
  if (serial.rsrp != null) push('RSRP', { value: serial.rsrp });
  if (serial.lat != null && serial.lon != null) {
    push('GNSS', {
      lat: serial.lat,
      lon: serial.lon,
      lng: serial.lon,
      acc: serial.locationAccuracy,
      accuracy: serial.locationAccuracy,
      source: serial.locationSource || 'serial',
    });
  }
  if (serial.operator || serial.mccMnc || serial.band != null || serial.ipAddress || serial.networkMode) {
    push('DEVICE', {
      networkOperator: serial.operator,
      mccmnc: serial.mccMnc,
      currentBand: serial.band,
      supportedBands: serial.supportedBands,
      networkMode: serial.networkMode || serial.accessTech,
      ueMode: serial.ueMode,
      ipAddress: serial.ipAddress,
      areaCode: serial.tacDec ?? serial.tac,
      cellID: serial.eciDec ?? serial.cellId ?? serial.eci,
      rsrp: serial.rsrp,
      rsrq: serial.rsrq,
      snr: serial.snr,
      wifiApCount: serial.wifiApCount,
      batteryVoltage: serial.batteryMv != null ? serial.batteryMv / 1000 : undefined,
    });
  }
  return msgs;
}


/** Cache cell/wifi→coords (OAT Location Services). */
const cellResolveCache = new Map(); // key -> { lat, lon, uncertainty, fulfilledWith, at }
const wifiResolveCache = new Map();
const CELL_RESOLVE_TTL_MS = 5 * 60 * 1000;
const WIFI_RESOLVE_TTL_MS = 5 * 60 * 1000;
/** Cached nRF Cloud tenant UUID for x-nrfcloud-tenantid (required by /location/wifi). */
let cachedTenantId = (process.env.NRF_TENANT_ID || process.env.NRFCLOUD_TENANT_ID || '').trim() || null;
let tenantDiscoverAt = 0;
const TENANT_TTL_MS = 60 * 60 * 1000;

function cellResolveKey(serial) {
  if (!serial) return null;
  const mcc = serial.mcc, mnc = serial.mnc;
  const eci = serial.eciDec ?? (serial.eci ? parseInt(String(serial.eci), 16) : null);
  const tac = serial.tacDec ?? (serial.tac ? parseInt(String(serial.tac), 16) : null);
  if (mcc == null || mnc == null || !Number.isFinite(eci) || !Number.isFinite(tac)) return null;
  return `${mcc}:${mnc}:${eci}:${tac}`;
}

function isLocallyAdministeredMac(mac) {
  const parts = String(mac || '').toLowerCase().replace(/-/g, ':').split(':');
  if (parts.length !== 6) return true;
  const first = parseInt(parts[0], 16);
  if (!Number.isFinite(first)) return true;
  return (first & 0x02) !== 0 || (first & 0x01) !== 0;
}

function usableWifiAps(serial) {
  const raw = Array.isArray(serial?.wifiAps) ? serial.wifiAps : [];
  const out = [];
  const seen = new Set();
  for (const ap of raw) {
    const mac = String(ap?.mac || ap?.macAddress || '').toLowerCase().replace(/-/g, ':');
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) continue;
    if (isLocallyAdministeredMac(mac)) continue;
    if (seen.has(mac)) continue;
    seen.add(mac);
    const entry = { macAddress: mac };
    let rssi = ap?.rssi ?? ap?.signalStrength;
    if (rssi != null) {
      rssi = Number(rssi);
      if (Number.isFinite(rssi)) {
        if (rssi > 0) rssi = -rssi;
        if (rssi >= -120 && rssi <= 0) entry.signalStrength = Math.round(rssi);
      }
    }
    out.push(entry);
  }
  return out;
}

function wifiResolveKey(aps) {
  return aps.map((a) => a.macAddress).sort().join(',');
}

async function discoverTenantId(auth, deviceIdHint) {
  if (cachedTenantId && Date.now() - tenantDiscoverAt < TENANT_TTL_MS) return cachedTenantId;
  const candidates = [];
  if (deviceIdHint) candidates.push(`${NRF_HOST}/v1/devices/${encodeURIComponent(deviceIdHint)}`);
  candidates.push(`${NRF_HOST}/v1/devices?pageLimit=1`);
  for (const url of candidates) {
    try {
      const { response, data } = await upstreamFetch(url, 'GET', auth, undefined, 'NRF tenant-discover', { tryBearerFallback: true });
      if (!response.ok || !data) continue;
      const items = Array.isArray(data) ? data : (data.items || data.data || [data]);
      for (const it of items) {
        const tid = it?.tenantId || it?.tenant_id || it?.$meta?.tenantId;
        if (tid && /^[0-9a-fA-F-]{8,}$/.test(String(tid))) {
          cachedTenantId = String(tid);
          tenantDiscoverAt = Date.now();
          console.log(`[Proxy] tenantId cached len=${cachedTenantId.length} prefix=${cachedTenantId.slice(0, 8)}`);
          return cachedTenantId;
        }
      }
    } catch (e) {
      console.log('[Proxy] tenant-discover soft fail:', e.message || e);
    }
  }
  return cachedTenantId;
}

async function resolveWifiLocation(serial, auth, org, project, { tenantId = null, deviceId = null, authCandidates = null } = {}) {
  if (!serial || serial.lat != null) return serial;
  const aps = usableWifiAps(serial);
  if (aps.length < 2) return serial;

  const key = wifiResolveKey(aps);
  const hit = wifiResolveCache.get(key);
  if (hit && Date.now() - hit.at < WIFI_RESOLVE_TTL_MS) {
    return {
      ...serial,
      lat: hit.lat,
      lon: hit.lon,
      locationAccuracy: hit.uncertainty,
      locationSource: hit.fulfilledWith ? `wifi_${String(hit.fulfilledWith).toLowerCase()}` : 'wifi',
      wifiApCount: aps.length,
    };
  }

  // Docs: Wi-Fi Location Services wants OAT Bearer. Team Simple Token often 401s on /wifi
  // while still working for /cell — try OAT/memfault auth first, then team key.
  const auths = [];
  for (const a of (authCandidates || [auth])) {
    if (a && !auths.includes(a)) auths.push(a);
  }
  if (!auths.length) return serial;

  const url = `${NRF_HOST}/v1/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/location/wifi`;
  const body = JSON.stringify({ accessPoints: aps });
  let tenant = (tenantId || cachedTenantId || '').trim() || null;
  if (!tenant) tenant = await discoverTenantId(auths[0], deviceId);

  const headerAttempts = [];
  if (tenant) headerAttempts.push({ label: 'with-tenant', headers: { 'x-nrfcloud-tenantid': tenant } });
  headerAttempts.push({ label: 'no-tenant', headers: null });

  for (let ai = 0; ai < auths.length; ai++) {
    const a = auths[ai];
    const authKind = /^Bearer/i.test(a) ? 'Bearer' : (/^Basic/i.test(a) ? 'Basic' : 'Auth');
    for (const attempt of headerAttempts) {
      try {
        const { response, data } = await upstreamFetch(
          url,
          'POST',
          a,
          body,
          `NRF location-wifi (${attempt.label}, ${authKind}, ${aps.length} APs)`,
          { tryBearerFallback: true, extraHeaders: attempt.headers },
        );
        const snippet = typeof data === 'object' && data ? JSON.stringify(data).slice(0, 180) : String(data || '').slice(0, 180);
        if (response.ok && data && data.lat != null && data.lon != null) {
          const entry = {
            lat: Number(data.lat),
            lon: Number(data.lon),
            uncertainty: data.uncertainty != null ? Number(data.uncertainty) : undefined,
            fulfilledWith: data.fulfilledWith || 'WIFI',
            at: Date.now(),
          };
          wifiResolveCache.set(key, entry);
          console.log(`[Proxy] wifi-resolve OK ${aps.length}APs → ${entry.lat.toFixed(5)},${entry.lon.toFixed(5)} (${entry.fulfilledWith}, ${attempt.label}, ${authKind})`);
          return {
            ...serial,
            lat: entry.lat,
            lon: entry.lon,
            locationAccuracy: entry.uncertainty,
            locationSource: `wifi_${String(entry.fulfilledWith).toLowerCase()}`,
            wifiApCount: aps.length,
          };
        }
        console.log(`[Proxy] wifi-resolve ${response.status} (${attempt.label}, ${authKind}): ${snippet}`);
        if (!tenant && (response.status === 400 || response.status === 403 || response.status === 422)) {
          tenant = await discoverTenantId(a, deviceId);
          if (tenant && !headerAttempts.some((h) => h.label === 'with-tenant-retry')) {
            headerAttempts.push({ label: 'with-tenant-retry', headers: { 'x-nrfcloud-tenantid': tenant } });
          }
        }
      } catch (e) {
        console.log(`[Proxy] wifi-resolve error (${attempt.label}, ${authKind}):`, e.message || e);
      }
    }
  }
  return serial;
}

async function resolveSerialCellLocation(serial, auth, org, project) {
  if (!serial || serial.lat != null || !auth) return serial;
  const key = cellResolveKey(serial);
  if (!key) return serial;
  const hit = cellResolveCache.get(key);
  if (hit && Date.now() - hit.at < CELL_RESOLVE_TTL_MS) {
    return {
      ...serial,
      lat: hit.lat,
      lon: hit.lon,
      locationAccuracy: hit.uncertainty,
      locationSource: hit.fulfilledWith ? `cell_${String(hit.fulfilledWith).toLowerCase()}` : 'cell_resolve',
    };
  }
  const [, , eci, tac] = key.split(':').map(Number);
  const mcc = serial.mcc, mnc = serial.mnc;
  const url = `${NRF_HOST}/v1/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/location/cell`;
  try {
    const { response, data } = await upstreamFetch(
      url,
      'POST',
      auth,
      JSON.stringify({ lte: [{ mcc, mnc, eci, tac }] }),
      'NRF location-cell',
      { tryBearerFallback: true },
    );
    if (response.ok && data && data.lat != null && data.lon != null) {
      const entry = {
        lat: Number(data.lat),
        lon: Number(data.lon),
        uncertainty: data.uncertainty != null ? Number(data.uncertainty) : undefined,
        fulfilledWith: data.fulfilledWith || 'SCELL',
        at: Date.now(),
      };
      cellResolveCache.set(key, entry);
      console.log(`[Proxy] cell-resolve OK ${key} → ${entry.lat.toFixed(5)},${entry.lon.toFixed(5)} (${entry.fulfilledWith})`);
      return {
        ...serial,
        lat: entry.lat,
        lon: entry.lon,
        locationAccuracy: entry.uncertainty,
        locationSource: `cell_${String(entry.fulfilledWith).toLowerCase()}`,
      };
    }
    console.log(`[Proxy] cell-resolve ${response.status} for ${key}:`, typeof data === 'object' ? JSON.stringify(data).slice(0, 160) : data);
  } catch (e) {
    console.log('[Proxy] cell-resolve error:', e.message || e);
  }
  return serial;
}

/** Prefer Wi-Fi (≥2 usable APs) then SCELL fallback. */
async function enrichSerialLocation(serial, auth, org, project, opts = {}) {
  const candidates = [];
  for (const a of (opts.authCandidates || [auth])) {
    if (a && !candidates.includes(a)) candidates.push(a);
  }
  if (!serial || !candidates.length) return serial;
  if (serial.lat != null && serial.lon != null) return serial;
  const tenantHdr = (opts.tenantId || '').trim() || null;
  if (tenantHdr) {
    cachedTenantId = tenantHdr;
    tenantDiscoverAt = Date.now();
  }
  let out = serial;
  const aps = usableWifiAps(out);
  if (aps.length >= 2) {
    out = await resolveWifiLocation(out, candidates[0], org, project, {
      tenantId: tenantHdr || cachedTenantId,
      deviceId: opts.deviceId || null,
      authCandidates: candidates,
    });
  }
  if (out.lat == null) {
    // Cell accepts team Simple Token; try each candidate until one works
    for (const a of candidates) {
      out = await resolveSerialCellLocation(out, a, org, project);
      if (out.lat != null) break;
    }
  }
  return out;
}

async function mergeSerialIntoMessages(data, status, reqUrl, auth, org, project, memfaultAuth = null) {
  let serial = readSerialTelemetry();
  if (!serial) return { data, status, serial: null };
  const u = new URL(reqUrl, 'http://local');
  const deviceId = u.searchParams.get('deviceId') || undefined;
  const candidates = [];
  // OAT/Memfault first for Wi-Fi LS; team key second (works for SCELL)
  if (memfaultAuth) candidates.push(memfaultAuth);
  if (auth && !candidates.includes(auth)) candidates.push(auth);
  serial = await enrichSerialLocation(serial, candidates[0] || auth, org || DEFAULT_ORG, project || DEFAULT_PROJECT, {
    deviceId,
    authCandidates: candidates,
  });
  const soft = softMessagesFromSerial(serial, deviceId);

  // 401/403 or empty → synthesize soft messages so UI still paints sensors
  const emptyArr = Array.isArray(data) && data.length === 0;
  const emptyObj = data && typeof data === 'object' && !Array.isArray(data)
    && !((data.items || data.data || []).length);
  const authFail = status === 401 || status === 403;

  if (authFail || emptyArr || emptyObj || status >= 500) {
    if (soft.length) {
      const wrapped = {
        items: soft,
        total: soft.length,
        serial,
        _serialFallback: true,
        _upstreamStatus: status,
      };
      return { data: wrapped, status: 200, serial };
    }
  }

  // Successful cloud msgs: attach serial overlay object (UI can merge)
  if (Array.isArray(data)) {
    return { data: { items: data, total: data.length, serial }, status, serial };
  }
  if (data && typeof data === 'object') {
    return { data: { ...data, serial }, status, serial };
  }
  return { data, status, serial };
}


app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));
// GitHub Pages path alias so /thingy91x-dashboard/* also serves local assets on localhost
app.use('/thingy91x-dashboard', express.static(__dirname));
app.get(['/thingy91x-dashboard', '/thingy91x-dashboard/'], (_req, res) => {
  res.redirect(302, '/');
});

/** Legacy FOTA still 501 — shadow PATCH + c2d are forwarded to api.nrfcloud.com */
const UNSUPPORTED_WRITES = [
  { re: /^\/(?:firmware|firmwares|fota)(?:\/|$|\?)/i, feature: 'legacy FOTA / firmware bundles' },
];

/**
 * Map UI flat fields (led / gpsInterval / buzzer) into ATT 1.5-friendly desired.config
 * while preserving custom JSON keys. Body shape: { desired: {...} } or raw desired.
 * ATT: desired.config.sample_interval / storage_threshold / update_interval
 * Docs: Asset-Tracker-Template configuration + PATCH /v1/devices/{id}/state
 */
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

  const config = {
    ...(desiredIn.config && typeof desiredIn.config === 'object' ? desiredIn.config : {}),
  };
  const desired = { ...desiredIn };

  if (desired.gpsInterval != null && config.sample_interval == null) {
    const n = Number(desired.gpsInterval);
    if (Number.isFinite(n) && n > 0) config.sample_interval = Math.round(n);
    delete desired.gpsInterval;
  }
  if (desired.sample_interval != null && config.sample_interval == null) {
    config.sample_interval = desired.sample_interval;
    delete desired.sample_interval;
  }
  if (desired.update_interval != null && config.update_interval == null) {
    config.update_interval = desired.update_interval;
    delete desired.update_interval;
  }
  if (desired.storage_threshold != null && config.storage_threshold == null) {
    config.storage_threshold = desired.storage_threshold;
    delete desired.storage_threshold;
  }
  if (desired.led != null && config.led == null) {
    config.led = desired.led;
    // keep top-level led for non-ATT firmwares that listen outside config
  }
  if (desired.buzzer != null && config.buzzer == null) {
    config.buzzer = desired.buzzer;
  }

  if (Object.keys(config).length) desired.config = config;

  const out = hasDesiredWrapper ? { ...payload, desired } : { desired };
  return out;
}

/** Wrap UI ping / raw JSON into SendDeviceMessage body when needed. */
function normalizeC2dBody(raw, deviceId) {
  let payload = raw;
  if (typeof raw === 'string') {
    try { payload = JSON.parse(raw); } catch { return raw; }
  }
  if (!payload || typeof payload !== 'object') {
    return {
      message: { appId: 'PING', data: payload, messageType: 'DATA' },
      topic: `m/d/${deviceId}/c2d`,
    };
  }
  if (payload.message != null || payload.topic != null) return payload;
  return {
    message: payload.appId ? payload : { appId: 'PING', data: payload, messageType: 'DATA' },
    topic: `m/d/${deviceId}/c2d`,
  };
}

function writeAuthHint(status, feature) {
  if (status === 401 || status === 403) {
    return {
      error: 'Upstream auth failed for device write',
      feature,
      status,
      detail:
        'PATCH /state e c2d precisam de API Key da equipe (Simple Token / team key) com escopo de escrita no portal nRF Cloud (legado). Cole em Engrenagem → API Key da equipe (X-Nrf-Team-Key). OAT/User API Key costuma bastar para leitura Memfault, não para shadow write.',
      docs: 'https://docs.memfault.com/docs/legacy-nrfcloud/tokens-and-keys',
      shadowDocs: 'https://api.nrfcloud.com/#tag/IP-Devices/operation/UpdateDeviceState',
    };
  }
  return null;
}

function projectBase(org, project) {
  return `/api/v0/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}`;
}

function resolveAuth(req) {
  const auth = req.headers.authorization || '';
  const emailHdr = (req.headers['x-user-email'] || '').trim();
  const rawKey = (req.headers['x-user-api-key'] || '').trim();

  if (/^Basic\s+/i.test(auth) || /^Bearer\s+/i.test(auth)) {
    return auth;
  }
  if (emailHdr && (rawKey || auth)) {
    const key = rawKey || auth.replace(/^Bearer\s+/i, '').trim();
    const token = Buffer.from(`${emailHdr}:${key}`, 'utf8').toString('base64');
    return `Basic ${token}`;
  }
  if (rawKey) {
    return `Bearer ${rawKey}`;
  }
  return auth || null;
}

/** Simple Token (team API key) for ListMessages / location / FetchDevice — not OAT */
let _loggedTeamKey = false;
function resolveNrfAuth(req, memfaultAuth) {
  const team = (req.headers['x-nrf-team-key'] || '').trim().replace(/^(Bearer)\s+/i, '');
  if (team) {
    if (!_loggedTeamKey) {
      const hex = /^[0-9a-fA-F]{32,64}$/.test(team);
      console.log(`[Proxy] X-Nrf-Team-Key len=${team.length} hex=${hex} prefix=${team.slice(0, 4)}`);
      _loggedTeamKey = true;
    }
    return `Bearer ${team}`;
  }
  if (!_loggedTeamKey) {
    console.log('[Proxy] X-Nrf-Team-Key missing — msgs will use Memfault auth (likely 401)');
    _loggedTeamKey = true;
  }
  return memfaultAuth;
}

/** For nRF Cloud: if Basic fails, many tenants accept Bearer with the API key alone. */
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
  // de-dupe
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
  if (nrfReported?.connected === true || nrfReported?.connected === false) {
    connected = nrfReported.connected;
  }

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

/** Map path → Memfault (devices) or nRF Cloud (messages / location) */
function mapPath(reqPath, org, project) {
  const u = new URL(reqPath, 'http://local');
  const p = u.pathname;
  const q = u.search;

  if (p.startsWith('/api/v0/')) {
    return { host: MEMFAULT_HOST, path: p + q, normalize: null, kind: 'memfault' };
  }

  // Legacy nRF Cloud telemetry — pass query through unchanged
  if (/^\/messages\/?$/.test(p)) {
    return { host: NRF_HOST, path: `/v1/messages${q}`, normalize: null, kind: 'nrf-messages' };
  }
  if (/^\/location\/history\/?$/.test(p)) {
    return {
      host: NRF_HOST,
      path: `/v1/location/history${q}`,
      normalize: null,
      kind: 'nrf-location',
      // OpenAPI has no org-scoped location/history; keep alternate attempt for newer gateways
      altPath: `/v1/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/location/history${q}`,
    };
  }

  const base = projectBase(org, project);

  if (/^\/devices\/?$/.test(p)) {
    const params = new URLSearchParams(u.search);
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

  // Shadow desired PATCH → nRF UpdateDeviceState
  const stateM = p.match(/^\/devices\/([^/]+)\/state\/?$/);
  if (stateM) {
    const id = decodeURIComponent(stateM[1]);
    return {
      host: NRF_HOST,
      path: `/v1/devices/${encodeURIComponent(id)}/state${q}`,
      normalize: null,
      kind: 'nrf-state',
      deviceId: id,
      write: true,
    };
  }

  // c2d / SendDeviceMessage
  const msgM = p.match(/^\/devices\/([^/]+)\/messages\/?$/);
  if (msgM) {
    const id = decodeURIComponent(msgM[1]);
    return {
      host: NRF_HOST,
      path: `/v1/devices/${encodeURIComponent(id)}/messages${q}`,
      normalize: null,
      kind: 'nrf-c2d',
      deviceId: id,
      write: true,
    };
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

async function upstreamFetch(url, method, auth, body, label, { tryBearerFallback = false, extraHeaders = null } = {}) {
  const variants = tryBearerFallback ? authVariants(auth) : [auth];
  let last = null;
  for (let i = 0; i < variants.length; i++) {
    const a = variants[i];
    const headers = {
      Authorization: a,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extraHeaders && typeof extraHeaders === 'object') {
      for (const [hk, hv] of Object.entries(extraHeaders)) {
        if (hv != null && hv !== '') headers[hk] = hv;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const contentType = response.headers.get('content-type') || '';
      let data = contentType.includes('application/json')
        ? await response.json().catch(() => null)
        : await response.text();
      const mode = /^Bearer/i.test(a) ? 'Bearer' : (/^Basic/i.test(a) ? 'Basic' : 'Auth');
      console.log(`[Proxy] ${label || method} ${url} → ${response.status} (${mode})`);
      if (!response.ok && typeof data === 'object' && data && data.message) console.log(`[Proxy] upstream msg: ${data.message}`);
      last = { response, data, contentType };
      // On NRF, if Basic 401/403, try next variant (Bearer key)
      if (tryBearerFallback && (response.status === 401 || response.status === 403) && i < variants.length - 1) {
        continue;
      }
      return last;
    } catch (err) {
      clearTimeout(timeout);
      console.log(`[Proxy] ${label || method} ${url} → ERR ${err.name}: ${err.message}`);
      throw err;
    }
  }
  return last;
}

async function enrichDevice(memfaultAuth, nrfAuth, org, project, deviceId, memfaultRaw) {
  const extras = {};
  const base = projectBase(org, project);

  // Memfault device attributes (best-effort)
  try {
    const attrUrl = `${MEMFAULT_HOST}${base}/devices/${encodeURIComponent(deviceId)}/attributes?q=*`;
    const { response, data } = await upstreamFetch(attrUrl, 'GET', memfaultAuth, undefined, 'MEMFAULT attributes');
    if (response.ok) extras.attributes = data;
  } catch {
    /* soft */
  }

  // nRF Cloud FetchDevice (+ includeState attempt)
  let nrfRaw = null;
  for (const qs of ['?includeState=true', '']) {
    try {
      const url = `${NRF_HOST}/v1/devices/${encodeURIComponent(deviceId)}${qs}`;
      const { response, data } = await upstreamFetch(url, 'GET', nrfAuth, undefined, 'NRF FetchDevice', { tryBearerFallback: true });
      if (response.ok && data) {
        nrfRaw = data;
        break;
      }
    } catch {
      /* soft */
    }
  }
  if (nrfRaw) {
    extras.nrfRaw = nrfRaw;
    extras.nrfId = nrfRaw.id || nrfRaw.deviceId;
    extras.nrfName = nrfRaw.name;
    extras.nrfUpdated = nrfRaw.$meta?.updatedAt || nrfRaw.updatedAt;
    extras.nrfState = nrfRaw.state || nrfRaw;
    extras.nrfFirmware = nrfRaw.firmware?.app?.version;
    extras.nrfFirmwareObj = nrfRaw.firmware;
    const tid = nrfRaw.tenantId || nrfRaw.tenant_id;
    if (tid && /^[0-9a-fA-F-]{8,}$/.test(String(tid))) {
      cachedTenantId = String(tid);
      tenantDiscoverAt = Date.now();
    }
  }

  return normalizeDevice(memfaultRaw, extras);
}


app.get('/api/serial/telemetry', async (req, res) => {
  let serial = readSerialTelemetry();
  if (!serial) {
    return res.status(404).json({
      ok: false,
      error: 'serial-telemetry.json missing',
      hint: 'Start serial_telemetry.py (launcher starts it with proxy)',
    });
  }
  const auth = resolveAuth(req);
  const nrfAuth = resolveNrfAuth(req, auth);
  const org = (req.headers['x-memfault-org'] || req.headers['x-org-slug'] || DEFAULT_ORG).toString().trim() || DEFAULT_ORG;
  const project = (req.headers['x-memfault-project'] || req.headers['x-project-slug'] || DEFAULT_PROJECT).toString().trim() || DEFAULT_PROJECT;
  const tenantHdr = (req.headers['x-nrfcloud-tenantid'] || req.headers['x-nrf-tenant-id'] || '').toString().trim() || null;
  const deviceId = (req.query.deviceId || req.headers['x-device-id'] || '').toString().trim() || null;
  if (auth || nrfAuth) {
    // Prefer Memfault/OAT first for /location/wifi (team Simple Token often 401s there)
    const candidates = [];
    if (auth) candidates.push(auth);
    if (nrfAuth && nrfAuth !== auth) candidates.push(nrfAuth);
    serial = await enrichSerialLocation(serial, candidates[0], org, project, {
      tenantId: tenantHdr,
      deviceId,
      authCandidates: candidates,
    });
  }
  res.set('Cache-Control', 'no-store');
  res.json(serial);
});

app.use('/api', async (req, res) => {

  const start = Date.now();
  const org = (req.headers['x-memfault-org'] || req.headers['x-org-slug'] || DEFAULT_ORG).toString().trim() || DEFAULT_ORG;
  const project = (req.headers['x-memfault-project'] || req.headers['x-project-slug'] || DEFAULT_PROJECT).toString().trim() || DEFAULT_PROJECT;

  for (const u of UNSUPPORTED_WRITES) {
    if (u.re.test(req.url)) {
      return res.status(501).json({
        error: 'Not implemented on Memfault/nRF dual proxy',
        feature: u.feature,
        detail: `Write/FOTA endpoint sem mapeamento seguro. Org=${org} Project=${project}.`,
        docs: 'https://api.nrfcloud.com/v1/openapi.json',
      });
    }
  }

  const mapped = mapPath(req.url, org, project);
  if (!mapped) {
    return res.status(501).json({
      error: 'Unmapped path',
      path: req.url,
      detail: 'Sem mapeamento. Use /devices, /devices/{id}, /messages, /location/history.',
    });
  }

  const auth = resolveAuth(req);
  if (!auth) {
    return res.status(401).json({
      error: 'Missing Authorization',
      detail: 'Envie Basic (email:User API Key) ou Bearer (Organization Auth Token).',
    });
  }
  const nrfAuth = resolveNrfAuth(req, auth);

  const method = req.method;
  let body;
  if (['GET', 'HEAD'].includes(method)) {
    body = undefined;
  } else if (mapped.kind === 'nrf-state') {
    body = JSON.stringify(normalizeDesiredBody(req.body));
    console.log(`[Proxy] shadow desired normalized for ${mapped.deviceId}`);
  } else if (mapped.kind === 'nrf-c2d') {
    body = JSON.stringify(normalizeC2dBody(req.body, mapped.deviceId));
  } else {
    body = JSON.stringify(req.body);
  }

  try {
    // Dual-upstream for location: primary legacy, optional org-scoped fallback (not in OpenAPI)
    if (mapped.kind === 'nrf-location') {
      const primaryUrl = `${mapped.host}${mapped.path}`;
      let { response, data, contentType } = await upstreamFetch(primaryUrl, method, nrfAuth, body, 'NRF location', { tryBearerFallback: true });
      if (!response.ok && mapped.altPath && [404, 400, 501, 405].includes(response.status)) {
        const altUrl = `${mapped.host}${mapped.altPath}`;
        const alt = await upstreamFetch(altUrl, method, nrfAuth, body, 'NRF location-org', { tryBearerFallback: true });
        if (alt.response.status < response.status || alt.response.ok) {
          response = alt.response;
          data = alt.data;
          contentType = alt.contentType;
        }
      }
      res.set('X-Proxy-Latency', `${Date.now() - start}ms`);
      res.set('X-Proxy-Upstream', `${mapped.host}${mapped.path}`);
      res.set('X-Proxy-Org', org);
      res.set('X-Proxy-Project', project);
      res.status(response.status);
      if (contentType.includes('application/json') || typeof data === 'object') res.json(data);
      else res.send(data);
      return;
    }

    const targetUrl = `${mapped.host}${mapped.path}`;
    const useNrf = mapped.kind.startsWith('nrf-');
    const upAuth = useNrf ? nrfAuth : auth;
    const { response, data, contentType } = await upstreamFetch(targetUrl, method, upAuth, body, mapped.kind.toUpperCase(), { tryBearerFallback: useNrf });

    // Clear JSON for write auth failures (not silent 501)
    if (mapped.write && (response.status === 401 || response.status === 403)) {
      const hint = writeAuthHint(response.status, mapped.kind);
      res.set('X-Proxy-Latency', `${Date.now() - start}ms`);
      res.set('X-Proxy-Upstream', targetUrl);
      return res.status(response.status).json({
        ...hint,
        upstream: typeof data === 'object' && data ? data : { raw: data },
      });
    }

    let out = data;
    let statusOut = response.status;
    if (response.ok && contentType.includes('application/json')) {
      if (mapped.normalize === 'list') out = normalizeList(data);
      else if (mapped.normalize === 'device' && mapped.deviceId) {
        out = await enrichDevice(auth, nrfAuth, org, project, mapped.deviceId, data);
        // Overlay serial battery/network onto reported state when cloud shadow lacks them
        const serial = readSerialTelemetry();
        if (serial && out?.state?.reported) {
          const ni = out.state.reported.device?.networkInfo || (out.state.reported.device.networkInfo = {});
          if (serial.operator && !ni.networkOperator) ni.networkOperator = serial.operator;
          if (serial.mccMnc && !ni.mccmnc) ni.mccmnc = serial.mccMnc;
          if (serial.band != null && !ni.currentBand) ni.currentBand = serial.band;
          if (serial.supportedBands && !ni.supportedBands) ni.supportedBands = serial.supportedBands;
          if ((serial.networkMode || serial.accessTech) && !ni.networkMode) ni.networkMode = serial.networkMode || serial.accessTech;
          if (serial.ueMode != null && ni.ueMode == null) ni.ueMode = serial.ueMode;
          if (serial.ipAddress && !ni.ipAddress) ni.ipAddress = serial.ipAddress;
          if (serial.tacDec != null && ni.areaCode == null) ni.areaCode = serial.tacDec;
          if ((serial.eciDec != null || serial.cellId != null) && ni.cellID == null) ni.cellID = serial.eciDec ?? serial.cellId;
          if (serial.rsrp != null && ni.rsrp == null) ni.rsrp = serial.rsrp;
          if (serial.rsrq != null && ni.rsrq == null) ni.rsrq = serial.rsrq;
          if (serial.snr != null && ni.snr == null) ni.snr = serial.snr;
          if (serial.wifiApCount != null && ni.wifiApCount == null) ni.wifiApCount = serial.wifiApCount;
          if (serial.batteryMv != null) {
            out.state.reported.device.batteryStatus = out.state.reported.device.batteryStatus || {};
            if (out.state.reported.device.batteryStatus.voltage == null) {
              out.state.reported.device.batteryStatus.voltage = serial.batteryMv / 1000;
            }
          }
          out.serial = serial;
        }
      }
    }

    if (mapped.kind === 'nrf-messages') {
      const merged = await mergeSerialIntoMessages(out, statusOut, req.url, nrfAuth || auth, org, project, auth);
      out = merged.data;
      statusOut = merged.status;
      if (merged.serial) res.set('X-Proxy-Serial', merged.serial.ok ? 'ok' : 'stale');
    }

    res.set('X-Proxy-Latency', `${Date.now() - start}ms`);
    res.set('X-Proxy-Upstream', targetUrl);
    res.set('X-Proxy-Org', org);
    res.set('X-Proxy-Project', project);
    res.status(statusOut);
    if (contentType.includes('application/json') || typeof out === 'object') {
      res.json(out);
    } else {
      res.send(out);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Gateway timeout' });
    }
    console.error('[Proxy]', err.message);
    res.status(502).json({ error: 'Bad gateway', detail: err.message });
  }
});

app.get('/health', (req, res) =>
  res.json({
    ok: true,
    ts: Date.now(),
    upstream: MEMFAULT_HOST,
    nrfUpstream: NRF_HOST,
    org: DEFAULT_ORG,
    project: DEFAULT_PROJECT,
    telemetry: ['messages', 'location/history', 'devices+attributes', 'nrf-includeState', 'serial', 'shadow-PATCH', 'c2d'],
  })
);

app.listen(PORT, () => {
  console.log(`🚀 Proxy Memfault + nRF Cloud em http://localhost:${PORT}`);
  console.log(`   Memfault: ${MEMFAULT_HOST}/api/v0/organizations/${DEFAULT_ORG}/projects/${DEFAULT_PROJECT}`);
  console.log(`   nRF Cloud telemetry: ${NRF_HOST}/v1/{messages,location/history,devices}`);
  console.log(`   Health:  http://localhost:${PORT}/health`);
  console.log(`   Auth:    Memfault Basic/OAT + optional X-Nrf-Team-Key (Simple Token) for msgs/GPS/shadow write`);
  console.log(`   Serial:  GET /api/serial/telemetry (serial_telemetry.py → serial-telemetry.json)`);
});
