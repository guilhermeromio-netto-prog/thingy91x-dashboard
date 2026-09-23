/* Thingy:91X Dashboard v2 — multi-device, comandos, FOTA, geofence, export, PWA
 * Dual proxy (Memfault + nRF Cloud):
 *  GET  /devices?pageLimit=100     -> Memfault .../devices
 *  GET  /devices/{id}              -> Memfault device + attributes + nRF FetchDevice(state)
 *  GET  /messages?deviceId=…       -> nRF Cloud /v1/messages (telemetry)
 *  GET  /location/history?…        -> nRF Cloud /v1/location/history (trail)
 * Auth: Memfault Basic/OAT + optional team Simple Token (X-Nrf-Team-Key) for msgs/GPS
 * Writes: shadow PATCH + c2d forwarded to api.nrfcloud.com (need Simple Token). Still 501: legacy FOTA
 */
// API base by host:
//  - localhost / 127.0.0.1          → /api (local Express)
//  - *.netlify.app                  → /.netlify/functions/nrfcloud
//  - *.github.io / other public HTTPS → absolute Netlify function (CORS)
//  - trycloudflare / same-origin tunnel → /api
const NETLIFY_FN = 'https://thingy91x-x-dashboard.netlify.app/.netlify/functions/nrfcloud';
function resolveNrfCloudBase() {
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1') return '/api';
    if (/netlify\.app$/i.test(h)) return '/.netlify/functions/nrfcloud';
    if (/github\.io$/i.test(h)) return NETLIFY_FN;
    if (/trycloudflare\.com$/i.test(h)) return '/api';
    if (location.protocol === 'https:') return NETLIFY_FN;
    return '/api';
}
const NRF_CLOUD_BASE = resolveNrfCloudBase();

const DEVICE_DEFAULT = '50423451-3737-4337-80fc-110bddf418ff';
let config = {
    apiKey: localStorage.getItem('nrf_api_key') || '',
    teamApiKey: localStorage.getItem('nrf_team_api_key') || '',
    email: localStorage.getItem('nrf_user_email') || '',
    orgSlug: localStorage.getItem('nrf_org_slug') || 'telekom',
    projectSlug: localStorage.getItem('nrf_project_slug') || 'nrf-project',
    deviceId: localStorage.getItem('nrf_device_id') || DEVICE_DEFAULT
};
let map, marker, accuracyCircle = null, trailLine = null, trailMarkersLayer = null, trailEnabled = true;
let fleetMarkers = [];
let pollInterval = null;
function resolvePollMs() {
    const h = location.hostname;
    // Local / tunnel: faster poll helps USB serial overlay
    if (h === 'localhost' || h === '127.0.0.1' || /trycloudflare\.com$/i.test(h)) return 10000;
    // github.io + other public HTTPS via Netlify API: 1 min
    return 60000;
}
const POLL_MS = resolvePollMs();
let lastConnected = null, lastSeenTs = null, lastBatteryPct = null;
let deviceList = [], lastDeviceRaw = null, lastMessages = [], lastTrail = [], lastSerial = null;
let trailFailLogged = false, lastTrailFitCount = 0;
const LOCAL_TRAIL_CAP = 2000;
let telemetrySource = { env: null, battery: null, net: null, gps: null };
let geo = JSON.parse(localStorage.getItem('thingy_geo') || 'null');
let geoCircle = null, geoInside = null;
const logCount = { api: 0, err: 0 };
let lastPollAuthFail = false;

const $ = id => document.getElementById(id);
const elements = {
    connectionStatus: $('connectionStatus'), connLabel: $('connLabel'),
    deviceId: $('deviceId'), deviceName: $('deviceName'), firmwareVersion: $('firmwareVersion'), lastSeen: $('lastSeen'),
    deviceSelect: $('deviceSelect'), refreshFleet: $('refreshFleet'), fleetCount: $('fleetCount'), fleetGrid: $('fleetGrid'), pollFleet: $('pollFleet'),
    gpsCoords: $('gpsCoords'), gpsSourceBadge: $('gpsSourceBadge'), gpsLat: $('gpsLat'), gpsLon: $('gpsLon'), gpsAcc: $('gpsAcc'), gpsSats: $('gpsSats'), gpsAlt: $('gpsAlt'), gpsSpeed: $('gpsSpeed'),
    tempValue: $('tempValue'), humValue: $('humValue'), pressValue: $('pressValue'),
    accelX: $('accelX'), accelY: $('accelY'), accelZ: $('accelZ'), steps: $('steps'),
    batteryFill: $('batteryFill'), batteryValue: $('batteryValue'), batteryVoltage: $('batteryVoltage'), batteryCharging: $('batteryCharging'),
    rsrp: $('rsrp'), rsrq: $('rsrq'), operator: $('operator'), serviceType: $('serviceType'), netBand: $('netBand'),
    netMccMnc: $('netMccMnc'), netMode: $('netMode'), netSupportedBands: $('netSupportedBands'),
    netTac: $('netTac'), netCellId: $('netCellId'), netUeMode: $('netUeMode'), netIp: $('netIp'),
    netSnr: $('netSnr'), netWifi: $('netWifi'), netSource: $('netSource'),
    netImei: $('netImei'), netIccid: $('netIccid'), netImsi: $('netImsi'),
    centerMap: $('centerMap'), toggleTrail: $('toggleTrail'), trailStatus: $('trailStatus'), trailPoints: $('trailPoints'), trailRange: $('trailRange'),
    configModal: $('configModal'), apiKey: $('apiKey'), teamApiKey: $('teamApiKey'), userEmail: $('userEmail'), orgSlug: $('orgSlug'), projectSlug: $('projectSlug'), deviceIdInput: $('deviceIdInput'),
    saveConfig: $('saveConfig'), cancelConfig: $('cancelConfig'), configBtn: $('configBtn'), closeModal: $('closeModal'),
    authBanner: $('authBanner'), authBannerBtn: $('authBannerBtn'), copyPairingLink: $('copyPairingLink'), configError: $('configError'),
    logPanel: $('logPanel'), logFilter: $('logFilter'), exportLog: $('exportLog'), clearLog: $('clearLog'),
    connState: $('connState'), connLastSeen: $('connLastSeen'), connLastMsg: $('connLastMsg'), connMsgCount: $('connMsgCount'), connLatency: $('connLatency'), connPoll: $('connPoll'),
    cmdLed: $('cmdLed'), cmdGpsInterval: $('cmdGpsInterval'), cmdBuzzer: $('cmdBuzzer'), cmdCustom: $('cmdCustom'), sendDesired: $('sendDesired'), sendPing: $('sendPing'),
    geoRadius: $('geoRadius'), geoSet: $('geoSet'), geoClear: $('geoClear'), geoState: $('geoState'),
    fotaList: $('fotaList'), fotaType: $('fotaType'), createFota: $('createFota'), refreshFota: $('refreshFota'), fotaJobs: $('fotaJobs'),
    msgTable: $('msgTable'), exportCsv: $('exportCsv'), exportGeo: $('exportGeo'), exportShadow: $('exportShadow'),
    dataSourceBadge: $('dataSourceBadge'),
    copyDeviceId: $('copyDeviceId'), aliasEditBtn: $('aliasEditBtn'), situacaoLine: $('situacaoLine'),
    envAge: $('envAge'), batteryAge: $('batteryAge'), gpsAge: $('gpsAge'), netAge: $('netAge'),
    netEmptyHint: $('netEmptyHint'), motionEmptyHint: $('motionEmptyHint'),
    motionSpeedWrap: $('motionSpeedWrap'), motionSpeed: $('motionSpeed'),
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

/* ---------- Modal / auth banner / pairing ---------- */
function setConfigError(msg) {
    const el = elements.configError;
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = msg;
}
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
        setConfigError('');
    }
    elements.configModal?.classList.add('show');
}
function hideModal() { elements.configModal?.classList.remove('show'); setConfigError(''); }
function updateAuthBanner() {
    const show = !config.apiKey || lastPollAuthFail;
    const el = elements.authBanner;
    if (el) el.hidden = !show;
    document.body.classList.toggle('has-auth-banner', !!show);
}
function persistConfigToStorage() {
    try {
        localStorage.setItem('nrf_api_key', config.apiKey);
        localStorage.setItem('nrf_team_api_key', config.teamApiKey || '');
        localStorage.setItem('nrf_user_email', config.email);
        localStorage.setItem('nrf_org_slug', config.orgSlug);
        localStorage.setItem('nrf_project_slug', config.projectSlug);
        localStorage.setItem('nrf_device_id', config.deviceId);
        return true;
    } catch (e) {
        alert('Não foi possível salvar neste navegador (modo privado / bloqueio de armazenamento). Desative o modo privado ou permita localStorage e tente de novo.');
        return false;
    }
}
function b64urlEncode(str) {
    const b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
    let b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return decodeURIComponent(escape(atob(b64)));
}
function buildPairingUrl() {
    const payload = {
        apiKey: config.apiKey || '',
        teamApiKey: config.teamApiKey || '',
        email: config.email || '',
        orgSlug: config.orgSlug || 'telekom',
        projectSlug: config.projectSlug || 'nrf-project',
        deviceId: config.deviceId || '',
    };
    const base = 'https://guilhermeromio-netto-prog.github.io/thingy91x-dashboard/?v=22#cfg=';
    return base + b64urlEncode(JSON.stringify(payload));
}
async function copyPairingLink() {
    // Sync form → config first (may not have saved yet)
    config.apiKey = (elements.apiKey?.value.trim() || config.apiKey || '').replace(/^(Bearer|Basic)\s+/i, '');
    config.teamApiKey = (elements.teamApiKey?.value.trim() || config.teamApiKey || '').replace(/^(Bearer|Basic)\s+/i, '');
    config.email = elements.userEmail?.value.trim() || config.email || '';
    config.orgSlug = elements.orgSlug?.value.trim() || config.orgSlug || 'telekom';
    config.projectSlug = elements.projectSlug?.value.trim() || config.projectSlug || 'nrf-project';
    config.deviceId = elements.deviceIdInput?.value.trim() || config.deviceId || '';
    if (!config.apiKey) {
        setConfigError('Preencha User API Key/OAT antes de copiar o link.');
        return;
    }
    const url = buildPairingUrl();
    try {
        await navigator.clipboard.writeText(url);
        log('ok', 'Link de pairing copiado — abra no celular');
        setConfigError('');
        showToast('Link copiado — abra no celular');
    } catch (e) {
        // Fallback: prompt for manual copy
        try { window.prompt('Copie o link (contém segredos):', url); } catch { /* ignore */ }
        log('warn', 'Clipboard bloqueado — use o prompt para copiar');
    }
}
function showToast(msg, ms = 3200) {
    let t = document.getElementById('importToast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'importToast';
        t.className = 'toast-import';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => { t.hidden = true; }, ms);
}
function importConfigFromHash() {
    const hash = location.hash || '';
    if (!hash.startsWith('#cfg=')) return false;
    try {
        const raw = b64urlDecode(hash.slice(5));
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object') throw new Error('payload inválido');
        if (data.apiKey) config.apiKey = String(data.apiKey).replace(/^(Bearer|Basic)\s+/i, '');
        if (data.teamApiKey != null) config.teamApiKey = String(data.teamApiKey).replace(/^(Bearer|Basic)\s+/i, '');
        if (data.email != null) config.email = String(data.email);
        if (data.orgSlug) config.orgSlug = String(data.orgSlug);
        if (data.projectSlug) config.projectSlug = String(data.projectSlug);
        if (data.deviceId) config.deviceId = String(data.deviceId);
        if (!persistConfigToStorage()) return false;
        history.replaceState(null, '', location.pathname + location.search);
        log('ok', 'Chaves importadas neste celular');
        showToast('Chaves importadas neste celular');
        lastPollAuthFail = false;
        updateAuthBanner();
        return true;
    } catch (e) {
        log('err', 'Falha ao importar #cfg=', e.message);
        try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
        return false;
    }
}
async function saveConfig() {
    config.apiKey = (elements.apiKey?.value.trim() || '').replace(/^(Bearer|Basic)\s+/i, '');
    config.teamApiKey = (elements.teamApiKey?.value.trim() || '').replace(/^(Bearer|Basic)\s+/i, '');
    config.email = elements.userEmail?.value.trim() || '';
    config.orgSlug = elements.orgSlug?.value.trim() || 'telekom';
    config.projectSlug = elements.projectSlug?.value.trim() || 'nrf-project';
    config.deviceId = elements.deviceIdInput?.value.trim() || '';
    setConfigError('');
    if (!config.apiKey) {
        setConfigError('User API Key / OAT é obrigatório.');
        return;
    }
    if (!persistConfigToStorage()) return;
    const btn = elements.saveConfig;
    const prevLabel = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Testando…'; }
    try {
        await nrfFetch('/devices?pageLimit=1');
        lastPollAuthFail = false;
        updateAuthBanner();
        log('ok', 'Conexão OK — configuração salva', `${config.orgSlug}/${config.projectSlug} · ${config.deviceId || 'auto'}`);
        hideModal();
        setStatus(true, 'Conectado');
        init();
    } catch (e) {
        lastPollAuthFail = /401|403|Authorization|chave|Nenhuma chave/i.test(e.message);
        updateAuthBanner();
        const msg = e.message || 'Falha ao conectar';
        setConfigError(msg);
        log('err', 'Teste de conexão falhou', msg);
        // keep modal open — do not pretend success
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = prevLabel || 'Salvar e Conectar'; }
    }
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
/** Age label for vitals; marks .atrasado when >5 min. */
function setDataAge(el, ts, { missing = 'sem timestamp' } = {}) {
    if (!el) return;
    if (!ts) {
        el.textContent = missing;
        el.classList.add('atrasado');
        el.title = 'Sem timestamp do dado';
        return;
    }
    const ms = Date.now() - new Date(ts).getTime();
    const s = Math.floor(ms / 1000);
    el.textContent = timeAgo(ts);
    el.classList.toggle('atrasado', Number.isFinite(s) && s > 300);
    el.title = new Date(ts).toLocaleString('pt-BR');
}
function aliasStorageKey(deviceId) {
    return `thingy_device_alias_${deviceId || config.deviceId || 'default'}`;
}
function getDeviceAlias(deviceId, fallback) {
    const id = deviceId || config.deviceId;
    try {
        const saved = localStorage.getItem(aliasStorageKey(id));
        if (saved && saved.trim()) return saved.trim();
    } catch { /* ignore */ }
    return fallback || 'Asset Tracker';
}
function setDeviceAlias(deviceId, alias) {
    const id = deviceId || config.deviceId;
    const v = String(alias || '').trim() || 'Asset Tracker';
    try { localStorage.setItem(aliasStorageKey(id), v); } catch { /* ignore */ }
    return v;
}
function applyAliasToHero(deviceId, cloudName) {
    const alias = getDeviceAlias(deviceId, cloudName || 'Asset Tracker');
    if (elements.deviceName) {
        // Avoid clobbering while user is editing
        if (document.activeElement !== elements.deviceName)
            elements.deviceName.textContent = alias;
    }
    return alias;
}
function looksLikeVoltage(n) {
    if (n == null || !Number.isFinite(Number(n))) return false;
    const v = Number(n);
    if (v > 1000 && v < 6000) return true; // mV
    if (v >= 2.5 && v <= 5.5) return true; // V typical Li-ion
    return false;
}
function looksLikePercent(n) {
    if (n == null || !Number.isFinite(Number(n))) return false;
    const v = Number(n);
    return v >= 0 && v <= 100;
}
function normalizeBatteryFields(rawV, rawPct) {
    let volts = null, pct = null;
    if (rawPct != null && Number.isFinite(Number(rawPct))) {
        const p = Number(rawPct);
        if (p >= 0 && p <= 100) pct = Math.round(p);
    }
    if (rawV != null && Number.isFinite(Number(rawV))) {
        const v = Number(rawV);
        if (looksLikeVoltage(v)) {
            volts = v > 1000 ? v / 1000 : v;
        } else if (pct == null && looksLikePercent(v) && !(v >= 2.5 && v <= 5.5)) {
            pct = Math.round(v);
        }
    }
    if (volts != null && pct == null) pct = voltToBatteryPct(volts);
    return { volts, pct };
}
function updateSituacaoLine({ alias, connected, batteryPct, trailPts } = {}) {
    if (!elements.situacaoLine) return;
    if (batteryPct != null) lastBatteryPct = batteryPct;
    const pct = batteryPct != null ? batteryPct : lastBatteryPct;
    const parts = [];
    parts.push(alias || getDeviceAlias(config.deviceId, 'Asset Tracker'));
    const conn = connected !== undefined ? connected : lastConnected;
    if (conn === true) parts.push('ONLINE');
    else if (conn === false) parts.push('OFFLINE');
    else parts.push('…');
    if (pct != null) parts.push(`bateria ${pct}%`);
    const n = trailPts != null ? trailPts : (lastTrail?.length || 0);
    parts.push(`trilha ${n} pts`);
    elements.situacaoLine.textContent = parts.join(' · ');
}
function refreshGeofenceUi(lat, lon) {
    if (!geo) {
        setText(elements.geoState, 'Sem cerca definida.');
        if (elements.geoState) elements.geoState.style.color = '';
        return;
    }
    if (map) restoreGeofence();
    if (lat != null && lon != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
        checkGeofence(Number(lat), Number(lon));
    } else {
        setText(elements.geoState, 'Cerca ativa — aguardando fix.');
        if (elements.geoState) elements.geoState.style.color = '#fdcb6e';
    }
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
        // Dual auth: some mobile/CDN paths strip Authorization; Netlify resolveAuth reads these
        'X-User-Api-Key': config.apiKey || '',
        ...options.headers,
    };
    if (config.email) headers['X-User-Email'] = config.email;
    if (config.teamApiKey) headers['X-Nrf-Team-Key'] = config.teamApiKey;
    Object.keys(headers).forEach(k => (headers[k] === undefined || headers[k] === '') && k !== 'X-User-Api-Key' && delete headers[k]);
    if (!headers['X-User-Api-Key']) delete headers['X-User-Api-Key'];
    log('api', `→ ${options.method || 'GET'} ${path}`);
    const res = await fetch(`${NRF_CLOUD_BASE}${path}`, { ...options, headers });
    const latency = Date.now() - t0;
    if (!res.ok) {
        const eb = await res.json().catch(() => ({}));
        const errCode = typeof eb.error === 'string' ? eb.error : '';
        const raw = eb.message ?? eb.error ?? eb.detail ?? eb.feature ?? eb.title ?? null;
        let msg;
        if (raw == null || raw === '') msg = `HTTP ${res.status}`;
        else if (typeof raw === 'string') msg = raw;
        else if (typeof raw === 'object') {
            msg = raw.message || raw.error || raw.detail || raw.code || JSON.stringify(raw).slice(0, 120);
        } else msg = String(raw);
        if (/401|403/.test(String(res.status))) {
            if (errCode === 'Missing Authorization' || /Missing Authorization/i.test(String(msg))) {
                msg = 'Nenhuma chave enviada — abra Configurar e salve.';
            } else {
                msg = 'Chave rejeitada — confira User API Key/OAT e e-mail (Basic) ou OAT sem e-mail.';
            }
        }
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
        // Serial bridge lives only on local Express. Skip quietly on github.io / absolute Netlify.
        if (/^https?:\/\//i.test(NRF_CLOUD_BASE) || /github\.io$/i.test(location.hostname)) {
            return null;
        }
        // Local /api or Netlify same-origin: hit /api/serial/telemetry (Netlify redirects to fn; 404 ok)
        let origin = '';
        if (NRF_CLOUD_BASE === '/api' || NRF_CLOUD_BASE.startsWith('/.netlify')) {
            origin = '';
        } else {
            origin = '';
        }
        const h = { 'Cache-Control': 'no-store' };
        const auth = buildAuthHeader();
        if (auth) {
            h['Authorization'] = auth;
            h['X-Memfault-Org'] = config.orgSlug || 'telekom';
            h['X-Memfault-Project'] = config.projectSlug || 'nrf-project';
            if (config.apiKey) h['X-User-Api-Key'] = config.apiKey;
            if (config.email) h['X-User-Email'] = config.email;
            if (config.teamApiKey) h['X-Nrf-Team-Key'] = config.teamApiKey;
        }
        if (config.deviceId) h['X-Device-Id'] = config.deviceId;
        const q = config.deviceId ? `?deviceId=${encodeURIComponent(config.deviceId)}` : '';
        const res = await fetch(`${origin}/api/serial/telemetry${q}`, { cache: 'no-store', headers: h });
        if (!res.ok) return null;
        const data = await res.json();
        lastSerial = data;
        return data;
    } catch {
        return null;
    }
}
function applySerialOverlay(fromMsg, parsed, serial) {
    if (!serial) return { fromMsg, parsed, used: false };
    const hasFix = serial.lat != null && serial.lon != null;
    const hasNet = serial.mcc != null || serial.mccMnc != null || serial.rsrp != null || serial.operator;
    const hasEnv = serial.temperatureC != null || serial.humidityPct != null || serial.batteryMv != null;
    const hasWifi = Array.isArray(serial.wifiAps) && serial.wifiAps.length > 0;
    // Allow resolved lat/lon (wifi/cell) even when USB briefly drops (ok=false)
    if (!serial.ok && !hasFix && !hasNet && !hasEnv && !hasWifi) return { fromMsg, parsed, used: false };
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
    take('imei', serial.imei);
    take('iccid', serial.iccid);
    take('imsi', serial.imsi);
    if (Array.isArray(serial.wifiAps) && serial.wifiAps.length) { p.wifiAps = serial.wifiAps; used = true; }
    if (serial.operator || serial.mccMnc || serial.band != null || serial.rsrp != null || serial.ipAddress)
        telemetrySource.net = telemetrySource.net || 'serial';
    else if (p.operator || p.mccMnc) telemetrySource.net = telemetrySource.net || 'cloud';
    // Ensure VIVO hint when PLMN known
    if (p.mccMnc && (!p.operator || String(p.operator) === String(p.mccMnc) || /^\d+$/.test(String(p.operator)))) {
        const h = plmnHint(p.mccMnc);
        if (h) p.operator = h;
    }
    if ((fm.gps?.lat == null || fm.gps?.lon == null) && serial.lat != null && serial.lon != null) {
        fm.gps = {
            lat: Number(serial.lat),
            lon: Number(serial.lon),
            accuracy: serial.locationAccuracy != null ? Number(serial.locationAccuracy) : undefined,
            source: serial.locationSource || 'serial',
        };
        telemetrySource.gps = 'serial'; used = true;
    } else if (fm.gps?.lat != null) {
        telemetrySource.gps = telemetrySource.gps || 'cloud';
        if (!fm.gps.source && serial?.locationSource) fm.gps.source = serial.locationSource;
    }
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
    for (const it of list) {
        const a = it.message?.appId || it.appId || it.app_id || 'UNKNOWN';
        if (!byApp[a]) byApp[a] = it;
    }
    const out = {};
    const pick = (o, ...ks) => {
        if (o == null) return undefined;
        if (typeof o === 'number' || typeof o === 'string') return o;
        if (typeof o !== 'object') return undefined;
        for (const k of ks) if (o[k] !== undefined && o[k] !== null) return o[k];
        return undefined;
    };
    const asNum = (v) => {
        if (v == null || v === '') return undefined;
        if (typeof v === 'string') {
            const t = v.trim();
            // RSRP schema: string like "-95" or "-95.0"
            if (/^-?\d+(\.\d+)?$/.test(t)) {
                const n = Number(t);
                return Number.isFinite(n) ? n : undefined;
            }
        }
        return num(v);
    };
    for (const [a, it] of Object.entries(byApp)) {
        const m = it.message ?? it.data ?? {};
        out[a] = { raw: m, data: m.data ?? m, receivedAt: it.receivedAt || it.received_at || it.ts };
    }
    const g = out.GNSS?.data ?? out.GPS?.data, t = out.TEMP?.data, h = out.HUMID?.data ?? out.HUMIDITY?.data,
        p = out.AIR_PRESS?.data ?? out.PRESSURE?.data, r = out.RSRP?.data,
        dev = out.DEVICE?.data, bat = out.BATTERY?.data ?? out.BAT?.data,
        env = out.ENV?.data ?? out.ENVIRONMENT?.data;
    const scell = out.SCELL?.data;
    const cellPos = out.CELL_POS?.data;
    const lte0 = Array.isArray(cellPos?.lte) && cellPos.lte.length ? cellPos.lte[0] : null;
    const niMsg = (dev && typeof dev === 'object' ? (dev.networkInfo || dev.network || null) : null) || null;
    const simMsg = (dev && typeof dev === 'object' ? (dev.simInfo || dev.sim || null) : null) || null;
    const diMsg = (dev && typeof dev === 'object' ? (dev.deviceInfo || null) : null) || null;

    // Prefer DEVICE.networkInfo; fall back to SCELL / CELL_POS LTE cell
    const mcc = asNum(pick(niMsg ?? {}, 'mcc') ?? pick(scell ?? {}, 'mcc') ?? pick(lte0 ?? {}, 'mcc'));
    const mnc = asNum(pick(niMsg ?? {}, 'mnc') ?? pick(scell ?? {}, 'mnc') ?? pick(lte0 ?? {}, 'mnc'));
    let mccMnc = pick(niMsg ?? {}, 'mccmnc', 'mccMnc', 'MCCMNC') ?? null;
    if (mccMnc == null && mcc != null && mnc != null) {
        const mncStr = String(Math.trunc(mnc));
        mccMnc = `${Math.trunc(mcc)}${mncStr.padStart(mncStr.length >= 3 ? 3 : 2, '0')}`;
        // Keep common BR style: 72410 (2-digit MNC) when mnc < 100
        if (mnc < 100) mccMnc = `${Math.trunc(mcc)}${String(Math.trunc(mnc)).padStart(2, '0')}`;
    }
    const tacRaw = pick(niMsg ?? {}, 'areaCode', 'tac', 'TAC') ?? pick(scell ?? {}, 'tac') ?? pick(lte0 ?? {}, 'tac');
    const cellRaw = pick(niMsg ?? {}, 'cellID', 'cellId', 'eci', 'ECI') ?? pick(scell ?? {}, 'eci') ?? pick(lte0 ?? {}, 'eci');
    let rsrpVal = r != null ? (typeof r === 'number' ? r : asNum(typeof r === 'object' ? pick(r, 'value', 'rsrp', 'v') : r)) : undefined;
    if (rsrpVal == null) rsrpVal = asNum(pick(niMsg ?? {}, 'rsrp') ?? pick(scell ?? {}, 'rsrp') ?? pick(lte0 ?? {}, 'rsrp') ?? pick(dev ?? {}, 'rsrp'));
    let rsrqVal = asNum(pick(dev ?? {}, 'rsrq') ?? pick(out.RSRQ?.data ?? {}, 'value', 'v', 'rsrq') ?? pick(lte0 ?? {}, 'rsrq') ?? pick(niMsg ?? {}, 'rsrq'));

    const latestAt = list[0]?.receivedAt || list[0]?.received_at || list[0]?.ts;
    const netAt = out.DEVICE?.receivedAt || out.SCELL?.receivedAt || out.CELL_POS?.receivedAt
        || out.RSRP?.receivedAt || out.RSRQ?.receivedAt || null;

    return {
        byApp, latestAt, netAt,
        gps: g ? { lat: num(pick(g, 'lat', 'latitude', 'v')), lon: num(pick(g, 'lng', 'lon', 'longitude', 'v')), accuracy: num(pick(g, 'acc', 'accuracy', 'uncertainty')), speed: num(pick(g, 'spd', 'speed')), altitude: num(pick(g, 'alt', 'altitude')), satellites: num(pick(g, 'sats', 'satellites', 'numSat')) } : {},
        temp: num(typeof t === 'number' ? t : pick(t ?? env ?? {}, 'value', 'temp', 'temperature', 'v')),
        hum: num(typeof h === 'number' ? h : pick(h ?? env ?? {}, 'value', 'humidity', 'hum', 'v')),
        press: num(typeof p === 'number' ? p : pick(p ?? env ?? {}, 'value', 'pressure', 'press', 'v')),
        rsrp: rsrpVal,
        rsrq: rsrqVal,
        // Cloud network from DEVICE / SCELL / CELL_POS
        mccMnc: mccMnc != null ? String(mccMnc) : undefined,
        mcc, mnc,
        operator: (mccMnc ? plmnHint(mccMnc) : null) || undefined,
        networkMode: pick(niMsg ?? {}, 'networkMode', 'accessTech') || undefined,
        band: asNum(pick(niMsg ?? {}, 'currentBand', 'band')),
        supportedBands: pick(niMsg ?? {}, 'supportedBands', 'supportedBand') || undefined,
        ueMode: pick(niMsg ?? {}, 'ueMode', 'UEMode'),
        ipAddress: pick(niMsg ?? {}, 'ipAddress', 'ip', 'IPV4') || undefined,
        tac: tacRaw != null ? tacRaw : undefined,
        tacDec: asNum(tacRaw),
        eci: cellRaw != null ? cellRaw : undefined,
        eciDec: asNum(cellRaw),
        cellId: asNum(cellRaw) ?? cellRaw,
        snr: asNum(pick(niMsg ?? {}, 'snr', 'SINR')),
        iccid: pick(simMsg ?? {}, 'iccid', 'ICCID') || undefined,
        imsi: pick(simMsg ?? {}, 'imsi', 'IMSI') || undefined,
        uiccMode: pick(simMsg ?? {}, 'uiccMode'),
        imei: pick(diMsg ?? {}, 'imei', 'IMEI') || undefined,
        batteryV: num(pick(dev ?? bat ?? {}, 'batteryVoltage', 'batV', 'voltage', 'v') ?? pick(diMsg ?? {}, 'batteryVoltage')),
        batteryPct: (() => {
            // Explicit SoC keys first
            let n = num(pick(bat ?? {}, 'percent', 'percentage', 'SoC', 'soc', 'level'));
            if (n == null && bat != null && typeof bat === 'number') n = bat;
            if (n == null) {
                const v = num(pick(bat ?? {}, 'value', 'bat'));
                // Bare 0–100 that is NOT in typical voltage band → SoC
                if (v != null && v >= 0 && v <= 100 && !(v >= 2.5 && v <= 5.5)) n = v;
            }
            if (n == null) return undefined;
            if (n >= 0 && n <= 100) return n;
            return undefined;
        })(),
        batteryAt: out.BATTERY?.receivedAt || out.BAT?.receivedAt || out.DEVICE?.receivedAt || null,
        envAt: out.TEMP?.receivedAt || out.ENV?.receivedAt || out.ENVIRONMENT?.receivedAt
            || out.HUMID?.receivedAt || out.AIR_PRESS?.receivedAt || null,
        accel: out.ACCEL?.data ?? out.MOTION?.data,
        steps: num(pick(out.STEPS?.data ?? out.ACCEL?.data ?? {}, 'steps', 'stepCount', 'value')),
        accelAt: out.ACCEL?.receivedAt || out.MOTION?.receivedAt || out.STEPS?.receivedAt || null,
        netSourceHint: (niMsg || scell || lte0 || rsrpVal != null) ? 'cloud' : undefined,
    };
}

function parseDevice(d) {
    const rep = d.state?.reported ?? {}, di = rep.device?.deviceInfo ?? {},
        ni = rep.device?.networkInfo ?? rep.networkInfo ?? {},
        si = rep.device?.simInfo ?? rep.simInfo ?? {},
        fw = d.firmware ?? {};
    const bat = rep.device?.batteryStatus ?? rep.battery ?? rep.bat ?? {};
    const id = d.id || d.device_serial || d._memfault?.device_serial;
    const lastSeen = d.$meta?.updatedAt || d.last_seen || d._memfault?.last_seen || d._nrf?.$meta?.updatedAt;
    const firmware = fw.app?.version || di.appVersion || di.modemFirmware || d.last_seen_release?.version || d._memfault?.last_seen_release?.version || '—';
    const batteryV = num(bat.voltage || bat.batteryVoltage || bat.v || di.batteryVoltage);
    const batteryPctRaw = num(bat.percent ?? bat.percentage ?? bat.SoC ?? bat.soc ?? bat.level
        ?? bat.battery ?? (typeof bat === 'number' ? bat : undefined));
    const batteryPct = (batteryPctRaw != null && batteryPctRaw >= 0 && batteryPctRaw <= 100
        && !(batteryPctRaw >= 2.5 && batteryPctRaw <= 5.5)) ? Math.round(batteryPctRaw) : undefined;
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
    // Memfault attributes sometimes carry imei
    const flatAttrs = (() => {
        const attrs = d._attributes;
        const list = Array.isArray(attrs) ? attrs : (attrs?.data || attrs?.items || []);
        const o = {};
        for (const it of list) {
            const key = it.string_key || it.metric_config?.string_key || it.key;
            const val = it.state?.value ?? it.value;
            if (key != null && val !== undefined) o[key] = val;
        }
        return o;
    })();
    const imei = di.imei || flatAttrs.imei || d._nrf?.imei || null;
    const iccid = si.iccid || si.ICCID || flatAttrs.iccid || null;
    const imsi = si.imsi || si.IMSI || flatAttrs.imsi || null;
    const hasNi = !!(mccMnc || ni.currentBand != null || ni.cellID != null || ni.areaCode != null || ni.rsrp != null || ni.networkMode);
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
        imei: imei ? String(imei) : null,
        iccid: iccid ? String(iccid) : null,
        imsi: imsi ? String(imsi) : null,
        uiccMode: si.uiccMode ?? null,
        batteryV,
        batteryPct,
        hardware: d.hardware_version || d._memfault?.hardware_version,
        nickname: d.nickname || d.name || null,
        netSourceHint: hasNi ? 'cloud' : null,
    };
}

/** Fill Rede gaps from ListMessages (DEVICE/SCELL/CELL_POS/RSRP) when shadow lacks networkInfo. */
function mergeCloudNetwork(parsed, fromMsg) {
    if (!fromMsg) return parsed;
    const p = { ...parsed };
    let used = false;
    const take = (key, val) => {
        if (val == null || val === '') return;
        if (p[key] == null || p[key] === '' || p[key] === '—') {
            p[key] = val;
            used = true;
        }
    };
    take('mccMnc', fromMsg.mccMnc);
    take('mcc', fromMsg.mcc);
    take('mnc', fromMsg.mnc);
    take('operator', fromMsg.operator || (fromMsg.mccMnc ? plmnHint(fromMsg.mccMnc) : null));
    take('networkMode', fromMsg.networkMode);
    take('band', fromMsg.band);
    take('supportedBands', fromMsg.supportedBands);
    take('ueMode', fromMsg.ueMode);
    take('ipAddress', fromMsg.ipAddress);
    take('tac', fromMsg.tac);
    take('tacDec', fromMsg.tacDec);
    take('eci', fromMsg.eci);
    take('eciDec', fromMsg.eciDec);
    take('cellId', fromMsg.cellId ?? fromMsg.eciDec ?? fromMsg.eci);
    take('snr', fromMsg.snr);
    take('imei', fromMsg.imei);
    take('iccid', fromMsg.iccid);
    take('imsi', fromMsg.imsi);
    take('uiccMode', fromMsg.uiccMode);
    if (p.rsrp == null && fromMsg.rsrp != null) { p.rsrp = fromMsg.rsrp; used = true; }
    if (p.rsrq == null && fromMsg.rsrq != null) { p.rsrq = fromMsg.rsrq; used = true; }
    if (p.mccMnc && (!p.operator || String(p.operator) === String(p.mccMnc) || /^\d+$/.test(String(p.operator)))) {
        const h = plmnHint(p.mccMnc);
        if (h) p.operator = h;
    }
    if (used || fromMsg.netSourceHint) p.netSourceHint = p.netSourceHint || fromMsg.netSourceHint || 'cloud';
    if (used) telemetrySource.net = telemetrySource.net || 'cloud';
    return p;
}


function locationSourceLabel(src) {
    const s = String(src || '').toLowerCase();
    if (!s) return null;
    if (s.startsWith('wifi') || s === 'wifi') return { text: 'Wi‑Fi', cls: 'src-wifi' };
    if (s.startsWith('cell') || s.includes('scell') || s.includes('mcell')) return { text: 'Célula', cls: 'src-cell' };
    if (s.includes('gnss') || s.includes('gps') || s === 'uart' || s === 'serial') return { text: 'GNSS', cls: 'src-gnss' };
    if (s.includes('cloud')) return { text: 'Célula', cls: 'src-cell' };
    return { text: s.slice(0, 12), cls: 'src-gnss' };
}
function setGpsSourceBadge(src) {
    const el = elements.gpsSourceBadge;
    if (!el) return;
    const info = locationSourceLabel(src);
    if (!info) {
        el.hidden = true;
        el.textContent = '—';
        el.className = 'loc-source-badge';
        return;
    }
    el.hidden = false;
    el.textContent = info.text;
    el.className = `loc-source-badge ${info.cls}`;
}

/* ---------- UI ---------- */
function updateUI(parsed, fromMsg) {
    const id = parsed.id || config.deviceId || '';
    setText(elements.deviceId, id || '-');
    const cloudName = parsed.nickname || parsed.name || null;
    const alias = applyAliasToHero(id, cloudName && cloudName !== id ? cloudName : 'Asset Tracker');
    setText(elements.firmwareVersion, parsed.firmware || '-');
    const ls = parsed.lastSeen || fromMsg.latestAt;
    setText(elements.lastSeen, ls ? new Date(ls).toLocaleString('pt-BR') : '-'); lastSeenTs = ls || lastSeenTs;

    const gps = { ...fromMsg.gps };
    let gpsTs = fromMsg.gpsAt || fromMsg.latestAt || lastSerial?.updatedAt || ls || null;
    if (gps.lat != null && gps.lon != null) {
        setText(elements.gpsCoords, `${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}`);
        setGpsSourceBadge(gps.source || lastSerial?.locationSource || telemetrySource.gps);
        setText(elements.gpsLat, gps.lat.toFixed(6)); setText(elements.gpsLon, gps.lon.toFixed(6));
        setText(elements.gpsAcc, gps.accuracy != null ? `${Math.round(gps.accuracy)} m` : '—');
        setText(elements.gpsAlt, gps.altitude != null ? `${Math.round(gps.altitude)} m` : '—');
        const spd = gps.speed != null ? Number(gps.speed) : null;
        setText(elements.gpsSpeed, spd != null ? `${spd.toFixed(1)} m/s` : '—');
        updateMap(gps.lat, gps.lon, gps.accuracy);
        refreshGeofenceUi(gps.lat, gps.lon);
    } else {
        refreshGeofenceUi(null, null);
    }
    setDataAge(elements.gpsAge, gps.lat != null ? gpsTs : null, { missing: gps.lat != null ? 'sem timestamp' : 'sem fix' });

    // Ambiente
    if (fromMsg.temp != null) setText(elements.tempValue, fromMsg.temp.toFixed(1));
    if (fromMsg.hum != null) setText(elements.humValue, fromMsg.hum.toFixed(1));
    if (fromMsg.press != null) {
        const ph = normalizePressHpa(fromMsg.press);
        setText(elements.pressValue, ph != null ? ph.toFixed(1) : fromMsg.press.toFixed(1));
    }
    const envTs = fromMsg.envAt || (fromMsg.temp != null || fromMsg.hum != null || fromMsg.press != null
        ? (fromMsg.latestAt || lastSerial?.updatedAt || ls) : null);
    const hasEnv = fromMsg.temp != null || fromMsg.hum != null || fromMsg.press != null;
    setDataAge(elements.envAge, hasEnv ? envTs : null, { missing: hasEnv ? 'sem timestamp' : 'sem dados' });

    // Bateria — SoC % vs volts (never label percent as V)
    const rawBatV = fromMsg.batteryV ?? parsed.batteryV;
    const rawBatPct = fromMsg.batteryPct ?? parsed.batteryPct;
    const { volts: batVolts, pct: batPct } = normalizeBatteryFields(rawBatV, rawBatPct);
    if (batPct != null) {
        setText(elements.batteryValue, `${batPct}%`);
        if (elements.batteryFill) {
            elements.batteryFill.style.width = `${batPct}%`;
            elements.batteryFill.className = 'battery-fill' + (batPct < 20 ? ' critical' : batPct < 40 ? ' low' : '');
        }
    } else {
        setText(elements.batteryValue, '—');
        if (elements.batteryFill) { elements.batteryFill.style.width = '0%'; elements.batteryFill.className = 'battery-fill'; }
    }
    if (batVolts != null) setText(elements.batteryVoltage, `${batVolts.toFixed(2)} V`);
    else setText(elements.batteryVoltage, batPct != null ? 'tensão n/d' : '—');
    const batTs = fromMsg.batteryAt || ((batPct != null || batVolts != null)
        ? (fromMsg.latestAt || lastSerial?.updatedAt || ls) : null);
    setDataAge(elements.batteryAge, (batPct != null || batVolts != null) ? batTs : null,
        { missing: (batPct != null || batVolts != null) ? 'sem timestamp' : 'sem dados' });

    // Movimento — honest empty + GNSS speed proxy
    let hasAccel = false;
    if (fromMsg.accel && typeof fromMsg.accel === 'object') {
        const ax = num(fromMsg.accel.x ?? fromMsg.accel.ax); const ay = num(fromMsg.accel.y ?? fromMsg.accel.ay); const az = num(fromMsg.accel.z ?? fromMsg.accel.az);
        if (ax != null) { setText(elements.accelX, ax.toFixed(2)); hasAccel = true; }
        if (ay != null) { setText(elements.accelY, ay.toFixed(2)); hasAccel = true; }
        if (az != null) { setText(elements.accelZ, az.toFixed(2)); hasAccel = true; }
    }
    if (fromMsg.steps != null) setText(elements.steps, String(fromMsg.steps));
    const hasSteps = fromMsg.steps != null;
    const gpsSpeedMs = gps.speed != null ? Number(gps.speed) : null;
    const gpsSpeedKmh = gpsSpeedMs != null && Number.isFinite(gpsSpeedMs) ? gpsSpeedMs * 3.6 : null;
    if (elements.motionEmptyHint) {
        if (!hasAccel && !hasSteps) {
            elements.motionEmptyHint.hidden = false;
            let hint = 'Acelerômetro/passos não publicados neste firmware/mensagens (esperado no ATT sem app motion).';
            if (gpsSpeedKmh != null) hint += ` Deslocamento via GNSS: ${gpsSpeedKmh.toFixed(1)} km/h.`;
            elements.motionEmptyHint.textContent = hint;
        } else {
            elements.motionEmptyHint.hidden = true;
            elements.motionEmptyHint.textContent = '';
        }
    }
    if (elements.motionSpeedWrap && elements.motionSpeed) {
        if (gpsSpeedKmh != null && (!hasAccel && !hasSteps)) {
            elements.motionSpeedWrap.hidden = false;
            setText(elements.motionSpeed, `${gpsSpeedKmh.toFixed(1)} km/h`);
        } else if (gpsSpeedKmh != null) {
            elements.motionSpeedWrap.hidden = false;
            setText(elements.motionSpeed, `${gpsSpeedKmh.toFixed(1)} km/h`);
        } else {
            elements.motionSpeedWrap.hidden = true;
        }
    }

    // Rede
    const rsrp = fromMsg.rsrp ?? parsed.rsrp;
    const rsrq = fromMsg.rsrq ?? parsed.rsrq;
    if (rsrp != null) setText(elements.rsrp, `${rsrp} dBm`);
    else setText(elements.rsrp, '—');
    if (rsrq != null) setText(elements.rsrq, `${Number(rsrq)} dB`);
    else setText(elements.rsrq, '—');
    if (fromMsg.gps?.satellites != null) setText(elements.gpsSats, String(fromMsg.gps.satellites));

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
    setText(elements.netImei, parsed.imei || '—');
    setText(elements.netIccid, parsed.iccid || '—');
    setText(elements.netImsi, parsed.imsi || '—');
    const src = telemetrySource.net || (lastSerial?.ok ? 'serial' : null) || parsed.netSourceHint || null;
    setText(elements.netSource, src || '—');

    const hasSimFields = !!(parsed.imei || parsed.iccid || parsed.imsi);
    const hasCellFields = !!(mccMnc || parsed.operator || parsed.band != null || parsed.cellId != null
        || parsed.eci != null || parsed.tac != null || parsed.ipAddress || rsrp != null || parsed.networkMode
        || hasSimFields);
    const locSrc = String(gps.source || lastSerial?.locationSource || telemetrySource.gps || '').toLowerCase();
    const locWifi = /wifi|wi-?fi/.test(locSrc);
    const online = parsed.connected === true;
    const offline = parsed.connected === false;
    const onPages = /github\.io|netlify/i.test(location.hostname || '');
    const noTeam = !config.teamApiKey;
    if (elements.netEmptyHint) {
        if (hasCellFields) {
            elements.netEmptyHint.hidden = true;
            elements.netEmptyHint.textContent = '';
        } else {
            elements.netEmptyHint.hidden = false;
            if (locWifi || /wifi/i.test(String(elements.serviceType?.textContent || ''))) {
                elements.netEmptyHint.textContent = 'Rádio celular não telemetrado neste payload — posição via Wi‑Fi/GNSS na nuvem.';
            } else if (noTeam && onPages) {
                elements.netEmptyHint.textContent = 'Sem dados de rede na nuvem — configure a Simple Token (equipe) na engrenagem para ListMessages (DEVICE/SCELL/RSRP). ATT 1.5 não publica networkInfo no shadow; USB serial só no Mac.';
            } else if (offline) {
                elements.netEmptyHint.textContent = 'Sem dados de rede — dispositivo offline, sem DEVICE/SCELL nas msgs e sem networkInfo no shadow (ATT 1.5).';
            } else {
                elements.netEmptyHint.textContent = 'Sem networkInfo no shadow (ATT 1.5) e sem DEVICE/SCELL/RSRP em ListMessages. No Mac, USB serial preenche a Rede.';
            }
        }
    }
    const netTs = hasCellFields
        ? (lastSerial?.updatedAt && telemetrySource.net === 'serial'
            ? lastSerial.updatedAt
            : (fromMsg.netAt || fromMsg.latestAt || ls))
        : null;
    setDataAge(elements.netAge, hasCellFields ? netTs : null, {
        missing: hasCellFields ? 'sem timestamp' : (offline ? 'offline' : 'sem networkInfo'),
    });

    updateSituacaoLine({
        alias,
        connected: parsed.connected,
        batteryPct: batPct,
        trailPts: lastTrail?.length || 0,
    });
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
    elements.fleetGrid.innerHTML = fleetData.map(f => {
        const alias = getDeviceAlias(f.id, f.nickname || f.name || 'Asset Tracker');
        const showAlias = alias && alias !== f.id && alias !== (f.name || '');
        return `<button class="fleet-card${f.id === config.deviceId ? ' active' : ''}" data-id="${f.id}">
      <span class="fleet-dot" style="background:${f.connected ? '#00b894' : '#d63031'}"></span>
      <span class="fleet-name">${alias || f.name || f.id}</span>
      ${showAlias && f.name && f.name !== alias ? `<span class="fleet-alias">${escHtml(f.name)}</span>` : ''}
      <span class="fleet-meta">${f.connected ? 'ONLINE' : 'OFFLINE'} · ${timeAgo(f.lastSeen)}</span>
    </button>`;
    }).join('') || '—';
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
    applyAliasToHero(id);
    if (elements.deviceSelect) elements.deviceSelect.value = id;
    lastConnected = null; lastTrail = []; lastTrailFitCount = 0; trailFailLogged = false;
    clearTrailMarkers();
    log('info', `Trocado para ${id}`); fetchAndUpdate(); loadTrail();
}

/* ---------- Map ---------- */
function initMap() {
    if (map) return;
    map = L.map('map').setView([-23.5505, -46.6333], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(map);
    marker = L.marker([0, 0]).addTo(map); marker.setOpacity(0);
    trailLine = L.polyline([], { color: '#0984e3', weight: 3, opacity: 0.7 }).addTo(map);
    trailMarkersLayer = L.layerGroup().addTo(map);
    restoreGeofence(); log('info', 'Mapa pronto');
}
/** Move marker + accuracy only. Trail polyline is owned by applyTrailPoints. */
function updateMap(lat, lon, acc, opts = {}) {
    if (!map || !marker) return;
    const appendTrail = !!opts.appendTrail;
    marker.setLatLng([lat, lon]); marker.setOpacity(1);
    if (acc != null && Number.isFinite(Number(acc))) {
        if (accuracyCircle) map.removeLayer(accuracyCircle);
        accuracyCircle = L.circle([lat, lon], { radius: Number(acc), color: '#0984e3', fillOpacity: 0.1, weight: 1 }).addTo(map);
    }
    if (appendTrail) {
        accumulateLocalPoint({
            lat: Number(lat), lon: Number(lon),
            at: opts.at || new Date().toISOString(),
            src: opts.src || 'live',
            unc: acc != null ? Number(acc) : undefined,
            serviceType: opts.serviceType || null,
            battery: opts.battery, batteryVoltage: opts.batteryVoltage, charging: opts.charging,
            connected: opts.connected, lastSeen: opts.lastSeen,
            temp: opts.temp, hum: opts.hum, press: opts.press,
            rsrp: opts.rsrp, operator: opts.operator, fw: opts.fw,
        });
    }
    if (!opts.skipZoom && map.getZoom() < 12) {
        const n = trailLine ? trailLine.getLatLngs().length : 0;
        if (n < 2) map.setView([lat, lon], 15);
    }
}
function drawFleetMarkers(fleet) {
    fleetMarkers.forEach(m => map.removeLayer(m)); fleetMarkers = [];
    log('info', `Frota online: ${fleet.filter(f => f.connected).length}/${fleet.length}`);
}

/* ---------- Trail (multi-day) ---------- */
function localTrailKey() {
    return `thingy_trail_pts_${config.deviceId || 'default'}`;
}
function loadLocalTrailRaw() {
    try { return JSON.parse(localStorage.getItem(localTrailKey()) || '[]'); }
    catch { return []; }
}
function saveLocalTrailRaw(arr) {
    try { localStorage.setItem(localTrailKey(), JSON.stringify(arr.slice(-LOCAL_TRAIL_CAP))); }
    catch (e) { log('warn', 'localStorage trilha cheio', e.message); }
}
function numOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
/** Normalize nRF Cloud / local trail item → rich snapshot-capable point. */
function normalizeLocItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const loc = (raw.location && typeof raw.location === 'object') ? raw.location
        : (raw.geo && typeof raw.geo === 'object') ? raw.geo
        : raw;
    const lat = numOrNull(loc.lat ?? loc.latitude ?? raw.lat ?? raw.latitude);
    const lon = numOrNull(loc.lon ?? loc.lng ?? loc.longitude ?? raw.lon ?? raw.lng ?? raw.longitude);
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const meta = raw.$meta || raw.meta || {};
    const at = raw.timestamp || raw.ts || raw.receivedAt || raw.insertedAt || raw.recordedAt
        || meta.updatedAt || meta.insertedAt || loc.timestamp || loc.ts || raw.at || null;
    const unc = numOrNull(
        raw.uncertainty ?? raw.unc ?? raw.accuracy
        ?? meta.acc ?? meta.uncertainty ?? loc.uncertainty ?? loc.accuracy
    );
    const serviceType = raw.serviceType || raw.service || loc.serviceType || raw.src || null;
    const out = {
        lat, lon,
        at: at ? String(at) : null,
        unc,
        serviceType,
        src: raw.src || raw._src || serviceType || null,
        battery: numOrNull(raw.battery ?? raw.batteryPct),
        batteryVoltage: numOrNull(raw.batteryVoltage ?? raw.batteryV),
        charging: (typeof raw.charging === 'boolean') ? raw.charging : null,
        connected: (typeof raw.connected === 'boolean') ? raw.connected : null,
        lastSeen: raw.lastSeen || null,
        temp: numOrNull(raw.temp),
        hum: numOrNull(raw.hum),
        press: numOrNull(raw.press),
        rsrp: numOrNull(raw.rsrp),
        operator: raw.operator || null,
        fw: raw.fw || raw.firmware || null,
    };
    return out;
}
function samePointRough(a, b) {
    if (!a || !b) return false;
    if (Number(a.lat).toFixed(5) === Number(b.lat).toFixed(5)
        && Number(a.lon).toFixed(5) === Number(b.lon).toFixed(5)) return true;
    return haversine(Number(a.lat), Number(a.lon), Number(b.lat), Number(b.lon)) < 15;
}
function dedupeConsecutive(points) {
    const out = [];
    for (const p of points) {
        if (!p) continue;
        const prev = out[out.length - 1];
        if (prev && samePointRough(prev, p)) continue;
        out.push(p);
    }
    return out;
}
function minuteKey(at) {
    if (!at) return null;
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM UTC
}
function voltToBatteryPct(v) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    let volts = Number(v);
    if (volts > 1000) volts = volts / 1000;
    return Math.max(0, Math.min(100, Math.round((volts - 3.2) / 1.0 * 100)));
}
function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
function sourceLabelPt(src) {
    const s = String(src || '').toLowerCase();
    if (!s) return '—';
    if (s.startsWith('wifi') || s === 'wifi') return 'Wi‑Fi';
    if (s.startsWith('cell') || s.includes('scell') || s.includes('mcell') || s.includes('cloud')) return 'Célula';
    if (s.includes('gnss') || s.includes('gps') || s === 'uart' || s === 'serial' || s === 'live') return 'GNSS';
    if (s === 'local' || s === 'trilha' || s === 'trail') return 'Local';
    if (s === 'cloud') return 'Célula';
    return s.slice(0, 16);
}
/** Prefer cloud coords when both exist for the same minute; keep richer snapshot fields. */
function mergeTrailPoints(cloudPts, localPts) {
    const byKey = new Map();
    for (const p of localPts || []) {
        const k = minuteKey(p.at) || `${Number(p.lat).toFixed(5)},${Number(p.lon).toFixed(5)}`;
        byKey.set(k, { ...p, _src: p._src || p.src || 'local' });
    }
    for (const p of cloudPts || []) {
        const k = minuteKey(p.at) || `${Number(p.lat).toFixed(5)},${Number(p.lon).toFixed(5)}`;
        const prev = byKey.get(k);
        if (prev) {
            byKey.set(k, {
                ...prev,
                ...p,
                // keep local telemetry when cloud only has coords
                battery: p.battery ?? prev.battery,
                batteryVoltage: p.batteryVoltage ?? prev.batteryVoltage,
                charging: (typeof p.charging === 'boolean') ? p.charging : prev.charging,
                connected: (typeof p.connected === 'boolean') ? p.connected : prev.connected,
                lastSeen: p.lastSeen || prev.lastSeen,
                temp: p.temp ?? prev.temp,
                hum: p.hum ?? prev.hum,
                press: p.press ?? prev.press,
                rsrp: p.rsrp ?? prev.rsrp,
                operator: p.operator || prev.operator,
                fw: p.fw || prev.fw,
                src: p.src || prev.src,
                _src: 'cloud',
            });
        } else {
            byKey.set(k, { ...p, _src: 'cloud' });
        }
    }
    return [...byKey.values()].sort((a, b) => {
        const ta = a.at ? new Date(a.at).getTime() : 0;
        const tb = b.at ? new Date(b.at).getTime() : 0;
        return ta - tb;
    });
}
/** Enrich cloud-only points with nearest local snapshot within ±2 minutes. */
function enrichWithLocalSnapshots(points, localRaw) {
    const locals = (localRaw || []).map(normalizeLocItem).filter(Boolean)
        .filter(p => p.at && (p.battery != null || p.connected != null || p.temp != null || p.rsrp != null || p.hum != null));
    if (!locals.length) return points;
    const withTs = locals.map(p => ({ p, t: new Date(p.at).getTime() })).filter(x => Number.isFinite(x.t))
        .sort((a, b) => a.t - b.t);
    const WIN = 2 * 60 * 1000;
    return (points || []).map(pt => {
        if (!pt || !pt.at) return pt;
        // already has telemetry
        if (pt.battery != null || pt.connected != null || pt.temp != null || pt.rsrp != null) return pt;
        const t = new Date(pt.at).getTime();
        if (!Number.isFinite(t)) return pt;
        let best = null, bestD = Infinity;
        for (const { p, t: lt } of withTs) {
            const d = Math.abs(lt - t);
            if (d <= WIN && d < bestD) { best = p; bestD = d; }
            if (lt > t + WIN) break;
        }
        if (!best) return pt;
        return {
            ...pt,
            battery: pt.battery ?? best.battery,
            batteryVoltage: pt.batteryVoltage ?? best.batteryVoltage,
            charging: (typeof pt.charging === 'boolean') ? pt.charging : best.charging,
            connected: (typeof pt.connected === 'boolean') ? pt.connected : best.connected,
            lastSeen: pt.lastSeen || best.lastSeen,
            temp: pt.temp ?? best.temp,
            hum: pt.hum ?? best.hum,
            press: pt.press ?? best.press,
            rsrp: pt.rsrp ?? best.rsrp,
            operator: pt.operator || best.operator,
            fw: pt.fw || best.fw,
            _enriched: true,
        };
    });
}
function trailDistanceKm(pts) {
    let m = 0;
    for (let i = 1; i < pts.length; i++) {
        m += haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    }
    return m / 1000;
}
function updateTrailPointsUI(n, km) {
    const on = trailEnabled ? 'ON' : 'OFF';
    setText(elements.trailStatus, on);
    const kmTxt = (km >= 10) ? km.toFixed(0) : km.toFixed(1);
    setText(elements.trailPoints, `Trilha ${on} · ${n} pts · ${kmTxt} km`);
}
function snapshotFieldsFrom(pt) {
    return {
        battery: pt.battery != null ? numOrNull(pt.battery) : null,
        batteryVoltage: pt.batteryVoltage != null ? numOrNull(pt.batteryVoltage) : null,
        charging: (typeof pt.charging === 'boolean') ? pt.charging : null,
        connected: (typeof pt.connected === 'boolean') ? pt.connected : null,
        lastSeen: pt.lastSeen || null,
        temp: pt.temp != null ? numOrNull(pt.temp) : null,
        hum: pt.hum != null ? numOrNull(pt.hum) : null,
        press: pt.press != null ? numOrNull(pt.press) : null,
        rsrp: pt.rsrp != null ? numOrNull(pt.rsrp) : null,
        operator: pt.operator || null,
        fw: pt.fw || null,
    };
}
/**
 * Dedup by UTC minute: one point per minute, unless moved >15 m (keep both).
 * Cap ~2000 in saveLocalTrailRaw.
 */
function accumulateLocalPoint(pt) {
    if (!pt || pt.lat == null || pt.lon == null || !config.deviceId) return;
    const store = loadLocalTrailRaw();
    const snap = snapshotFieldsFrom(pt);
    const norm = {
        lat: Number(pt.lat), lon: Number(pt.lon),
        at: pt.at || new Date().toISOString(),
        src: pt.src || pt._src || 'live',
        unc: pt.unc, serviceType: pt.serviceType || null,
        ...snap,
    };
    const mk = minuteKey(norm.at);
    // Find last point in same UTC minute
    let sameMinIdx = -1;
    if (mk) {
        for (let i = store.length - 1; i >= 0; i--) {
            const prevMk = minuteKey(store[i].at);
            if (prevMk === mk) { sameMinIdx = i; break; }
            if (prevMk && prevMk < mk) break;
        }
    }
    if (sameMinIdx >= 0) {
        const last = store[sameMinIdx];
        const moved = haversine(Number(last.lat), Number(last.lon), norm.lat, norm.lon);
        if (moved <= 15) {
            // same minute + close → refresh / merge richer fields
            store[sameMinIdx] = {
                ...last,
                ...norm,
                battery: snap.battery ?? last.battery,
                batteryVoltage: snap.batteryVoltage ?? last.batteryVoltage,
                charging: (typeof snap.charging === 'boolean') ? snap.charging : last.charging,
                connected: (typeof snap.connected === 'boolean') ? snap.connected : last.connected,
                lastSeen: snap.lastSeen || last.lastSeen,
                temp: snap.temp ?? last.temp,
                hum: snap.hum ?? last.hum,
                press: snap.press ?? last.press,
                rsrp: snap.rsrp ?? last.rsrp,
                operator: snap.operator || last.operator,
                fw: snap.fw || last.fw,
            };
            saveLocalTrailRaw(store);
            return;
        }
        // moved >15m in same minute → keep both (fall through to push)
    } else {
        const last = store[store.length - 1];
        if (last && samePointRough(last, norm) && (!mk || minuteKey(last.at) === mk)) {
            store[store.length - 1] = {
                ...last, at: norm.at || last.at, unc: norm.unc ?? last.unc,
                battery: snap.battery ?? last.battery,
                batteryVoltage: snap.batteryVoltage ?? last.batteryVoltage,
                charging: (typeof snap.charging === 'boolean') ? snap.charging : last.charging,
                connected: (typeof snap.connected === 'boolean') ? snap.connected : last.connected,
                lastSeen: snap.lastSeen || last.lastSeen,
                temp: snap.temp ?? last.temp,
                hum: snap.hum ?? last.hum,
                press: snap.press ?? last.press,
                rsrp: snap.rsrp ?? last.rsrp,
                operator: snap.operator || last.operator,
                fw: snap.fw || last.fw,
                src: norm.src || last.src,
            };
            saveLocalTrailRaw(store);
            return;
        }
    }
    store.push(norm);
    saveLocalTrailRaw(store);
}
function buildTrailPopupHtml(pt) {
    const dash = '—';
    let hora = dash;
    if (pt.at) {
        const d = new Date(pt.at);
        if (!Number.isNaN(d.getTime())) {
            hora = d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
        }
    }
    const lat = Number(pt.lat).toFixed(6);
    const lon = Number(pt.lon).toFixed(6);
    let bat = dash;
    const pct = pt.battery != null ? Number(pt.battery) : voltToBatteryPct(pt.batteryVoltage);
    if (pct != null && Number.isFinite(pct)) {
        bat = `${Math.round(pct)}%`;
        if (pt.batteryVoltage != null) {
            let v = Number(pt.batteryVoltage);
            if (v > 1000) v /= 1000;
            bat += ` (${v.toFixed(2)} V)`;
        }
        if (pt.charging === true) bat += ' · carregando';
        else if (pt.charging === false) bat += ' · não carrega';
    }
    let status = dash;
    if (pt.connected === true) status = 'Ligado/Conectado';
    else if (pt.connected === false) status = 'Offline';
    const ambParts = [];
    if (pt.temp != null) ambParts.push(`${Number(pt.temp).toFixed(1)} °C`);
    if (pt.hum != null) ambParts.push(`${Number(pt.hum).toFixed(1)}% UR`);
    if (pt.press != null) {
        const ph = typeof normalizePressHpa === 'function' ? normalizePressHpa(pt.press) : pt.press;
        if (ph != null) ambParts.push(`${Number(ph).toFixed(1)} hPa`);
    }
    const ambiente = ambParts.length ? ambParts.join(' · ') : dash;
    const redeParts = [];
    if (pt.rsrp != null) redeParts.push(`${pt.rsrp} dBm`);
    if (pt.operator) redeParts.push(String(pt.operator));
    const rede = redeParts.length ? redeParts.join(' · ') : dash;
    const fonte = sourceLabelPt(pt.serviceType || pt.src || pt._src);
    const fw = pt.fw ? escHtml(pt.fw) : dash;
    return `<div class="trail-popup">
<strong>Horário</strong> ${escHtml(hora)}<br>
<strong>Lat / Lon</strong> ${escHtml(lat)} / ${escHtml(lon)}<br>
<strong>Bateria</strong> ${escHtml(bat)}<br>
<strong>Status</strong> ${escHtml(status)}<br>
<strong>Ambiente</strong> ${escHtml(ambiente)}<br>
<strong>Rede</strong> ${escHtml(rede)}<br>
<strong>Fonte</strong> ${escHtml(fonte)}
${pt.fw ? `<br><strong>FW</strong> ${fw}` : ''}
</div>`;
}
function clearTrailMarkers() {
    if (trailMarkersLayer) trailMarkersLayer.clearLayers();
}
function renderTrailMarkers(points) {
    if (!map) return;
    if (!trailMarkersLayer) trailMarkersLayer = L.layerGroup().addTo(map);
    clearTrailMarkers();
    if (!trailEnabled || !points || !points.length) return;
    const n = points.length;
    points.forEach((pt, i) => {
        if (!pt || pt.lat == null || pt.lon == null) return;
        const isLatest = i === n - 1;
        const cm = L.circleMarker([Number(pt.lat), Number(pt.lon)], {
            radius: isLatest ? 8 : 4,
            color: isLatest ? '#E20074' : '#0984e3',
            weight: isLatest ? 2 : 1,
            fillColor: isLatest ? '#E20074' : '#74b9ff',
            fillOpacity: isLatest ? 0.95 : 0.75,
            opacity: 0.9,
        });
        cm.bindPopup(buildTrailPopupHtml(pt), { maxWidth: 280, className: 'trail-popup-wrap' });
        cm.on('click', () => { try { cm.openPopup(); } catch { /* ignore */ } });
        trailMarkersLayer.addLayer(cm);
    });
}
function applyTrailPoints(points) {
    const deduped = dedupeConsecutive((points || []).filter(p => p && p.lat != null && p.lon != null));
    lastTrail = deduped;
    const latlngs = deduped.map(p => [Number(p.lat), Number(p.lon)]);
    if (trailLine) trailLine.setLatLngs(trailEnabled ? latlngs : []);
    renderTrailMarkers(trailEnabled ? deduped : []);
    const km = trailDistanceKm(deduped);
    updateTrailPointsUI(deduped.length, km);
    if (trailEnabled && map && latlngs.length >= 2 && latlngs.length !== lastTrailFitCount) {
        try {
            map.fitBounds(trailLine.getBounds(), { padding: [40, 40], maxZoom: 14 });
            lastTrailFitCount = latlngs.length;
        } catch { /* bounds invalid */ }
    }
    return deduped;
}
function applyPositionFromPoint(pt, srcLabel) {
    if (!pt || pt.lat == null || pt.lon == null) return false;
    const lat = Number(pt.lat), lon = Number(pt.lon);
    setText(elements.gpsCoords, `${lat.toFixed(6)}, ${lon.toFixed(6)}`);
    setText(elements.gpsLat, lat.toFixed(6));
    setText(elements.gpsLon, lon.toFixed(6));
    if (pt.unc != null) setText(elements.gpsAcc, `${Math.round(pt.unc)} m`);
    setGpsSourceBadge(srcLabel || pt.serviceType || pt.src || 'trail');
    updateMap(lat, lon, pt.unc, { skipZoom: (lastTrail.length >= 2), appendTrail: false });
    checkGeofence(lat, lon);
    return true;
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
    if (!config.apiKey) { lastPollAuthFail = true; updateAuthBanner(); showModal(); return; }
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
        parsed = mergeCloudNetwork(parsed, fromMsg);
        if (fromMsg.rsrp != null || fromMsg.mccMnc || fromMsg.netSourceHint) telemetrySource.net = telemetrySource.net || 'cloud';
        const overlay = applySerialOverlay(fromMsg, parsed, serial || lastSerial);
        fromMsg = overlay.fromMsg; parsed = overlay.parsed;
        const ser = serial || lastSerial;
        const healthy = serialIsHealthy(ser);
        const hasGps = fromMsg.gps?.lat != null && fromMsg.gps?.lon != null;
        // Live fix → rich snapshot for trail (1 pt/min; clickable device state)
        if (hasGps) {
            const batNorm = normalizeBatteryFields(fromMsg.batteryV ?? parsed.batteryV, fromMsg.batteryPct ?? parsed.batteryPct);
            const batV = batNorm.volts;
            const batPct = batNorm.pct;
            let charging = null;
            try {
                const batObj = lastDeviceRaw?.state?.reported?.device?.batteryStatus
                    || lastDeviceRaw?.state?.reported?.battery || null;
                if (batObj && typeof batObj.charging === 'boolean') charging = batObj.charging;
                else if (batObj && typeof batObj.chargerConnected === 'boolean') charging = batObj.chargerConnected;
            } catch { /* ignore */ }
            accumulateLocalPoint({
                lat: fromMsg.gps.lat, lon: fromMsg.gps.lon,
                at: fromMsg.latestAt || new Date().toISOString(),
                src: fromMsg.gps.source || telemetrySource.gps || 'live',
                unc: fromMsg.gps.accuracy,
                serviceType: fromMsg.gps.source || null,
                battery: batPct,
                batteryVoltage: batV != null ? (Number(batV) > 1000 ? Number(batV) / 1000 : Number(batV)) : null,
                charging,
                connected: typeof parsed.connected === 'boolean' ? parsed.connected : null,
                lastSeen: parsed.lastSeen || fromMsg.latestAt || null,
                temp: fromMsg.temp ?? null,
                hum: fromMsg.hum ?? null,
                press: fromMsg.press != null ? (normalizePressHpa(fromMsg.press) ?? fromMsg.press) : null,
                rsrp: fromMsg.rsrp ?? parsed.rsrp ?? null,
                operator: parsed.operator || null,
                fw: parsed.firmware && parsed.firmware !== '—' ? parsed.firmware : null,
            });
        }
        // Posição headline: calm/actionable; avoid scary Simple Token nag when serial healthy
        if (!hasGps) {
            setGpsSourceBadge(null);
            const src = ser?.locationSource || '';
            const aps = Array.isArray(ser?.wifiAps) ? ser.wifiAps.length : (ser?.wifiApCount || 0);
            // Fallback chain for github.io (no serial): trail last → local store
            const trailLast = lastTrail.length ? lastTrail[lastTrail.length - 1] : null;
            const localRaw = loadLocalTrailRaw();
            const localLast = localRaw.length ? normalizeLocItem(localRaw[localRaw.length - 1]) : null;
            const fallback = trailLast || localLast;
            if (fallback && applyPositionFromPoint(fallback, fallback.serviceType || fallback.src || 'trilha')) {
                // position shown from history/local
            } else if (!healthy) {
                setText(elements.gpsCoords, (location.hostname.includes('github.io') || location.hostname.includes('netlify')) ? 'Sem fix — configure as chaves na engrenagem (cloud). USB só no Mac.' : 'Sem fix — conecte o USB ou aguarde scan Wi‑Fi/célula');
            } else if (src === 'cloud_pending' || /loc_cloud|pending/i.test(ser?.rawNotes || '')) {
                setText(elements.gpsCoords, 'Sem fix — pedido Wi‑Fi/célula na nuvem (ainda sem coordenadas)');
            } else if (aps >= 2) {
                setText(elements.gpsCoords, 'Sem fix — resolvendo Wi‑Fi…');
            } else if (ser?.mcc != null && (ser?.eciDec != null || ser?.tacDec != null)) {
                setText(elements.gpsCoords, 'Sem fix — resolvendo célula…');
            } else {
                setText(elements.gpsCoords, 'Sem fix — aguarde scan Wi‑Fi/célula ou céu aberto (GNSS)');
            }
        }
        if (lastConnected !== null && lastConnected !== parsed.connected)
            log(parsed.connected ? 'ok' : 'warn', parsed.connected ? 'CONECTOU' : 'DESCONECTOU', parsed.session || '');
        lastConnected = parsed.connected;
        const on = parsed.connected === true;
        lastPollAuthFail = false;
        updateAuthBanner();
        setStatus(on, on ? 'Conectado' : parsed.connected === false ? 'Offline' : 'Desconhecido');
        updateConnPanel({ connected: parsed.connected, lastSeen: parsed.lastSeen, lastMsg: fromMsg.latestAt || serial?.updatedAt, msgCount: messages.length, latency });
        updateUI(parsed, fromMsg); renderMsgTable(messages); updateSourceBadge();
        const apps = Object.keys(fromMsg.byApp || {});
        const st = lastTrail.length ? [...new Set(lastTrail.map(t => t.serviceType).filter(Boolean))].join(',') : '';
        if (st) setText(elements.serviceType, st);
        const src = overlay.used ? ' +serial' : '';
        log('info', `Poll OK · ${messages.length} msgs [${apps.join(',') || '-'}]${src} · ${timeAgo(fromMsg.latestAt || parsed.lastSeen)}`, `fw ${parsed.firmware} · ${latency}ms · poll ${POLL_MS / 1000}s`);
        if (parsed.connected === false) log('warn', 'connected=false — sem MQTT. Cheque LTE/SIM/bateria.');
        // Refresh trail every successful poll (failures logged once)
        await loadTrail({ quiet: true });
    } catch (e) {
        const isAuth = /401|403|Nenhuma chave|Chave rejeitada|Sem API key/i.test(e.message);
        const short = isAuth ? 'Erro: 401 — configure a engrenagem neste celular' : `Erro: ${e.message.slice(0, 48)}`;
        log('err', `Poll: ${e.message}`);
        setStatus(false, short);
        if (isAuth) {
            lastPollAuthFail = true;
            updateAuthBanner();
            showModal();
        }
    }
}
async function loadTrail(opts = {}) {
    if (!config.deviceId || !trailEnabled) {
        updateTrailPointsUI(lastTrail.length, trailDistanceKm(lastTrail));
        return;
    }
    const quiet = !!opts.quiet;
    const hours = Number(elements.trailRange?.value || 168);
    let cloudItems = [];
    let cloudOk = false;
    let cloudErr = null;
    try {
        if (!quiet) log('info', `Trilha ${hours}h…`);
        cloudItems = await getLocationHistory(config.deviceId, hours);
        cloudOk = true;
        trailFailLogged = false;
    } catch (e) {
        cloudErr = e;
        if (!trailFailLogged) {
            trailFailLogged = true;
            const needsTeam = /401|403/.test(e.message);
            if (needsTeam) {
                log('warn', 'Trilha precisa da API Key da equipe (Simple Token) na engrenagem');
            } else {
                log('warn', `Trilha: ${e.message}`);
            }
        }
    }
    const cloudPts = (cloudItems || []).map(normalizeLocItem).filter(Boolean);
    // Seed local store from cloud (coords only — don't wipe rich local snapshots)
    for (const p of cloudPts) {
        accumulateLocalPoint({ ...p, src: p.src || 'cloud' });
    }
    const cutoff = Date.now() - hours * 3600 * 1000;
    const localRaw = loadLocalTrailRaw();
    const localPts = localRaw
        .map(normalizeLocItem)
        .filter(Boolean)
        .filter(p => !p.at || new Date(p.at).getTime() >= cutoff);
    let merged = dedupeConsecutive(mergeTrailPoints(cloudPts, localPts));
    merged = enrichWithLocalSnapshots(merged, localRaw);
    const applied = applyTrailPoints(merged);
    const sts = [...new Set(applied.map(i => i.serviceType).filter(Boolean))];
    if (sts.length) setText(elements.serviceType, sts.join(', '));
    // Position from last history/local when useful (Pages without USB / no live fix)
    const last = applied[applied.length - 1];
    if (last) {
        const gpsEl = elements.gpsCoords?.textContent || '';
        const noFix = !gpsEl || gpsEl === '—' || /Sem fix/i.test(gpsEl);
        if (noFix) applyPositionFromPoint(last, last.serviceType || last._src || 'trilha');
    }
    // Keep geofence + situação in sync with trail-derived position
    try {
        const lat = last?.lat ?? marker?.getLatLng()?.lat;
        const lon = last?.lon ?? marker?.getLatLng()?.lng;
        refreshGeofenceUi(lat, lon);
    } catch { refreshGeofenceUi(null, null); }
    updateSituacaoLine({
        alias: getDeviceAlias(config.deviceId),
        connected: lastConnected,
        batteryPct: null,
        trailPts: applied.length,
    });
    if (!quiet) {
        if (applied.length) log('ok', `Trilha: ${applied.length} pts · ${trailDistanceKm(applied).toFixed(1)} km [${sts.join(',') || '?'}]`);
        else if (cloudOk) log('warn', 'Trilha vazia no período — aguardando fixes (local + nuvem)');
        else if (cloudErr) { /* already logged once */ }
    }
}
function init() {
    updateAuthBanner();
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
elements.saveConfig?.addEventListener('click', () => { saveConfig(); });
elements.cancelConfig?.addEventListener('click', hideModal);
elements.closeModal?.addEventListener('click', hideModal);
elements.configBtn?.addEventListener('click', showModal);
elements.authBannerBtn?.addEventListener('click', showModal);
elements.copyPairingLink?.addEventListener('click', () => { copyPairingLink(); });
elements.connectionStatus?.addEventListener('click', () => {
    if (elements.connectionStatus?.classList.contains('error') || !config.apiKey || lastPollAuthFail) showModal();
});
elements.centerMap?.addEventListener('click', () => { try { map.setView(marker.getLatLng(), 15); } catch { log('warn', 'Sem posição ainda'); } });
elements.toggleTrail?.addEventListener('click', () => {
    trailEnabled = !trailEnabled;
    updateTrailPointsUI(lastTrail.length, trailDistanceKm(lastTrail));
    log('info', `Trilha ${trailEnabled ? 'ON' : 'OFF'}`);
    if (!trailEnabled) { trailLine?.setLatLngs([]); clearTrailMarkers(); lastTrailFitCount = 0; }
    else { lastTrailFitCount = 0; loadTrail(); }
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
        localStorage.setItem('thingy_geo', JSON.stringify(geo));
        restoreGeofence();
        refreshGeofenceUi(p.lat, p.lng);
        log('ok', 'Geofence definido', `${geo.lat},${geo.lon} r=${geo.radius}m`);
    } catch { log('warn', 'Sem posição para geofence'); }
});
elements.geoClear?.addEventListener('click', () => {
    geo = null; localStorage.removeItem('thingy_geo');
    if (geoCircle && map) map.removeLayer(geoCircle); geoCircle = null;
    setText(elements.geoState, 'Sem cerca definida.'); if (elements.geoState) elements.geoState.style.color = ''; log('info', 'Geofence limpo');
});
if (elements.geoRadius && geo) elements.geoRadius.value = geo.radius;
if (geo && elements.geoState) setText(elements.geoState, 'Cerca ativa — aguardando fix.');
else if (elements.geoState) setText(elements.geoState, 'Sem cerca definida.');

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
    const gj = { type: 'FeatureCollection', features: lastTrail.filter(t => t.lat != null && t.lon != null).map(t => ({ type: 'Feature', properties: { recordedAt: t.at, serviceType: t.serviceType, acc: t.unc, src: t._src || t.src }, geometry: { type: 'Point', coordinates: [Number(t.lon), Number(t.lat)] } })) };
    download(`thingy91x-trail-${Date.now()}.geojson`, JSON.stringify(gj, null, 2)); log('info', 'GeoJSON exportado');
});
elements.exportShadow?.addEventListener('click', () => {
    if (!lastDeviceRaw) return log('warn', 'Sem shadow — aguarde poll');
    download(`thingy91x-shadow-${Date.now()}.json`, JSON.stringify(lastDeviceRaw, null, 2)); log('info', 'Shadow exportado');
});

function commitAliasFromHero() {
    if (!elements.deviceName) return;
    const v = setDeviceAlias(config.deviceId, elements.deviceName.textContent);
    elements.deviceName.textContent = v;
    updateSituacaoLine({ alias: v });
    log('ok', 'Nome operacional salvo', v);
}
elements.copyDeviceId?.addEventListener('click', async () => {
    const id = elements.deviceId?.textContent?.trim() || config.deviceId || '';
    if (!id || id === '—' || id === '-') return log('warn', 'Sem UUID para copiar');
    try {
        await navigator.clipboard.writeText(id);
        if (elements.copyDeviceId) {
            elements.copyDeviceId.classList.add('copied');
            elements.copyDeviceId.textContent = 'Copiado';
            setTimeout(() => {
                elements.copyDeviceId.classList.remove('copied');
                elements.copyDeviceId.textContent = 'Copiar';
            }, 1200);
        }
        log('ok', 'UUID copiado');
    } catch (e) {
        log('warn', 'Falha ao copiar UUID', e.message);
    }
});
elements.aliasEditBtn?.addEventListener('click', () => {
    if (!elements.deviceName) return;
    elements.deviceName.focus();
    try {
        const range = document.createRange();
        range.selectNodeContents(elements.deviceName);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    } catch { /* ignore */ }
});
elements.deviceName?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); elements.deviceName.blur(); }
    if (e.key === 'Escape') {
        e.preventDefault();
        applyAliasToHero(config.deviceId);
        elements.deviceName.blur();
    }
});
elements.deviceName?.addEventListener('blur', commitAliasFromHero);

document.addEventListener('DOMContentLoaded', () => {

    log('info', 'Dashboard v2 + serial bridge', NRF_CLOUD_BASE);
    // Pairing link Mac→phone: #cfg=base64url(JSON) — before init
    importConfigFromHash();
    if ('serviceWorker' in navigator) {
        const swHref = new URL('service-worker.js?v=22', document.baseURI || location.href).href;
        // Limpa caches antigos (Cmd+Shift+R no Safari muitas vezes não basta)
        const bustKey = 'thingy_sw_bust_v22';
        caches.keys().then(keys => Promise.all(keys.filter(k => k !== 'thingy91x-v22').map(k => caches.delete(k)))).catch(() => {});
        navigator.serviceWorker.getRegistrations().then(async regs => {
            for (const r of regs) {
                try { await r.update(); } catch { /* ignore */ }
            }
            try {
                await navigator.serviceWorker.register(swHref);
            } catch { /* ignore */ }
            if (!sessionStorage.getItem(bustKey)) {
                sessionStorage.setItem(bustKey, '1');
                // um reload só nesta aba após limpar SW velho
                const controlling = navigator.serviceWorker.controller;
                if (controlling) {
                    setTimeout(() => location.reload(), 400);
                }
            }
        }).catch(() => {});
    }
    updateAuthBanner();
    init(); loadFleet(false);
});
