/* Thingy:91X Dashboard v2 — multi-device, comandos, FOTA, geofence, export, PWA
 * Dual proxy (Memfault + nRF Cloud):
 *  GET  /devices?pageLimit=100     -> Memfault .../devices
 *  GET  /devices/{id}              -> Memfault device + attributes + nRF FetchDevice(state)
 *  GET  /messages?deviceId=…       -> nRF Cloud /v1/messages (telemetry)
 *  GET  /location/history?…        -> nRF Cloud /v1/location/history (trail)
 * Auth: Memfault Basic/OAT + optional team Simple Token (X-Nrf-Team-Key) for msgs/GPS
 * Writes: shadow PATCH + c2d forwarded to api.nrfcloud.com (need Simple Token). Still 501: legacy FOTA
 */
// Express (localhost + cloudflared tunnel) serves /api; Netlify uses the function proxy
const NRF_CLOUD_BASE = /netlify\.app$/i.test(location.hostname)
    ? '/.netlify/functions/nrfcloud'
    : '/api';

const DEVICE_DEFAULT = '50423451-3737-4337-80fc-110bddf418ff';
let config = {
    apiKey: localStorage.getItem('nrf_api_key') || '',
    teamApiKey: localStorage.getItem('nrf_team_api_key') || '',
    email: localStorage.getItem('nrf_user_email') || '',
    orgSlug: localStorage.getItem('nrf_org_slug') || 'telekom',
    projectSlug: localStorage.getItem('nrf_project_slug') || 'nrf-project',
    deviceId: localStorage.getItem('nrf_device_id') || DEVICE_DEFAULT
};
let map, marker, accuracyCircle = null, trailLine = null, trailEnabled = true;
let fleetMarkers = [];
let pollInterval = null;
const POLL_MS = 10000;
let lastConnected = null, lastSeenTs = null;
let deviceList = [], lastDeviceRaw = null, lastMessages = [], lastTrail = [], lastSerial = null;
let telemetrySource = { env: null, battery: null, net: null, gps: null };
let geo = JSON.parse(localStorage.getItem('thingy_geo') || 'null');
let geoCircle = null, geoInside = null;
const logCount = { api: 0, err: 0 };

const $ = id => document.getElementById(id);
const elements = {
    connectionStatus: $('connectionStatus'), connLabel: $('connLabel'),
    deviceId: $('deviceId'), deviceName: $('deviceName'), firmwareVersion: $('firmwareVersion'), lastSeen: $('lastSeen'),
    deviceSelect: $('deviceSelect'), refreshFleet: $('refreshFleet'), fleetCount: $('fleetCount'), fleetGrid: $('fleetGrid'), pollFleet: $('pollFleet'),
    gpsCoords: $('gpsCoords'), gpsLat: $('gpsLat'), gpsLon: $('gpsLon'), gpsAcc: $('gpsAcc'), gpsSats: $('gpsSats'), gpsAlt: $('gpsAlt'), gpsSpeed: $('gpsSpeed'),
    tempValue: $('tempValue'), humValue: $('humValue'), pressValue: $('pressValue'),
    accelX: $('accelX'), accelY: $('accelY'), accelZ: $('accelZ'), steps: $('steps'),
    batteryFill: $('batteryFill'), batteryValue: $('batteryValue'), batteryVoltage: $('batteryVoltage'), batteryCharging: $('batteryCharging'),
    rsrp: $('rsrp'), rsrq: $('rsrq'), operator: $('operator'), serviceType: $('serviceType'), netBand: $('netBand'),
    netMccMnc: $('netMccMnc'), netMode: $('netMode'), netSupportedBands: $('netSupportedBands'),
    netTac: $('netTac'), netCellId: $('netCellId'), netUeMode: $('netUeMode'), netIp: $('netIp'),
    netSnr: $('netSnr'), netWifi: $('netWifi'), netSource: $('netSource'),
    centerMap: $('centerMap'), toggleTrail: $('toggleTrail'), trailStatus: $('trailStatus'), trailRange: $('trailRange'),
    configModal: $('configModal'), apiKey: $('apiKey'), teamApiKey: $('teamApiKey'), userEmail: $('userEmail'), orgSlug: $('orgSlug'), projectSlug: $('projectSlug'), deviceIdInput: $('deviceIdInput'),
    saveConfig: $('saveConfig'), cancelConfig: $('cancelConfig'), configBtn: $('configBtn'), closeModal: $('closeModal'),
    logPanel: $('logPanel'), logFilter: $('logFilter'), exportLog: $('exportLog'), clearLog: $('clearLog'),
    connState: $('connState'), connLastSeen: $('connLastSeen'), connLastMsg: $('connLastMsg'), connMsgCount: $('connMsgCount'), connLatency: $('connLatency'), connPoll: $('connPoll'),
    cmdLed: $('cmdLed'), cmdGpsInterval: $('cmdGpsInterval'), cmdBuzzer: $('cmdBuzzer'), cmdCustom: $('cmdCustom'), sendDesired: $('sendDesired'), sendPing: $('sendPing'),
    geoRadius: $('geoRadius'), geoSet: $('geoSet'), geoClear: $('geoClear'), geoState: $('geoState'),
    fotaList: $('fotaList'), fotaType: $('fotaType'), createFota: $('createFota'), refreshFota: $('refreshFota'), fotaJobs: $('fotaJobs'),
    msgTable: $('msgTable'), exportCsv: $('exportCsv'), exportGeo: $('exportGeo'), exportShadow: $('exportShadow'),
    dataSourceBadge: $('dataSourceBadge'),
};
function setText(el, v) { if (el) el.textContent = v; }

/* ---------- Logger ---------- */
const logStore = [];
function log(level, msg, detail) {
    const entry = { ts: new Date().toISOString(), level, msg, detail: detail ? String(detail).slice(0, 600) : '' };
    logStore.push(entry); if (logStore.length > 800) logStore.shift();
    if (level === 'err') logCount.err++;
    renderLogEntry(entry);
}
function renderLogEntry(entry) {
    if (!elements.logPanel) return;
    const f = elements.logFilter?.value || 'all';
    if (f !== 'all' && entry.level !== f) return;
    const div = document.createElement('div');
    div.className = `log-line log-${entry.level}`;
    const time = new Date(entry.ts).toLocaleTimeString('pt-BR', { hour12: false });
    div.innerHTML = `<span class="log-ts">${time}</span><span class="log-lvl">${entry.level.toUpperCase()}</span><span class="log-msg"></span>`;
    div.querySelector('.log-msg').textContent = entry.msg + (entry.detail ? ` — ${entry.detail}` : '');
    elements.logPanel.prepend(div);
    while (elements.logPanel.children.length > 200) elements.logPanel.lastChild.remove();
}
function rerenderLog() { if (!elements.logPanel) return; elements.logPanel.innerHTML = ''; [...logStore].reverse().slice(0, 200).forEach(renderLogEntry); }
function download(name, content, type = 'application/json') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click();
}

/* ---------- Modal ---------- */
function showModal() {
    // Não sobrescrever campos se o modal já está aberto (poll 401 apagava o que o usuário digitava)
    const alreadyOpen = elements.configModal?.classList.contains('show');
    if (!alreadyOpen) {
        if (elements.apiKey) elements.apiKey.value = config.apiKey;
        if (elements.teamApiKey) elements.teamApiKey.value = config.teamApiKey || '';
        if (elements.userEmail) elements.userEmail.value = config.email;
        if (elements.orgSlug) elements.orgSlug.value = config.orgSlug || 'telekom';
        if (elements.projectSlug) elements.projectSlug.value = config.projectSlug || 'nrf-project';
        if (elements.deviceIdInput) elements.deviceIdInput.value = config.deviceId;
    }
    elements.configModal?.classList.add('show');
}
function hideModal() { elements.configModal?.classList.remove('show'); }
function saveConfig() {
    config.apiKey = (elements.apiKey?.value.trim() || '').replace(/^(Bearer|Basic)\s+/i, '');
    config.teamApiKey = (elements.teamApiKey?.value.trim() || '').replace(/^(Bearer|Basic)\s+/i, '');
    config.email = elements.userEmail?.value.trim() || '';
    config.orgSlug = elements.orgSlug?.value.trim() || 'telekom';
    config.projectSlug = elements.projectSlug?.value.trim() || 'nrf-project';
    config.deviceId = elements.deviceIdInput?.value.trim() || '';
    localStorage.setItem('nrf_api_key', config.apiKey);
    localStorage.setItem('nrf_team_api_key', config.teamApiKey || '');
    localStorage.setItem('nrf_user_email', config.email);
    localStorage.setItem('nrf_org_slug', config.orgSlug);
    localStorage.setItem('nrf_project_slug', config.projectSlug);
    localStorage.setItem('nrf_device_id', config.deviceId);
    log('info', 'Configuração salva', `${config.orgSlug}/${config.projectSlug} · ${config.deviceId || 'auto'}`);
    hideModal(); init();
}

/* ---------- Status ---------- */
function timeAgo(ts) {
    if (!ts) return '—';
    const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 0) return 'agora'; if (s < 60) return `há ${s}s`;
    if (s < 3600) return `há ${Math.floor(s / 60)}min`;
    if (s < 86400) return `há ${Math.floor(s / 3600)}h`;
    return `há ${Math.floor(s / 86400)}d`;
}
function setStatus(connected, label) {
    const el = elements.connectionStatus; if (!el) return;
    el.classList.remove('connected', 'error', 'stale');
    el.classList.add(connected === true ? 'connected' : connected === false ? 'error' : 'stale');
    setText(elements.connLabel, label);
}
function updateConnPanel({ connected, lastSeen, lastMsg, msgCount, latency }) {
    setText(elements.connState, connected === true ? '● ONLINE' : connected === false ? '○ OFFLINE' : '… ?');
    if (elements.connState) elements.connState.style.color = connected === true ? '#00b894' : connected === false ? '#d63031' : '#636e72';
    setText(elements.connLastSeen, lastSeen ? `${new Date(lastSeen).toLocaleString('pt-BR')} (${timeAgo(lastSeen)})` : '—');
    setText(elements.connLastMsg, lastMsg ? `${new Date(lastMsg).toLocaleString('pt-BR')} (${timeAgo(lastMsg)})` : '—');
    setText(elements.connMsgCount, msgCount ?? '—');
    setText(elements.connLatency, latency != null ? `${latency} ms` : '—');
}

/* ---------- API ---------- */
function buildAuthHeader() {
    const key = config.apiKey || '';
    if (!key) return null;
    // User API Key + e-mail → Basic; sem e-mail → Bearer (Organization Auth Token)
    if (config.email) {
        return 'Basic ' + btoa(unescape(encodeURIComponent(`${config.email}:${key}`)));
    }
    return `Bearer ${key}`;
}
async function nrfFetch(path, options = {}) {
    const t0 = Date.now();
    const auth = buildAuthHeader();
    if (!auth) throw new Error('Sem API key — abra a engrenagem');
    const headers = {
        'Authorization': auth,
        'Content-Type': 'application/json',
        'X-Memfault-Org': config.orgSlug || 'telekom',
        'X-Memfault-Project': config.projectSlug || 'nrf-project',
        ...options.headers,
    };
    if (config.email) headers['X-User-Email'] = config.email;
    if (config.teamApiKey) headers['X-Nrf-Team-Key'] = config.teamApiKey;
    Object.keys(headers).forEach(k => headers[k] === undefined && delete headers[k]);
    log('api', `→ ${options.method || 'GET'} ${path}`);
    const res = await fetch(`${NRF_CLOUD_BASE}${path}`, { ...options, headers });
    const latency = Date.now() - t0;
    if (!res.ok) {
        const eb = await res.json().catch(() => ({}));
        const msg = eb.message || eb.error || eb.detail || eb.feature || `HTTP ${res.status}`;
        log('err', `✕ ${path} [${res.status}] ${msg}`, `${latency}ms`);
        throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    const data = await res.json(); logCount.api++;
    return { data, latency };
}
async function getDevices() { const { data } = await nrfFetch('/devices?pageLimit=100'); return data.items || []; }
async function getDevice(id) { const { data, latency } = await nrfFetch(`/devices/${encodeURIComponent(id)}`); return { device: data, latency }; }
async function getMessages(id, limit = 50) {
    const q = new URLSearchParams({ deviceId: id, pageLimit: String(limit), pageSort: 'desc' }).toString();
    const { data } = await nrfFetch(`/messages?${q}`);
    if (data?.serial) lastSerial = data.serial;
    if (Array.isArray(data)) return data;
    return data?.items || data?.data || [];
}
async function fetchSerialTelemetry() {
    try {
        const base = NRF_CLOUD_BASE.replace(/\/api$/, '');
        const headers = { cache: undefined };
        const h = { 'Cache-Control': 'no-store' };
        const auth = buildAuthHeader();
        if (auth) {
            h['Authorization'] = auth;
            h['X-Memfault-Org'] = config.orgSlug || 'telekom';
            h['X-Memfault-Project'] = config.projectSlug || 'nrf-project';
            if (config.email) h['X-User-Email'] = config.email;
            if (config.teamApiKey) h['X-Nrf-Team-Key'] = config.teamApiKey;
        }
        const res = await fetch(`${base}/api/serial/telemetry`, { cache: 'no-store', headers: h });
        if (!res.ok) return null;
        const data = await res.json();
        lastSerial = data;
        return data;
    } catch {
        return null;
    }
}
function applySerialOverlay(fromMsg, parsed, serial) {
    if (!serial || !serial.ok) return { fromMsg, parsed, used: false };
    const fm = { ...fromMsg, gps: { ...(fromMsg.gps || {}) } };
    let used = false;
    let p = { ...parsed };
    if (fm.temp == null && serial.temperatureC != null) { fm.temp = Number(serial.temperatureC); telemetrySource.env = 'serial'; used = true; }
    else if (fm.temp != null) telemetrySource.env = telemetrySource.env || 'cloud';
    if (fm.hum == null && serial.humidityPct != null) { fm.hum = Number(serial.humidityPct); telemetrySource.env = 'serial'; used = true; }
    if (fm.press == null && serial.pressure != null) { fm.press = normalizePressHpa(serial.pressure); telemetrySource.env = 'serial'; used = true; }
    if (fm.batteryV == null && serial.batteryMv != null) { fm.batteryV = serial.batteryMv / 1000; telemetrySource.battery = 'serial'; used = true; }
    else if (fm.batteryV != null || p.batteryV != null) telemetrySource.battery = telemetrySource.battery || 'cloud';
    if (fm.rsrp == null && serial.rsrp != null) { fm.rsrp = Number(serial.rsrp); telemetrySource.net = 'serial'; used = true; }
    if (fm.rsrq == null && serial.rsrq != null) { fm.rsrq = Number(serial.rsrq); telemetrySource.net = 'serial'; used = true; }
    if (fm.snr == null && serial.snr != null) { fm.snr = Number(serial.snr); telemetrySource.net = 'serial'; used = true; }
    const take = (key, val) => {
        if (val == null || val === '') return;
        if (p[key] == null || p[key] === '' || p[key] === '—') { p[key] = val; telemetrySource.net = 'serial'; used = true; }
    };
    take('mccMnc', serial.mccMnc);
    take('mcc', serial.mcc);
    take('mnc', serial.mnc);
    take('operator', serial.operator || (serial.mccMnc ? plmnHint(serial.mccMnc) : null));
    take('band', serial.band);
    take('supportedBands', serial.supportedBands);
    take('networkMode', serial.networkMode || serial.accessTech);
    take('accessTech', serial.accessTech);
    take('ueMode', serial.ueMode);
    take('ipAddress', serial.ipAddress);
    take('snr', serial.snr);
    take('tac', serial.tac);
    take('tacDec', serial.tacDec);
    take('eci', serial.eci);
    take('eciDec', serial.eciDec);
    take('cellId', serial.cellId || serial.eciDec || serial.eci);
    take('wifiApCount', serial.wifiApCount);
    take('wifiStatus', serial.wifiStatus);
    if (serial.operator || serial.mccMnc || serial.band != null || serial.rsrp != null || serial.ipAddress)
        telemetrySource.net = telemetrySource.net || 'serial';
    else if (p.operator || p.mccMnc) telemetrySource.net = telemetrySource.net || 'cloud';
    // Ensure VIVO hint when PLMN known
    if (p.mccMnc && (!p.operator || String(p.operator) === String(p.mccMnc) || /^\d+$/.test(String(p.operator)))) {
        const h = plmnHint(p.mccMnc);
        if (h) p.operator = h;
    }
    if ((fm.gps?.lat == null || fm.gps?.lon == null) && serial.lat != null && serial.lon != null) {
        fm.gps = { lat: Number(serial.lat), lon: Number(serial.lon), accuracy: serial.locationAccuracy != null ? Number(serial.locationAccuracy) : undefined };
        telemetrySource.gps = 'serial'; used = true;
    } else if (fm.gps?.lat != null) telemetrySource.gps = telemetrySource.gps || 'cloud';
    return { fromMsg: fm, parsed: p, used };
}
function updateSourceBadge() {
    const el = elements.dataSourceBadge;
    if (!el) return;
    const parts = [];
    const s = telemetrySource;
    if (s.battery === 'serial' || s.env === 'serial' || s.net === 'serial' || s.gps === 'serial') parts.push('serial');
    if (s.battery === 'cloud' || s.env === 'cloud' || s.net === 'cloud' || s.gps === 'cloud') parts.push('cloud');
    if (!parts.length && serialIsHealthy(lastSerial)) parts.push('serial');
    if (!parts.length) {
        el.textContent = '—';
        el.className = 'chip chip-source';
        return;
    }
    el.textContent = parts.join('+');
    el.className = 'chip chip-source' + (parts.includes('serial') ? ' chip-serial' : ' chip-cloud');
    el.title = lastSerial?.updatedAt ? `serial @ ${lastSerial.updatedAt}` : '';
}
async function getLocationHistory(id, hours = 24) {
    const end = new Date().toISOString(), start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    let all = [], token = null, pages = 0;
    do {
        const p = { deviceId: id, start, end, pageLimit: '100', pageSort: 'asc' };
        if (token) p.pageNextToken = token;
        const { data } = await nrfFetch(`/location/history?${new URLSearchParams(p).toString()}`);
        const items = Array.isArray(data) ? data : (data?.items || data?.data || []);
        all = all.concat(items); token = data?.pageNextToken; pages++;
    } while (token && pages < 10);
    return all;
}
/** Flat UI fields → ATT-friendly desired.config (proxy also normalizes). */
function buildDesiredPayload(flat) {
    const desired = { ...flat };
    const config = { ...(desired.config && typeof desired.config === 'object' ? desired.config : {}) };
    if (desired.gpsInterval != null && config.sample_interval == null) {
        const n = Number(desired.gpsInterval);
        if (Number.isFinite(n) && n > 0) config.sample_interval = Math.round(n);
        delete desired.gpsInterval;
    }
    if (desired.led != null && config.led == null) config.led = desired.led;
    if (desired.buzzer != null && config.buzzer == null) config.buzzer = desired.buzzer;
    if (Object.keys(config).length) desired.config = config;
    return desired;
}
async function patchDesired(id, desired) {
    const payload = buildDesiredPayload(desired);
    return nrfFetch(`/devices/${encodeURIComponent(id)}/state`, { method: 'PATCH', body: JSON.stringify({ desired: payload }) });
}
async function sendC2D(id, message) {
    const msg = typeof message === 'string' ? JSON.parse(message) : message;
    return nrfFetch(`/devices/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify(msg) });
}
async function listFirmware() {
    for (const p of ['/firmware?pageLimit=50', '/fota?pageLimit=50']) {
        try { const { data } = await nrfFetch(p); return data.items || data.bundles || []; } catch { /* tenta próximo */ }
    }
    return [];
}
async function listFotaJobs(id) {
    const q = new URLSearchParams({ deviceId: id, pageLimit: '20', pageSort: 'desc' }).toString();
    for (const p of [`/fota-jobs?${q}`, `/fota/jobs?${q}`]) {
        try { const { data } = await nrfFetch(p); return data.items || data.jobs || []; } catch { /* próximo */ }
    }
    return [];
}


/* ---------- Network helpers ---------- */
const PLMN_HINTS = { '72410': 'VIVO', '72406': 'VIVO', '72423': 'VIVO', '72411': 'VIVO', '72405': 'Claro', '72402': 'TIM', '72403': 'TIM', '72404': 'TIM' };
function plmnHint(mccMnc) {
    const k = String(mccMnc || '').trim();
    return PLMN_HINTS[k] || null;
}
function formatOperator(op, mccMnc) {
    const plmn = mccMnc != null ? String(mccMnc).trim() : '';
    const hint = plmnHint(plmn);
    let name = (op != null && op !== '' && op !== '—') ? String(op).trim() : '';
    if (!name || name === plmn || /^\d{5,6}$/.test(name)) name = hint || name;
    if (!name && hint) name = hint;
    if (name && plmn && name !== plmn) return `${name} · ${plmn}`;
    if (name) return name;
    if (plmn) return hint ? `${hint} · ${plmn}` : plmn;
    return '—';
}
function formatBands(bands) {
    if (bands == null || bands === '') return null;
    if (Array.isArray(bands)) return bands.length ? bands.join(', ') : null;
    if (typeof bands === 'string') {
        const s = bands.trim();
        if (!s) return null;
        return s.replace(/^\(|\)$/g, '');
    }
    return String(bands);
}
function formatTac(tac, tacDec) {
    if (tacDec != null && Number.isFinite(Number(tacDec))) {
        const d = Number(tacDec);
        const h = tac != null ? String(tac).toUpperCase() : d.toString(16).toUpperCase();
        return `${d} (0x${h})`;
    }
    if (tac != null && tac !== '') {
        const h = String(tac);
        try { return `${parseInt(h, 16)} (0x${h.toUpperCase()})`; } catch { return h; }
    }
    return null;
}
function formatCellId(eci, eciDec, cellId) {
    const dec = eciDec != null ? Number(eciDec) : (cellId != null && String(cellId).match(/^\d+$/) ? Number(cellId) : null);
    const hex = eci != null ? String(eci) : (cellId != null && /[A-Fa-f]/.test(String(cellId)) ? String(cellId) : null);
    if (dec != null && Number.isFinite(dec)) {
        const h = hex ? hex.toUpperCase() : dec.toString(16).toUpperCase();
        return `${dec} (0x${h})`;
    }
    if (hex) {
        try { return `${parseInt(hex, 16)} (0x${hex.toUpperCase()})`; } catch { return hex; }
    }
    if (cellId != null) return String(cellId);
    return null;
}

/* ---------- Parsing ---------- */
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
/** BME680 UART often reports kPa (~92) mislabeled as Pa; display as hPa (~920). */
function normalizePressHpa(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    if (n >= 50 && n <= 120) return n * 10;       // kPa → hPa
    if (n >= 50000 && n <= 120000) return n / 100; // Pa → hPa
    return n; // already hPa (~850–1100) or other
}
function serialIsHealthy(serial) {
    if (!serial || !serial.ok) return false;
    return serial.batteryMv != null || serial.temperatureC != null || serial.operator != null
        || serial.mccMnc != null || serial.humidityPct != null || serial.rsrp != null
        || serial.ipAddress != null || serial.band != null;
}

function extractFromMessages(items) {
    const list = Array.isArray(items) ? items : [];
    const byApp = {};
    for (const it of list) { const a = it.message?.appId || it.appId || it.app_id || 'UNKNOWN'; if (!byApp[a]) byApp[a] = it; }
    const out = {};
    const pick = (o, ...ks) => { if (o == null) return undefined; if (typeof o === 'number') return o; if (typeof o !== 'object') return undefined; for (const k of ks) if (o[k] !== undefined) return o[k]; return undefined; };
    for (const [a, it] of Object.entries(byApp)) { const m = it.message ?? it.data ?? {}; out[a] = { raw: m, data: m.data ?? m, receivedAt: it.receivedAt || it.received_at || it.ts }; }
    const g = out.GNSS?.data ?? out.GPS?.data, t = out.TEMP?.data, h = out.HUMID?.data ?? out.HUMIDITY?.data,
        p = out.AIR_PRESS?.data ?? out.PRESSURE?.data, r = out.RSRP?.data,
        dev = out.DEVICE?.data, bat = out.BATTERY?.data ?? out.BAT?.data,
        env = out.ENV?.data ?? out.ENVIRONMENT?.data;
    const latestAt = list[0]?.receivedAt || list[0]?.received_at || list[0]?.ts;
    return {
        byApp, latestAt,
        gps: g ? { lat: num(pick(g, 'lat', 'latitude', 'v')), lon: num(pick(g, 'lng', 'lon', 'longitude', 'v')), accuracy: num(pick(g, 'acc', 'accuracy', 'uncertainty')), speed: num(pick(g, 'spd', 'speed')), altitude: num(pick(g, 'alt', 'altitude')), satellites: num(pick(g, 'sats', 'satellites', 'numSat')) } : {},
        temp: num(typeof t === 'number' ? t : pick(t ?? env ?? {}, 'value', 'temp', 'temperature', 'v')),
        hum: num(typeof h === 'number' ? h : pick(h ?? env ?? {}, 'value', 'humidity', 'hum', 'v')),
        press: num(typeof p === 'number' ? p : pick(p ?? env ?? {}, 'value', 'pressure', 'press', 'v')),
        rsrp: r != null ? (typeof r === 'number' ? r : pick(r, 'value', 'rsrp', 'v')) : num(pick(dev ?? {}, 'rsrp')),
        rsrq: pick(dev ?? {}, 'rsrq') ?? pick(out.RSRQ?.data ?? {}, 'value', 'v'),
        batteryV: num(pick(dev ?? bat ?? {}, 'batteryVoltage', 'batV', 'bat', 'v', 'value', 'voltage')),
        accel: out.ACCEL?.data ?? out.MOTION?.data,
        steps: num(pick(out.STEPS?.data ?? out.ACCEL?.data ?? {}, 'steps', 'stepCount', 'value')),
    };
}
function parseDevice(d) {
    const rep = d.state?.reported ?? {}, di = rep.device?.deviceInfo ?? {}, ni = rep.device?.networkInfo ?? {}, fw = d.firmware ?? {};
    const bat = rep.device?.batteryStatus ?? rep.battery ?? rep.bat ?? {};
    const id = d.id || d.device_serial || d._memfault?.device_serial;
    const lastSeen = d.$meta?.updatedAt || d.last_seen || d._memfault?.last_seen || d._nrf?.$meta?.updatedAt;
    const firmware = fw.app?.version || di.appVersion || di.modemFirmware || d.last_seen_release?.version || d._memfault?.last_seen_release?.version || '—';
    const batteryV = num(bat.voltage || bat.batteryVoltage || bat.v || di.batteryVoltage);
    const mccMnc = ni.mccmnc || ni.mccMnc || ni.MCCMNC || null;
    let operator = ni.networkOperator || ni.operator || null;
    if ((!operator || String(operator) === String(mccMnc) || /^\d{5,6}$/.test(String(operator || ''))) && mccMnc) {
        operator = plmnHint(mccMnc) || operator || mccMnc;
    }
    const tacRaw = ni.areaCode ?? ni.tac ?? ni.TAC;
    const cellRaw = ni.cellID ?? ni.cellId ?? ni.eci ?? ni.ECI;
    let tacDec = num(tacRaw);
    let tacHex = null;
    if (tacRaw != null && typeof tacRaw === 'string' && /[A-Fa-f]/.test(tacRaw)) {
        tacHex = tacRaw;
        try { tacDec = parseInt(tacRaw, 16); } catch { /* keep */ }
    } else if (tacDec != null) {
        tacHex = Number(tacDec).toString(16).toUpperCase();
    }
    let eciDec = num(cellRaw);
    let eciHex = null;
    if (cellRaw != null && typeof cellRaw === 'string' && /[A-Fa-f]/.test(cellRaw)) {
        eciHex = cellRaw;
        try { eciDec = parseInt(cellRaw, 16); } catch { /* keep */ }
    } else if (eciDec != null) {
        eciHex = Number(eciDec).toString(16).toUpperCase();
    }
    return {
        name: d.name || d.nickname || id,
        id,
        connected: rep.connected,
        session: rep.sessionIdentifier,
        firmware,
        lastSeen,
        operator,
        mccMnc,
        mcc: mccMnc ? num(String(mccMnc).slice(0, 3)) : undefined,
        mnc: mccMnc ? num(String(mccMnc).slice(3)) : undefined,
        networkMode: ni.networkMode || ni.accessTech,
        band: ni.currentBand ?? ni.band,
        supportedBands: ni.supportedBands || ni.supportedBand || null,
        ueMode: ni.ueMode ?? ni.UEMode ?? null,
        ipAddress: ni.ipAddress || ni.ip || ni.IPV4 || null,
        tac: tacHex,
        tacDec,
        eci: eciHex,
        eciDec,
        cellId: eciDec ?? cellRaw,
        rsrp: num(ni.rsrp),
        rsrq: num(ni.rsrq),
        snr: num(ni.snr ?? ni.SINR),
        wifiApCount: num(ni.wifiApCount ?? ni.wifiAps),
        wifiStatus: ni.wifiStatus || null,
        batteryV,
        hardware: d.hardware_version || d._memfault?.hardware_version,
        netSourceHint: 'cloud',
    };
}

/* ---------- UI ---------- */
function updateUI(parsed, fromMsg) {
    setText(elements.deviceId, parsed.id || config.deviceId || '-');
    setText(elements.deviceName, parsed.name || 'Thingy:91X');
    setText(elements.firmwareVersion, parsed.firmware || '-');
    const ls = parsed.lastSeen || fromMsg.latestAt;
    setText(elements.lastSeen, ls ? new Date(ls).toLocaleString('pt-BR') : '-'); lastSeenTs = ls || lastSeenTs;
    const gps = { ...fromMsg.gps };
    if (gps.lat != null && gps.lon != null) {
        setText(elements.gpsCoords, `${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}`);
        setText(elements.gpsLat, gps.lat.toFixed(6)); setText(elements.gpsLon, gps.lon.toFixed(6));
        setText(elements.gpsAcc, gps.accuracy != null ? `${Math.round(gps.accuracy)} m` : '—');
        setText(elements.gpsAlt, gps.altitude != null ? `${Math.round(gps.altitude)} m` : '—');
        setText(elements.gpsSpeed, gps.speed != null ? `${Number(gps.speed).toFixed(1)} m/s` : '—');
        updateMap(gps.lat, gps.lon, gps.accuracy); checkGeofence(gps.lat, gps.lon);
    }
    if (fromMsg.temp != null) setText(elements.tempValue, fromMsg.temp.toFixed(1));
    if (fromMsg.hum != null) setText(elements.humValue, fromMsg.hum.toFixed(1));
    if (fromMsg.press != null) {
        const ph = normalizePressHpa(fromMsg.press);
        setText(elements.pressValue, ph != null ? ph.toFixed(1) : fromMsg.press.toFixed(1));
    }
    const batteryV = fromMsg.batteryV ?? parsed.batteryV;
    if (batteryV != null) {
        const v = batteryV > 1000 ? batteryV / 1000 : batteryV;
        setText(elements.batteryVoltage, `${v.toFixed(2)} V`);
        const pct = Math.max(0, Math.min(100, Math.round((v - 3.2) / 1.0 * 100)));
        if (elements.batteryFill) { elements.batteryFill.style.width = `${pct}%`; elements.batteryFill.className = 'battery-fill' + (pct < 20 ? ' critical' : pct < 40 ? ' low' : ''); }
        setText(elements.batteryValue, `${pct}%`);
    }
    const rsrp = fromMsg.rsrp ?? parsed.rsrp;
    const rsrq = fromMsg.rsrq ?? parsed.rsrq;
    if (rsrp != null) setText(elements.rsrp, `${rsrp} dBm`);
    else setText(elements.rsrp, '—');
    if (rsrq != null) setText(elements.rsrq, `${Number(rsrq)} dB`);
    else setText(elements.rsrq, '—');
    if (fromMsg.gps?.satellites != null) setText(elements.gpsSats, String(fromMsg.gps.satellites));
    if (fromMsg.steps != null) setText(elements.steps, String(fromMsg.steps));
    if (fromMsg.accel && typeof fromMsg.accel === 'object') {
        const ax = num(fromMsg.accel.x ?? fromMsg.accel.ax); const ay = num(fromMsg.accel.y ?? fromMsg.accel.ay); const az = num(fromMsg.accel.z ?? fromMsg.accel.az);
        if (ax != null) setText(elements.accelX, ax.toFixed(2));
        if (ay != null) setText(elements.accelY, ay.toFixed(2));
        if (az != null) setText(elements.accelZ, az.toFixed(2));
    }
    // Rede card — serial overlay + cloud networkInfo
    const mccMnc = parsed.mccMnc || null;
    setText(elements.operator, formatOperator(parsed.operator, mccMnc));
    setText(elements.netMccMnc, mccMnc ? String(mccMnc) : '—');
    setText(elements.netMode, parsed.networkMode || parsed.accessTech || '—');
    setText(elements.netBand, parsed.band != null && parsed.band !== '' ? `B${parsed.band}` : '—');
    setText(elements.netSupportedBands, formatBands(parsed.supportedBands) || '—');
    setText(elements.netTac, formatTac(parsed.tac, parsed.tacDec) || '—');
    setText(elements.netCellId, formatCellId(parsed.eci, parsed.eciDec, parsed.cellId) || '—');
    setText(elements.netUeMode, parsed.ueMode != null && parsed.ueMode !== '' ? String(parsed.ueMode) : '—');
    setText(elements.netIp, parsed.ipAddress || '—');
    const snr = fromMsg.snr ?? parsed.snr;
    setText(elements.netSnr, snr != null ? `${snr} dB` : '—');
    const wifiTxt = parsed.wifiStatus
        || (parsed.wifiApCount != null ? `${parsed.wifiApCount} APs` : null);
    setText(elements.netWifi, wifiTxt || '—');
    const src = telemetrySource.net || (lastSerial?.ok ? 'serial' : null) || parsed.netSourceHint || null;
    setText(elements.netSource, src || '—');
}
function renderMsgTable(items) {
    if (!elements.msgTable) return;
    if (!items.length) { elements.msgTable.textContent = '—'; return; }
    elements.msgTable.innerHTML = items.slice(0, 12).map(it => {
        const a = it.message?.appId || '?', t = new Date(it.receivedAt).toLocaleString('pt-BR');
        const s = JSON.stringify(it.message?.data ?? it.message ?? {}).slice(0, 120);
        return `<div class="msg-row"><span class="msg-app">${a}</span><span class="msg-ts">${t}</span><span class="msg-data"></span></div>`;
    }).join('');
    [...elements.msgTable.querySelectorAll('.msg-row')].forEach((row, i) => {
        row.querySelector('.msg-data').textContent = JSON.stringify(items[i].message?.data ?? items[i].message ?? {}).slice(0, 120);
    });
}

/* ---------- Fleet ---------- */
function renderDeviceSelect() {
    if (!elements.deviceSelect) return;
    elements.deviceSelect.innerHTML = deviceList.map(d => `<option value="${d.id}">${d.name || d.id}</option>`).join('');
    if (config.deviceId) elements.deviceSelect.value = config.deviceId;
    setText(elements.fleetCount, `${deviceList.length} devices`);
}
function renderFleetGrid(fleetData) {
    if (!elements.fleetGrid) return;
    elements.fleetGrid.innerHTML = fleetData.map(f =>
        `<button class="fleet-card${f.id === config.deviceId ? ' active' : ''}" data-id="${f.id}">
      <span class="fleet-dot" style="background:${f.connected ? '#00b894' : '#d63031'}"></span>
      <span class="fleet-name">${f.name || f.id}</span>
      <span class="fleet-meta">${f.connected ? 'ONLINE' : 'OFFLINE'} · ${timeAgo(f.lastSeen)}</span>
    </button>`).join('') || '—';
    elements.fleetGrid.querySelectorAll('.fleet-card').forEach(b => b.addEventListener('click', () => switchDevice(b.dataset.id)));
}
async function loadFleet(light = false) {
    try {
        deviceList = await getDevices();
        renderDeviceSelect();
        log('ok', `Frota: ${deviceList.length} dispositivos`);
        if (!config.deviceId && deviceList.length) { config.deviceId = deviceList[0].id; localStorage.setItem('nrf_device_id', config.deviceId); renderDeviceSelect(); }
        if (light) return;
        const slice = deviceList.slice(0, 12);
        const res = await Promise.allSettled(slice.map(async d => { const { device } = await getDevice(d.id); const p = parseDevice(device); return p; }));
        const fleet = res.filter(r => r.status === 'fulfilled').map(r => r.value);
        renderFleetGrid(fleet); drawFleetMarkers(fleet);
    } catch (e) { log('warn', `Frota falhou: ${e.message}`); }
}
function switchDevice(id) {
    config.deviceId = id; localStorage.setItem('nrf_device_id', id);
    if (elements.deviceSelect) elements.deviceSelect.value = id;
    lastConnected = null; log('info', `Trocado para ${id}`); fetchAndUpdate(); loadTrail();
}

/* ---------- Map ---------- */
function initMap() {
    if (map) return;
    map = L.map('map').setView([-23.5505, -46.6333], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(map);
    marker = L.marker([0, 0]).addTo(map); marker.setOpacity(0);
    trailLine = L.polyline([], { color: '#0984e3', weight: 3, opacity: 0.7 }).addTo(map);
    restoreGeofence(); log('info', 'Mapa pronto');
}
function updateMap(lat, lon, acc) {
    if (!map || !marker) return;
    marker.setLatLng([lat, lon]); marker.setOpacity(1);
    if (acc != null && Number.isFinite(Number(acc))) {
        if (accuracyCircle) map.removeLayer(accuracyCircle);
        accuracyCircle = L.circle([lat, lon], { radius: Number(acc), color: '#0984e3', fillOpacity: 0.1, weight: 1 }).addTo(map);
    }
    if (trailEnabled && trailLine) trailLine.addLatLng([lat, lon]);
    if (map.getZoom() < 12) map.setView([lat, lon], 15);
}
function drawFleetMarkers(fleet) {
    fleetMarkers.forEach(m => map.removeLayer(m)); fleetMarkers = [];
    // Mantém simples: só loga; markers detalhados exigiriam lat por device (custoso). Mostra atual.
    log('info', `Frota online: ${fleet.filter(f => f.connected).length}/${fleet.length}`);
}

/* ---------- Geofence ---------- */
function haversine(a, b, c, d) {
    const R = 6371000, t = x => x * Math.PI / 180;
    const h = Math.sin(t(c - a) / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(t(d - b) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}
function restoreGeofence() {
    if (!map || !geo) return;
    if (geoCircle) map.removeLayer(geoCircle);
    geoCircle = L.circle([geo.lat, geo.lon], { radius: geo.radius, color: '#E20074', weight: 2, fillOpacity: 0.08 }).addTo(map);
    setText(elements.geoState, `Centro ${geo.lat.toFixed(5)},${geo.lon.toFixed(5)} · ${geo.radius}m`);
}
function checkGeofence(lat, lon) {
    if (!geo) return;
    const dist = haversine(geo.lat, geo.lon, lat, lon);
    const inside = dist <= geo.radius;
    setText(elements.geoState, `${inside ? 'DENTRO' : 'FORA'} · ${Math.round(dist)}m do centro`);
    if (elements.geoState) elements.geoState.style.color = inside ? '#00b894' : '#d63031';
    if (geoInside !== null && geoInside !== inside) {
        const msg = inside ? 'Entrou no geofence' : 'SAIU do geofence!';
        log(inside ? 'ok' : 'warn', msg, `${Math.round(dist)}m`);
        try { if (Notification.permission === 'granted') new Notification(msg, { body: `${Math.round(dist)}m do centro` }); } catch { }
    }
    geoInside = inside;
}

/* ---------- Poll ---------- */
async function fetchAndUpdate() {
    // Pausar poll enquanto o modal de config está aberto
    if (elements.configModal?.classList.contains('show')) return;
    if (!config.apiKey) { showModal(); return; }
    try {
        if (!config.deviceId || !deviceList.length) await loadFleet(true);
        if (!config.deviceId) throw new Error('Sem dispositivos na conta');
        const [{ device, latency }, messages, serial] = await Promise.all([
            getDevice(config.deviceId),
            getMessages(config.deviceId, 50).catch(e => {
                log('warn', 'Msgs falharam — tentando overlay serial', e.message);
                return [];
            }),
            fetchSerialTelemetry(),
        ]);
        lastDeviceRaw = device; lastMessages = messages;
        let parsed = parseDevice(device), fromMsg = extractFromMessages(messages);
        const overlay = applySerialOverlay(fromMsg, parsed, serial || lastSerial);
        fromMsg = overlay.fromMsg; parsed = overlay.parsed;
        const ser = serial || lastSerial;
        const healthy = serialIsHealthy(ser);
        const hasGps = fromMsg.gps?.lat != null && fromMsg.gps?.lon != null;
        // Posição headline: calm/actionable; avoid scary Simple Token nag when serial healthy
        if (!hasGps) {
            const src = ser?.locationSource || '';
            if (healthy && (src === 'cloud_pending' || /loc_cloud|pending/i.test(ser?.rawNotes || ''))) {
                setText(elements.gpsCoords, 'Sem fix — pedido Wi‑Fi/célula na nuvem (ainda sem coordenadas).');
            } else if (healthy) {
                setText(elements.gpsCoords, 'Sem fix — Wi‑Fi/GNSS ainda sem coordenadas. Próximo: céu aberto ou Simple Token.');
            } else if (!config.teamApiKey) {
                setText(elements.gpsCoords, 'Sem msgs (401): cole API Key da equipe (Simple Token)');
            } else {
                setText(elements.gpsCoords, 'Aguardando GPS…');
            }
        }
        if (lastConnected !== null && lastConnected !== parsed.connected)
            log(parsed.connected ? 'ok' : 'warn', parsed.connected ? 'CONECTOU' : 'DESCONECTOU', parsed.session || '');
        lastConnected = parsed.connected;
        const on = parsed.connected === true;
        setStatus(on, on ? 'Conectado' : parsed.connected === false ? 'Offline' : 'Desconhecido');
        updateConnPanel({ connected: parsed.connected, lastSeen: parsed.lastSeen, lastMsg: fromMsg.latestAt || serial?.updatedAt, msgCount: messages.length, latency });
        updateUI(parsed, fromMsg); renderMsgTable(messages); updateSourceBadge();
        const apps = Object.keys(fromMsg.byApp || {});
        const st = lastTrail.length ? [...new Set(lastTrail.map(t => t.serviceType).filter(Boolean))].join(',') : '';
        if (st) setText(elements.serviceType, st);
        const src = overlay.used ? ' +serial' : '';
        log('info', `Poll OK · ${messages.length} msgs [${apps.join(',') || '-'}]${src} · ${timeAgo(fromMsg.latestAt || parsed.lastSeen)}`, `fw ${parsed.firmware} · ${latency}ms`);
        if (parsed.connected === false) log('warn', 'connected=false — sem MQTT. Cheque LTE/SIM/bateria.');
    } catch (e) {
        log('err', `Poll: ${e.message}`); setStatus(false, `Erro: ${e.message.slice(0, 60)}`);
        if (/401|403/.test(e.message)) showModal();
    }
}
async function loadTrail() {
    if (!config.deviceId || !trailEnabled) return;
    try {
        const hours = Number(elements.trailRange?.value || 24);
        log('info', `Trilha ${hours}h…`);
        const items = await getLocationHistory(config.deviceId, hours);
        lastTrail = items;
        const pts = items.filter(l => l.lat && l.lon).map(l => [Number(l.lat), Number(l.lon)]);
        if (pts.length && trailLine) {
            trailLine.setLatLngs(pts);
            const sts = [...new Set(items.map(i => i.serviceType).filter(Boolean))];
            setText(elements.serviceType, sts.join(', ') || 'GNSS');
            log('ok', `Trilha: ${pts.length} pts [${sts.join(',') || '?'}]`);
            const last = items[items.length - 1];
            if (last) updateMap(Number(last.lat), Number(last.lon), last.meta?.acc);
        } else log('warn', 'Trilha vazia no período');
    } catch (e) { log('warn', `Trilha: ${e.message}`); }
}
function init() {
    if (!config.apiKey) { showModal(); log('warn', 'Sem User API Key / OAT'); return; }
    if (!config.email) log('info', 'Sem e-mail — usando Bearer (OAT) no Memfault.');
    if (!config.teamApiKey) log('warn', 'Sem API Key da equipe — GPS/sensores (ListMessages) vão dar 401.');
    initMap(); fetchAndUpdate(); loadTrail();
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(fetchAndUpdate, POLL_MS);
    setText(elements.connPoll, `${POLL_MS / 1000}s`);
    try { if (Notification.permission === 'default') Notification.requestPermission(); } catch { }
}

/* ---------- wiring ---------- */
elements.saveConfig?.addEventListener('click', saveConfig);
elements.cancelConfig?.addEventListener('click', hideModal);
elements.closeModal?.addEventListener('click', hideModal);
elements.configBtn?.addEventListener('click', showModal);
elements.centerMap?.addEventListener('click', () => { try { map.setView(marker.getLatLng(), 15); } catch { log('warn', 'Sem posição ainda'); } });
elements.toggleTrail?.addEventListener('click', () => {
    trailEnabled = !trailEnabled; setText(elements.trailStatus, trailEnabled ? 'ON' : 'OFF');
    log('info', `Trilha ${trailEnabled ? 'ON' : 'OFF'}`); if (!trailEnabled) trailLine?.setLatLngs([]); else loadTrail();
});
elements.trailRange?.addEventListener('change', loadTrail);
elements.clearLog?.addEventListener('click', () => { logStore.length = 0; elements.logPanel.innerHTML = ''; });
elements.logFilter?.addEventListener('change', rerenderLog);
elements.exportLog?.addEventListener('click', () => { download(`thingy91x-log-${Date.now()}.json`, JSON.stringify(logStore, null, 2)); log('info', 'Log exportado'); });
elements.deviceSelect?.addEventListener('change', e => switchDevice(e.target.value));
elements.refreshFleet?.addEventListener('click', () => loadFleet(false));
elements.pollFleet?.addEventListener('click', () => loadFleet(false));

elements.sendDesired?.addEventListener('click', async () => {
    if (!config.deviceId) return log('warn', 'Sem device selecionado');
    const desired = {};
    if (elements.cmdLed?.value) desired.led = elements.cmdLed.value;
    if (elements.cmdGpsInterval?.value) desired.gpsInterval = Number(elements.cmdGpsInterval.value);
    if (elements.cmdBuzzer?.value) desired.buzzer = elements.cmdBuzzer.value;
    if (elements.cmdCustom?.value) { try { Object.assign(desired, JSON.parse(elements.cmdCustom.value)); } catch { return log('err', 'JSON custom inválido'); } }
    if (!Object.keys(desired).length) return log('warn', 'Nada para enviar — preencha LED/intervalo/buzzer/JSON');
    try {
        const sent = buildDesiredPayload(desired);
        await patchDesired(config.deviceId, desired);
        log('ok', 'Desired enviado (shadow PATCH)', JSON.stringify(sent));
        fetchAndUpdate();
    } catch (e) {
        log('err', `Desired falhou: ${e.message}`, 'Se 401/403: cole Simple Token (API Key da equipe) na engrenagem — OAT só lê.');
    }
});
elements.sendPing?.addEventListener('click', async () => {
    try {
        await sendC2D(config.deviceId, { ping: Date.now() });
        log('ok', 'Ping c2d enviado (SendDeviceMessage)');
    } catch (e) {
        log('err', `Ping: ${e.message}`, 'c2d precisa Simple Token; ATT costuma preferir shadow desired/command.');
    }
});

elements.geoSet?.addEventListener('click', () => {
    try {
        const p = marker.getLatLng(); if (!p || p.lat === 0) return log('warn', 'Sem posição atual');
        geo = { lat: p.lat, lon: p.lng, radius: Number(elements.geoRadius?.value || 500) };
        localStorage.setItem('thingy_geo', JSON.stringify(geo)); restoreGeofence(); log('ok', 'Geofence definido', `${geo.lat},${geo.lon} r=${geo.radius}m`);
    } catch { log('warn', 'Sem posição para geofence'); }
});
elements.geoClear?.addEventListener('click', () => {
    geo = null; localStorage.removeItem('thingy_geo');
    if (geoCircle && map) map.removeLayer(geoCircle); geoCircle = null;
    setText(elements.geoState, '—'); log('info', 'Geofence limpo');
});
if (elements.geoRadius && geo) elements.geoRadius.value = geo.radius;
if (geo && elements.geoState) setText(elements.geoState, `Centro ${geo.lat},${geo.lon} · ${geo.radius}m`);

elements.refreshFota?.addEventListener('click', async () => {
    try {
        const fw = await listFirmware();
        if (elements.fotaList) elements.fotaList.innerHTML = fw.map(f => `<option value="${f.id || f.name}">${f.name || f.id} (${f.version || ''})</option>`).join('') || '<option value="">—</option>';
        const jobs = await listFotaJobs(config.deviceId);
        if (elements.fotaJobs) elements.fotaJobs.innerHTML = jobs.map(j => `<div class="msg-row"><span class="msg-app">${j.status || j.state || '?'}</span><span>${j.id || j.jobId}</span></div>`).join('') || 'Sem jobs';
        log('ok', `FOTA: ${fw.length} firmwares, ${jobs.length} jobs`);
    } catch (e) { log('err', `FOTA: ${e.message}`); }
});
elements.createFota?.addEventListener('click', async () => {
    const fwId = elements.fotaList?.value; if (!fwId) return log('warn', 'Selecione firmware (Atualizar primeiro)');
    try {
        await nrfFetch('/fota-jobs', { method: 'POST', body: JSON.stringify({ deviceIds: [config.deviceId], firmwareId: fwId, type: elements.fotaType?.value || 'APP' }) });
        log('ok', 'Job FOTA criado', fwId); elements.refreshFota?.click();
    } catch (e) { log('err', `FOTA create: ${e.message}`); }
});

elements.exportCsv?.addEventListener('click', () => {
    if (!lastMessages.length) return log('warn', 'Sem mensagens para CSV');
    const rows = [['receivedAt', 'appId', 'data']].concat(lastMessages.map(m => [m.receivedAt, m.message?.appId || '', JSON.stringify(m.message?.data ?? {})]));
    download(`thingy91x-msgs-${Date.now()}.csv`, rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
    log('info', 'CSV exportado');
});
elements.exportGeo?.addEventListener('click', () => {
    if (!lastTrail.length) return log('warn', 'Sem trilha — carregue trilha primeiro');
    const gj = { type: 'FeatureCollection', features: lastTrail.filter(t => t.lat && t.lon).map(t => ({ type: 'Feature', properties: { recordedAt: t.recordedAt, serviceType: t.serviceType, acc: t.meta?.acc }, geometry: { type: 'Point', coordinates: [Number(t.lon), Number(t.lat)] } })) };
    download(`thingy91x-trail-${Date.now()}.geojson`, JSON.stringify(gj, null, 2)); log('info', 'GeoJSON exportado');
});
elements.exportShadow?.addEventListener('click', () => {
    if (!lastDeviceRaw) return log('warn', 'Sem shadow — aguarde poll');
    download(`thingy91x-shadow-${Date.now()}.json`, JSON.stringify(lastDeviceRaw, null, 2)); log('info', 'Shadow exportado');
});

document.addEventListener('DOMContentLoaded', () => {
    log('info', 'Dashboard v2 + serial bridge', NRF_CLOUD_BASE);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js?v=8').catch(() => {});
    init(); loadFleet(false);
});
