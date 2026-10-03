/* Thingy:91X Dashboard v33 — UMA fonte de presença (presence-core.js: last_seen + mensagens + localização + shadow $meta);
 * v31 evidência só da nuvem; v30 diagnóstico de localização; v29 presença CoAP-safe
 * Dual proxy (Memfault + nRF Cloud):
 *  GET  /devices?pageLimit=100     -> Memfault .../devices
 *  GET  /devices/{id}              -> Memfault device + attributes + nRF FetchDevice(state)
 *  GET  /messages?deviceId=…       -> nRF Cloud /v1/messages (telemetry)
 *  GET  /location/history?…        -> nRF Cloud /v1/location/history (trail)
 *  GET  alerts?deviceId=…          -> Netlify on-demand alert rules (Pages)
 * Auth: Memfault Basic/OAT + optional team Simple Token (X-Nrf-Team-Key) for msgs/GPS
 * Writes: prefer NRF_TEAM_WRITE_TOKEN on Netlify; fallback X-Nrf-Team-Key. Still 501: legacy FOTA
 */
// API base by host:
//  - localhost / 127.0.0.1          → /api (local Express)
//  - *.netlify.app                  → /.netlify/functions/nrfcloud
//  - *.github.io / other public HTTPS → absolute Netlify function (CORS)
//  - trycloudflare / same-origin tunnel → /api
const NETLIFY_FN = 'https://thingy91x-x-dashboard.netlify.app/.netlify/functions/nrfcloud';
const NETLIFY_ALERTS = 'https://thingy91x-x-dashboard.netlify.app/.netlify/functions/alerts';
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
function resolveAlertsUrl() {
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1') return null; // client-only on local
    if (/netlify\.app$/i.test(h)) return '/.netlify/functions/alerts';
    return NETLIFY_ALERTS;
}

const DEVICE_DEFAULT = '50423451-3737-4337-80fc-110bddf418ff';
let config = {
    apiKey: localStorage.getItem('nrf_api_key') || '',
    teamApiKey: localStorage.getItem('nrf_team_api_key') || '',
    email: localStorage.getItem('nrf_user_email') || '',
    orgSlug: localStorage.getItem('nrf_org_slug') || 'telekom',
    projectSlug: localStorage.getItem('nrf_project_slug') || 'nrf-project',
    deviceId: localStorage.getItem('nrf_device_id') || DEVICE_DEFAULT
};
let map, marker, accuracyCircle = null, trailMarkersLayer = null, trailEnabled = true;
let fleetMarkers = [];
let pollInterval = null;
function resolvePollMs() {
    const h = location.hostname;
    // Local / tunnel: faster poll helps USB serial overlay
    if (h === 'localhost' || h === '127.0.0.1' || /trycloudflare\.com$/i.test(h)) return 10000;
    // github.io + other public HTTPS via Netlify API: polite but visible refresh
    return 20000;
}
const POLL_MS = resolvePollMs();
let lastConnected = null, lastSeenTs = null, lastBatteryPct = null;
let lastGpsFix = null; // { lat, lon, at }
/** v30: why there is no position — msgs/hist: 'ok' | 'auth' | 'err' | null; histCount = pts from cloud. */
let cloudLocState = { msgs: null, hist: null, histCount: 0, hours: 168 };
let lastBatteryAt = null;
let lastIntelAlerts = [];
/** Thresholds for remote intelligence (v25) — tunable constants. */
const INTEL = {
    OFFLINE_STALE_MS: 60 * 60 * 1000,   // v29: offline only past sleeping max (60min)
    DATA_STALE_MS: 30 * 60 * 1000,      // gps/net age
    BATTERY_LOW: 20,
    BATTERY_CRIT: 10,
    RSRP_WEAK: -110,
    TRAIL_SPARSE_HOURS: 6,
    TRAIL_SPARSE_MIN_PTS: 3,
    BAT_MIN_SAMPLES: 4,
    BAT_MIN_SPAN_MS: 2 * 3600 * 1000,   // 2h
    MOVE_SPEED_KMH: 1.5,
    MOVE_DISP_M: 40,
    MOVE_WINDOW_MS: 20 * 60 * 1000,
    STOP_MIN_MS: 10 * 60 * 1000,
    STOP_RADIUS_M: 50,
    ALERTS_MAX: 5,
};
/** v29 CoAP-safe presence: activity timestamps, not MQTT connected flag. */
const PRESENCE = {
    MIN_ONLINE_MS: 15 * 60 * 1000,
    INTERVAL_FACTOR: 2.5,
    SLEEPING_MAX_MS: 60 * 60 * 1000,
};
let lastPresence = null;
/** v32: evidência de presença vinda da NUVEM (não conta poll, USB nem cache local). */
let lastCloudLocs = [];          // pontos do location/history (nuvem) normalizados
let lastMemfaultSeen = null;     // last_seen do Memfault (não é o "último dado" exibido)
let lastParsed = null, lastFromMsg = null;
let pollBusy = false, rateLimitedUntil = 0, lastTrailFetchAt = 0;
const TRAIL_REFRESH_MS = 60 * 1000;       // só a página mais nova a cada 60s
const TRAIL_FULL_REFRESH_MS = 10 * 60 * 1000;
const APP_HISTORY_MS = 5 * 60 * 1000;     // BATTERY/TEMP/HUMID/AIR_PRESS por appId
const TZ = 'America/Sao_Paulo';
let deviceList = [], lastDeviceRaw = null, lastMessages = [], lastTrail = [], lastSerial = null;
let trailFailLogged = false, lastTrailFitCount = 0, lastTrailAll = [];
let playbackGhost = null;
let playback = { playing: false, speed: 1, index: 0, timer: null };
let lastServerAlerts = [];
let serverAlertsTimer = null;
const LOCAL_TRAIL_CAP = 2000;
let telemetrySource = { env: null, battery: null, net: null, gps: null };
let geo = JSON.parse(localStorage.getItem('thingy_geo') || 'null');
let geoCircle = null, geoInside = null;
const logCount = { api: 0, err: 0 };
let lastPollAuthFail = false;
let lastSuccessfulPollAt = null;
let lastNetPayloadAt = null;
let stripRefreshing = false;
let connectivityAgeTimer = null;
let lastStripContext = null;

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
    situacaoBand: $('situacaoBand'), sitEstado: $('sitEstado'), sitOnde: $('sitOnde'),
    sitRisco: $('sitRisco'), sitRiscoReason: $('sitRiscoReason'), sitAcao: $('sitAcao'),
    sitAlertas: $('sitAlertas'), sitCellEstado: $('sitCellEstado'), sitCellOnde: $('sitCellOnde'),
    sitCellRisco: $('sitCellRisco'), sitCellAcao: $('sitCellAcao'),
    trailIntel: $('trailIntel'), batteryAutonomia: $('batteryAutonomia'),
    playbackBar: $('playbackBar'), playbackPlay: $('playbackPlay'), playbackSpeed: $('playbackSpeed'),
    playbackScrub: $('playbackScrub'), playbackChip: $('playbackChip'),
    sparkBat: $('sparkBat'), sparkRsrp: $('sparkRsrp'), sparkBatSit: $('sparkBatSit'), sparkRsrpSit: $('sparkRsrpSit'),
    envAge: $('envAge'), batteryAge: $('batteryAge'), gpsAge: $('gpsAge'), netAge: $('netAge'),
    netEmptyHint: $('netEmptyHint'), motionEmptyHint: $('motionEmptyHint'),
    motionSpeedWrap: $('motionSpeedWrap'), motionSpeed: $('motionSpeed'),
    connectivityStrip: $('connectivityStrip'), cardNetwork: $('cardNetwork'),
    stripCloud: $('stripCloud'), stripCell: $('stripCell'), stripQuality: $('stripQuality'),
    stripLastPoll: $('stripLastPoll'), stripNetAge: $('stripNetAge'), stripNetSrc: $('stripNetSrc'), stripPollMs: $('stripPollMs'),
    stripHint: $('stripHint'), stripRefreshStatus: $('stripRefreshStatus'),
    refreshNowBtn: $('refreshNowBtn'),
};
function setText(el, v) { if (el) el.textContent = v; }
/* ---------- Fuso America/Sao_Paulo (v32) ---------- */
function fmtDateTime(ts, opts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('pt-BR', Object.assign({ timeZone: TZ }, opts || {}));
}
function fmtTime(ts, opts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('pt-BR', Object.assign({ timeZone: TZ, hour12: false }, opts || {}));
}
function ymdSP(ts) { return new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ }); }
/** Meia-noite de hoje em São Paulo (UTC-3 fixo: o Brasil não tem horário de verão desde 2019). */
function startOfTodaySP() { return Date.parse(`${ymdSP(Date.now())}T00:00:00-03:00`); }

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
    const time = fmtTime(entry.ts);
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
    const base = 'https://guilhermeromio-netto-prog.github.io/thingy91x-dashboard/?v=33#cfg=';
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

function toTsMs(v) { return PresenceCore.toTsMs(v); }
/** ATT config intervals are usually seconds; values >10000 treated as ms. */
function pickSampleIntervalSec(src) {
    const configs = [
        src?.config,
        src?.sampleIntervalSec != null ? { update_interval: src.sampleIntervalSec } : null,
        src?.state?.reported?.config,
        src?.state?.desired?.config,
        src?.reported?.config,
        lastDeviceRaw?.state?.reported?.config,
        lastDeviceRaw?.state?.desired?.config,
    ];
    for (const cfg of configs) {
        if (!cfg || typeof cfg !== 'object') continue;
        for (const k of ['update_interval', 'sample_interval', 'gpsInterval']) {
            const n = Number(cfg[k]);
            if (Number.isFinite(n) && n > 0) return n > 10000 ? Math.round(n / 1000) : Math.round(n);
        }
    }
    return null;
}
function onlineWindowMs(intervalSec) { return PresenceCore.onlineWindowMs(intervalSec); }
/** Timestamp mais recente do shadow ($meta) — evidência da nuvem, separada do last_seen do Memfault. */
function shadowMetaOf(raw) {
    const c = [raw?.$meta?.updatedAt, raw?._nrf?.$meta?.updatedAt, raw?._shadowMeta].map(toTsMs).filter(x => x != null);
    return c.length ? new Date(Math.max(...c)).toISOString() : null;
}
/**
 * v32 — ÚNICA função de presença do front (header, strip, situação, alertas, popups, frota).
 * Delegada a presence-core.js (o mesmo código roda em nrfcloud.js / alerts.js / proxy.js).
 * Por padrão usa as mensagens e a localização da NUVEM do aparelho atual; para outros
 * aparelhos (frota) passe msgs: [] e locs: [].
 */
function resolvePresence(opts = {}) {
    const intervalSec = opts.intervalSec != null
        ? opts.intervalSec
        : pickSampleIntervalSec(opts.parsed || opts.device || opts);
    const cc = (opts.cloudConnected === true || opts.connected === true) ? true
        : ((opts.cloudConnected === false || opts.connected === false) ? false : null);
    return PresenceCore.resolve({
        lastSeen: opts.lastSeen !== undefined ? opts.lastSeen : lastMemfaultSeen,
        shadowMeta: opts.shadowMeta !== undefined ? opts.shadowMeta : shadowMetaOf(lastDeviceRaw),
        messages: opts.msgs || opts.messages || lastMessages,
        locations: opts.locs || opts.locations || lastCloudLocs,
        cloudConnected: cc,
        intervalSec,
    });
}
function formatPresenceAge(p) { return PresenceCore.formatSendAge(p); }
function presenceWithAgeLabel(p) {
    if (!p) return '—';
    const age = formatPresenceAge(p);
    return age ? `${p.label} · ${age}` : p.label;
}
function presenceTooltip(p) { return PresenceCore.describe(p, ms => fmtDateTime(ms)); }
function presenceFromParsed(parsed = {}, fromMsg = {}, extra = {}) {
    const cloudConnected = (parsed.connected === true || parsed.cloudConnected === true) ? true : null;
    return resolvePresence({
        cloudConnected,
        lastSeen: parsed.lastSeen !== undefined ? parsed.lastSeen : lastMemfaultSeen,
        shadowMeta: parsed.shadowMeta !== undefined ? parsed.shadowMeta : undefined,
        msgs: extra.msgs || lastMessages,
        intervalSec: parsed.sampleIntervalSec,
        parsed,
    });
}
/** Recalcula e repinta TUDO que depende de presença (chamado após poll e após a trilha/localização chegar). */
function refreshPresenceUi() {
    if (!config.apiKey || !lastParsed) return;
    const parsed = lastParsed, fromMsg = lastFromMsg || {};
    const presence = presenceFromParsed(parsed, fromMsg);
    lastPresence = presence;
    lastConnected = presence.connectedBool;
    setStatus(presence, buildHeaderConnLabel(presence, parsed, fromMsg));
    updateConnPanel({ connected: presence.connectedBool, presence, lastSeen: presence.activityAt || parsed.lastSeen,
        lastMsg: fromMsg.latestAt || null, msgCount: lastMessages.length, latency: lastLatencyMs });
    updateConnectivityStrip({ connected: presence.connectedBool, presence, parsed, fromMsg });
    updateSituacaoInteligente({ presence, connected: presence.connectedBool, trailPts: lastTrail });
    if (elements.lastSeen) {
        elements.lastSeen.textContent = presence.activityAt ? fmtDateTime(presence.activityAt) : '-';
        elements.lastSeen.title = presenceTooltip(presence);
    }
    lastSeenTs = presence.activityAt || lastSeenTs;
    return presence;
}
let lastLatencyMs = null;

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
    el.title = fmtDateTime(ts);
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
/* ---------- Inteligência remota v25 ---------- */
function ageMs(ts) {
    if (!ts) return null;
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t)) return null;
    return Date.now() - t;
}
function formatHoursLeft(h) {
    if (h == null || !Number.isFinite(h) || h < 0) return null;
    if (h < 1) return `~${Math.max(1, Math.round(h * 60))}min`;
    if (h < 24) return `~${h < 10 ? h.toFixed(1) : Math.round(h)}h`;
    return `~${(h / 24).toFixed(1)}d`;
}
function shortCoords(lat, lon) {
    return `${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)}`;
}
/** Battery drain %/h from trail/local snapshots — never invents. */
function estimateBatteryDrain(trailPts, currentPct) {
    const pts = (trailPts || [])
        .map(p => {
            const at = p.at ? new Date(p.at).getTime() : NaN;
            let pct = p.battery != null ? Number(p.battery) : voltToBatteryPct(p.batteryVoltage);
            if (pct == null || !Number.isFinite(pct) || !Number.isFinite(at)) return null;
            if (p.charging === true) return null; // skip charging samples
            return { at, pct: Math.round(pct) };
        })
        .filter(Boolean)
        .sort((a, b) => a.at - b.at);
    // keep last ~48h
    const cutoff = Date.now() - 48 * 3600 * 1000;
    const recent = pts.filter(p => p.at >= cutoff);
    if (recent.length < INTEL.BAT_MIN_SAMPLES) {
        return { ok: false, reason: 'sem histórico suficiente' };
    }
    const first = recent[0], last = recent[recent.length - 1];
    const span = last.at - first.at;
    if (span < INTEL.BAT_MIN_SPAN_MS) {
        return { ok: false, reason: 'sem histórico suficiente' };
    }
    const drop = first.pct - last.pct;
    if (drop <= 0.5) {
        // flat or charging overall — cannot estimate drain
        return { ok: false, reason: 'sem histórico suficiente' };
    }
    const hours = span / 3600000;
    const rate = drop / hours; // %/h
    if (!Number.isFinite(rate) || rate <= 0.05) {
        return { ok: false, reason: 'sem histórico suficiente' };
    }
    const pctNow = currentPct != null ? Number(currentPct) : last.pct;
    const hoursLeft = pctNow / rate;
    return {
        ok: true,
        ratePctPerHour: rate,
        hoursLeft,
        samples: recent.length,
        spanHours: hours,
    };
}
function updateBatteryAutonomia(est) {
    const el = elements.batteryAutonomia;
    if (!el) return;
    el.classList.remove('has-estimate', 'warn');
    if (!est || !est.ok) {
        el.textContent = 'Autonomia estimada: sem histórico suficiente';
        return;
    }
    const left = formatHoursLeft(est.hoursLeft);
    const rate = est.ratePctPerHour < 1
        ? `${est.ratePctPerHour.toFixed(2)}%/h`
        : `${est.ratePctPerHour.toFixed(1)}%/h`;
    el.textContent = `Autonomia estimada: ${left} restantes (${rate})`;
    el.classList.add('has-estimate');
    if (est.hoursLeft != null && est.hoursLeft < 6) el.classList.add('warn');
}
/** Today's trail distance/duration + motion + stops. */
function computeTrailIntel(trailPts) {
    const now = Date.now();
    const dayStart = startOfTodaySP();
    const pts = (trailPts || [])
        .filter(p => p && p.lat != null && p.lon != null && p.at)
        .map(p => ({ lat: Number(p.lat), lon: Number(p.lon), at: new Date(p.at).getTime() }))
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.at))
        .sort((a, b) => a.at - b.at);
    const today = pts.filter(p => p.at >= dayStart);
    let distM = 0;
    for (let i = 1; i < today.length; i++) {
        distM += haversine(today[i - 1].lat, today[i - 1].lon, today[i].lat, today[i].lon);
    }
    let durationMs = 0;
    if (today.length >= 2) durationMs = today[today.length - 1].at - today[0].at;

    // motion: last MOVE_WINDOW_MS
    const win = pts.filter(p => p.at >= now - INTEL.MOVE_WINDOW_MS);
    let moving = false;
    let dispM = 0;
    if (win.length >= 2) {
        const a = win[0], b = win[win.length - 1];
        dispM = haversine(a.lat, a.lon, b.lat, b.lon);
        const hours = Math.max((b.at - a.at) / 3600000, 1 / 60);
        const speedKmh = (dispM / 1000) / hours;
        moving = dispM >= INTEL.MOVE_DISP_M || speedKmh >= INTEL.MOVE_SPEED_KMH;
    } else if (win.length === 1 && pts.length >= 2) {
        const prev = pts[pts.length - 2];
        const cur = win[0];
        dispM = haversine(prev.lat, prev.lon, cur.lat, cur.lon);
        moving = dispM >= INTEL.MOVE_DISP_M;
    }

    // simple stop clusters: consecutive points within STOP_RADIUS staying >= STOP_MIN_MS
    let stops = 0;
    if (today.length >= 2) {
        let clusterStart = 0;
        for (let i = 1; i <= today.length; i++) {
            const ended = i === today.length;
            const far = !ended && haversine(
                today[clusterStart].lat, today[clusterStart].lon,
                today[i].lat, today[i].lon
            ) > INTEL.STOP_RADIUS_M;
            if (ended || far) {
                const lastIdx = ended ? today.length - 1 : i - 1;
                const dwell = today[lastIdx].at - today[clusterStart].at;
                if (dwell >= INTEL.STOP_MIN_MS && lastIdx > clusterStart) stops += 1;
                clusterStart = i;
            }
        }
    }

    return {
        todayPts: today.length,
        todayKm: distM / 1000,
        todayDurationMs: durationMs,
        moving,
        stops,
        winPts: win.length,
        dispM,
    };
}
function updateTrailIntelUi(intel) {
    const el = elements.trailIntel;
    if (!el) return;
    if (!intel || intel.todayPts < 1) {
        el.textContent = 'Resumo da trilha: sem pontos hoje';
        return;
    }
    const km = intel.todayKm >= 10 ? intel.todayKm.toFixed(0) : intel.todayKm.toFixed(1);
    let dur = '';
    const ms = intel.todayDurationMs || 0;
    if (ms >= 3600000) dur = ` · ${Math.round(ms / 3600000)}h`;
    else if (ms >= 60000) dur = ` · ${Math.round(ms / 60000)}min`;
    const mov = intel.moving ? 'em movimento' : 'parado';
    const stopTxt = intel.stops > 0 ? ` · ${intel.stops} parada${intel.stops > 1 ? 's' : ''}` : '';
    el.textContent = `Resumo da trilha: hoje ${km} km${dur} · ${mov}${stopTxt}`;
}
function computeOperationalAlerts({
    connected, lastSeen, batteryPct, rsrp, gpsAt, netAt, trailPts, geoInsideNow, hasFix, presence,
} = {}) {
    const alerts = [];
    const push = (level, id, text) => alerts.push({ level, id, text });

    if (!config.apiKey) {
        push('atenção', 'no-key', 'Sem chave API — configure na engrenagem');
        return alerts.slice(0, INTEL.ALERTS_MAX);
    }

    const p = presence || resolvePresence({
        cloudConnected: connected === true ? true : null,
        lastSeen,
    });
    // Offline alert only past offline threshold (CoAP idle ≠ offline).
    if (p.kind === 'offline') {
        push('crítico', 'offline', `Device offline · ${formatPresenceAge(p) || timeAgo(lastSeen)}`);
    } else if (p.kind === 'sleeping') {
        push('atenção', 'stale-seen', `Em espera · ${formatPresenceAge(p) || timeAgo(lastSeen)}`);
    } else if (p.kind === 'nodata') {
        push('atenção', 'stale-seen', 'Sem dados de atividade na nuvem');
    }

    const pct = batteryPct != null ? Number(batteryPct) : null;
    if (pct != null && pct < INTEL.BATTERY_CRIT) {
        push('crítico', 'bat-crit', `Bateria crítica (${pct}%)`);
    } else if (pct != null && pct < INTEL.BATTERY_LOW) {
        push('atenção', 'bat-low', `Bateria baixa (${pct}%)`);
    }

    if (geo && hasFix && geoInsideNow === false) {
        push('crítico', 'geo-out', 'Fora da geofence');
    }

    // sparse trail while transmitting
    if (p.isOnline) {
        const since = Date.now() - INTEL.TRAIL_SPARSE_HOURS * 3600 * 1000;
        const recent = (trailPts || []).filter(pt => pt.at && new Date(pt.at).getTime() >= since);
        const hasHistory = (trailPts || []).length >= INTEL.TRAIL_SPARSE_MIN_PTS;
        if (hasHistory && recent.length < INTEL.TRAIL_SPARSE_MIN_PTS) {
            push('atenção', 'trail-sparse', `Trilha esparsa (${recent.length} pts / ${INTEL.TRAIL_SPARSE_HOURS}h)`);
        }
    }

    if (rsrp != null && Number(rsrp) < INTEL.RSRP_WEAK) {
        push('atenção', 'rsrp-weak', `Sinal fraco (RSRP ${rsrp} dBm)`);
    }

    const gpsAge = ageMs(gpsAt);
    if (hasFix && gpsAge != null && gpsAge > INTEL.DATA_STALE_MS) {
        push('atenção', 'gps-stale', `Posição velha (${timeAgo(gpsAt)})`);
    }
    const netAge = ageMs(netAt);
    const netStale = netAt ? (netAge != null && netAge > INTEL.DATA_STALE_MS) : true;
    if (p.isOnline && netStale) {
        // v32: aparelho ativo (posição/sensores) mas sem DEVICE/SCELL — informativo, não é falta de cobertura
        const what = p.activitySource ? p.activitySource.replace(/ na nuvem$/, '') : 'dados';
        push('ok', 'net-info', `Aparelho enviou ${what} ${timeAgo(p.activityAt)}, mas não enviou dados de rede (DEVICE/SCELL)${netAt ? ` desde ${timeAgo(netAt)}` : ''} — não indica falta de cobertura`);
    } else if (!p.isOnline && netAt && netAge != null && netAge > INTEL.DATA_STALE_MS) {
        push('atenção', 'net-stale', `Dado de rede velho (${timeAgo(netAt)})`);
    }

    // sort crítico first
    const rank = { crítico: 0, atenção: 1, ok: 2 };
    alerts.sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9));
    return alerts.slice(0, INTEL.ALERTS_MAX);
}
function suggestAcao(alerts, ctx) {
    const ids = new Set((alerts || []).map(a => a.id));
    if (ids.has('no-key')) return 'Abrir engrenagem e colar a chave';
    if (ids.has('geo-out')) return 'Verificar cerca / posição do asset';
    if (ids.has('bat-crit')) return 'Recarregar agora';
    if (ids.has('bat-low')) {
        const h = ctx.hoursLeft;
        if (h != null && Number.isFinite(h)) return `Recarregar em ${formatHoursLeft(h)}`;
        return 'Planejar recarga em breve';
    }
    if (ids.has('offline')) return 'Sem envio à nuvem — checar bateria, cobertura e se o aparelho está ligado';
    if (ids.has('stale-seen') && ctx.presence?.isSleeping) return 'Em espera entre uploads (CoAP) — normal';
    if (ids.has('stale-seen')) return 'Aguardar o primeiro envio à nuvem';
    if (ids.has('rsrp-weak')) return 'Checar antena / cobertura';
    if (ids.has('gps-stale')) return 'Aguardar novo fix de posição';
    if (ids.has('net-stale')) return 'Atualizar agora ou aguardar poll';
    if (ids.has('trail-sparse')) return 'Aguardar pontos de trilha';
    if ((ctx.presence?.isOnline || ctx.connected === true) && !ctx.hasFix) return 'Aguardando fix de posição';
    if (ctx.presence?.isSleeping) return 'Em espera entre uploads (CoAP) — normal';
    if (ctx.presence?.isOnline || ctx.connected === true) return 'Monitorar — sem ação urgente';
    return 'Configurar chave e aguardar poll';
}
function highestRisk(alerts) {
    if (!alerts || !alerts.length) return { level: 'OK', reason: 'Nenhum alerta ativo' };
    const top = alerts[0];
    const label = top.level === 'crítico' ? 'Crítico' : top.level === 'atenção' ? 'Atenção' : 'OK';
    return { level: label, reason: top.text, raw: top.level };
}
function renderSitAlertas(alerts) {
    const ul = elements.sitAlertas;
    if (!ul) return;
    ul.innerHTML = '';
    if (!alerts.length) {
        const li = document.createElement('li');
        li.className = 'lvl-ok';
        li.textContent = 'Nenhum alerta';
        ul.appendChild(li);
        return;
    }
    for (const a of alerts) {
        const li = document.createElement('li');
        li.className = `lvl-${a.level}`;
        li.textContent = a.text;
        ul.appendChild(li);
    }
}
function updateSituacaoInteligente(opts = {}) {
    if (opts.batteryPct != null) lastBatteryPct = opts.batteryPct;
    if (opts.connected !== undefined) lastConnected = opts.connected;
    if (opts.lastSeen) lastSeenTs = opts.lastSeen;
    if (opts.gps && opts.gps.lat != null && opts.gps.lon != null) {
        lastGpsFix = {
            lat: Number(opts.gps.lat),
            lon: Number(opts.gps.lon),
            at: opts.gpsAt || opts.lastSeen || lastGpsFix?.at || null,
        };
    }

    const connected = opts.connected !== undefined ? opts.connected : lastConnected;
    const pct = opts.batteryPct != null ? opts.batteryPct : lastBatteryPct;
    const lastSeen = opts.lastSeen || lastSeenTs;
    const rsrp = opts.rsrp != null ? opts.rsrp : null;
    let trailPts = opts.trailPts != null ? opts.trailPts : lastTrail;
    if (!Array.isArray(trailPts)) trailPts = lastTrail || [];
    const hasFix = !!(lastGpsFix && lastGpsFix.lat != null);
    const gpsAt = lastGpsFix?.at || opts.gpsAt || null;
    const netAt = opts.netAt || lastNetPayloadAt || null;
    const presence = opts.presence || resolvePresence({
        cloudConnected: connected === true ? true : null,
        lastSeen,
        msgs: lastMessages,
        parsed: opts.parsed,
    });
    lastPresence = presence;

    // Estado (activity-based)
    let estado = '…';
    let estadoCls = '';
    if (!config.apiKey) {
        estado = 'Sem chave';
        estadoCls = 'estado-sem-chave';
    } else {
        estado = presenceWithAgeLabel(presence);
        estadoCls = presence.cssClass || '';
    }
    setText(elements.sitEstado, estado);
    if (elements.sitCellEstado) {
        elements.sitCellEstado.className = `sit-cell ${estadoCls}`.trim();
    }

    // Onde
    let onde = 'sem fix';
    if (hasFix) {
        onde = shortCoords(lastGpsFix.lat, lastGpsFix.lon);
        if (geo) {
            const dist = haversine(geo.lat, geo.lon, lastGpsFix.lat, lastGpsFix.lon);
            const inside = dist <= geo.radius;
            onde += inside ? ' · DENTRO' : ' · FORA';
        }
    } else if (geo) {
        onde = 'sem fix · cerca ativa';
    }
    setText(elements.sitOnde, onde);

    // Geofence flag for alerts
    let geoInsideNow = null;
    if (geo && hasFix) {
        geoInsideNow = haversine(geo.lat, geo.lon, lastGpsFix.lat, lastGpsFix.lon) <= geo.radius;
    }

    const batEst = estimateBatteryDrain(trailPts, pct);
    updateBatteryAutonomia(batEst);

    const trailIntel = computeTrailIntel(trailPts);
    updateTrailIntelUi(trailIntel);

    const alerts = computeOperationalAlerts({
        connected, lastSeen, batteryPct: pct, rsrp,
        gpsAt, netAt, trailPts, geoInsideNow, hasFix, presence,
    });
    const mergedAlerts = mergeAlerts(alerts, lastServerAlerts);
    lastIntelAlerts = mergedAlerts;
    renderSitAlertas(mergedAlerts);

    const risk = highestRisk(mergedAlerts);
    setText(elements.sitRisco, risk.level);
    setText(elements.sitRiscoReason, risk.reason || '');
    if (elements.sitCellRisco) {
        const cls = risk.raw === 'crítico' ? 'risk-critico'
            : risk.raw === 'atenção' ? 'risk-atencao' : 'risk-ok';
        elements.sitCellRisco.className = `sit-cell ${cls}`;
    }

    const acao = suggestAcao(mergedAlerts, {
        connected: presence.connectedBool,
        presence,
        hasFix,
        hoursLeft: batEst.ok ? batEst.hoursLeft : null,
    });
    setText(elements.sitAcao, acao);

    // keep legacy one-liner hidden but updated for any old refs
    if (elements.situacaoLine) {
        const alias = opts.alias || getDeviceAlias(config.deviceId, 'Asset Tracker');
        elements.situacaoLine.textContent = `${alias} · ${estado} · ${risk.level}`;
    }
}
/** @deprecated use updateSituacaoInteligente */
function updateSituacaoLine(opts = {}) {
    updateSituacaoInteligente(opts);
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
function setStatus(connectedOrPresence, label) {
    const el = elements.connectionStatus; if (!el) return;
    el.classList.remove('connected', 'error', 'stale');
    const p = connectedOrPresence && typeof connectedOrPresence === 'object' && connectedOrPresence.kind
        ? connectedOrPresence : null;
    if (p) {
        if (p.kind === 'online') el.classList.add('connected');
        else if (p.kind === 'offline') el.classList.add('error');
        else el.classList.add('stale');
    } else {
        const connected = connectedOrPresence;
        el.classList.add(connected === true ? 'connected' : connected === false ? 'error' : 'stale');
    }
    setText(elements.connLabel, label);
    if (p) el.title = presenceTooltip(p);
}
function updateConnPanel({ connected, presence, lastSeen, lastMsg, msgCount, latency }) {
    const p = presence || null;
    let stateTxt = '… ?';
    let color = '#636e72';
    if (p) {
        if (p.kind === 'online') { stateTxt = '● ONLINE'; color = '#00b894'; }
        else if (p.kind === 'sleeping') { stateTxt = '◐ EM ESPERA'; color = '#fdcb6e'; }
        else if (p.kind === 'offline') { stateTxt = '○ OFFLINE'; color = '#d63031'; }
        else if (p.kind === 'nodata') { stateTxt = '○ SEM DADOS'; color = '#636e72'; }
    } else if (connected === true) { stateTxt = '● ONLINE'; color = '#00b894'; }
    else if (connected === false) { stateTxt = '○ OFFLINE'; color = '#d63031'; }
    setText(elements.connState, stateTxt);
    if (elements.connState) elements.connState.style.color = color;
    const activityAt = p?.activityAt || lastSeen;
    setText(elements.connLastSeen, activityAt ? `${fmtDateTime(activityAt)} (${timeAgo(activityAt)})` : '—');
    setText(elements.connLastMsg, lastMsg ? `${fmtDateTime(lastMsg)} (${timeAgo(lastMsg)})` : '—');
    setText(elements.connMsgCount, msgCount ?? '—');
    setText(elements.connLatency, latency != null ? `${latency} ms` : '—');
    setText(elements.connPoll, `${POLL_MS / 1000}s`);
}

/** Short carrier name for header pill (no PLMN digits). */
function shortOperatorName(parsed = {}) {
    const plmn = parsed.mccMnc != null ? String(parsed.mccMnc).trim() : '';
    const hint = plmnHint(plmn);
    let name = (parsed.operator != null && parsed.operator !== '' && parsed.operator !== '—')
        ? String(parsed.operator).trim() : '';
    if (!name || name === plmn || /^\d{5,6}$/.test(name)) name = hint || '';
    if (name.includes('·')) name = name.split('·')[0].trim();
    return name || hint || '';
}

function hasCellularPayload(parsed = {}, fromMsg = {}) {
    // DISPONÍVEL only with real radio markers (MCC / cell / RSRP) — not SIM-only
    const rsrp = fromMsg.rsrp ?? parsed.rsrp;
    return !!(parsed.mccMnc || fromMsg.mccMnc || parsed.cellId != null || parsed.eci != null
        || parsed.tac != null || rsrp != null);
}

function buildHeaderConnLabel(connectedOrPresence, parsed = {}, fromMsg = {}) {
    if (!config.apiKey) return 'Sem chave';
    if (lastPollAuthFail) return 'Sem chave';
    const p = connectedOrPresence && typeof connectedOrPresence === 'object' && connectedOrPresence.kind
        ? connectedOrPresence : null;
    if (p) {
        if (p.kind === 'offline' || p.kind === 'sleeping') return presenceWithAgeLabel(p);
        if (p.kind === 'nodata') return 'Sem dados';
        const cell = hasCellularPayload(parsed, fromMsg);
        const age = formatPresenceAge(p);
        // v32: sem DEVICE/SCELL não significa "sem rede LTE" — o aparelho está enviando; só não mandou dados de rede
        if (!cell) return age ? `Online · ${age}` : 'Online';
        const op = shortOperatorName(parsed);
        const mode = String(parsed.networkMode || parsed.accessTech || 'LTE').toUpperCase();
        const modeShort = /NB/i.test(mode) ? 'NB-IoT' : /LTE|CAT|EUTRA|EMTC/i.test(mode) ? 'LTE' : mode.slice(0, 8);
        const base = op ? `Online · ${modeShort} ${op}` : `Online · ${modeShort}`;
        return age ? `${base} · ${age}` : base;
    }
    const connected = connectedOrPresence;
    if (connected === false) return 'Offline';
    if (connected !== true) return connected == null ? '?' : 'Desconhecido';
    const cell = hasCellularPayload(parsed, fromMsg);
    if (!cell) return 'Online';
    const op = shortOperatorName(parsed);
    const mode = String(parsed.networkMode || parsed.accessTech || 'LTE').toUpperCase();
    const modeShort = /NB/i.test(mode) ? 'NB-IoT' : /LTE|CAT|EUTRA|EMTC/i.test(mode) ? 'LTE' : mode.slice(0, 8);
    return op ? `Online · ${modeShort} ${op}` : `Online · ${modeShort}`;
}

function setStripClass(el, kind) {
    if (!el) return;
    el.classList.remove('ok', 'warn', 'err', 'muted');
    if (kind) el.classList.add(kind);
}

function pulseConnectivity() {
    const strip = elements.connectivityStrip;
    const card = elements.cardNetwork;
    [strip, card].forEach(el => {
        if (!el) return;
        el.classList.remove('poll-pulse');
        // restart animation
        void el.offsetWidth;
        el.classList.add('poll-pulse');
    });
}

function setStripRefreshing(on) {
    stripRefreshing = !!on;
    elements.connectivityStrip?.classList.toggle('is-refreshing', !!on);
    if (elements.stripRefreshStatus) {
        if (on) {
            elements.stripRefreshStatus.hidden = false;
            elements.stripRefreshStatus.textContent = 'Atualizando…';
        } else {
            elements.stripRefreshStatus.hidden = true;
            elements.stripRefreshStatus.textContent = '';
        }
    }
    if (elements.refreshNowBtn) elements.refreshNowBtn.disabled = !!on;
}

function renderConnectivityAges() {
    if (elements.stripLastPoll) {
        if (stripRefreshing) {
            setText(elements.stripLastPoll, 'Atualizando…');
            setStripClass(elements.stripLastPoll, 'muted');
        } else if (lastSuccessfulPollAt) {
            const ts = fmtTime(lastSuccessfulPollAt);
            setText(elements.stripLastPoll, `${ts} · atualizado ${timeAgo(lastSuccessfulPollAt)}`);
            setStripClass(elements.stripLastPoll, 'ok');
        } else {
            setText(elements.stripLastPoll, 'ainda não');
            setStripClass(elements.stripLastPoll, 'muted');
        }
    }
    // v31: "Último dado do aparelho" = newest CLOUD timestamp (last_seen / messages), not poll time,
    // not USB serial, not cached net payload.
    if (elements.stripNetAge) {
        const pr = lastPresence;
        const at = pr?.activityAt || null;
        if (at) {
            const d = new Date(at);
            const same = ymdSP(Date.now()) === ymdSP(d);
            const ts = same ? fmtTime(d) : fmtDateTime(d, { hour12: false });
            setText(elements.stripNetAge, `${ts} · ${timeAgo(at)}`);
            elements.stripNetAge.title = presenceTooltip(pr);
            const age = Date.now() - d.getTime();
            setStripClass(elements.stripNetAge, pr.kind === 'online' ? 'ok' : (pr.kind === 'sleeping' ? 'warn' : 'err'));
            if (!Number.isFinite(age)) setStripClass(elements.stripNetAge, 'muted');
        } else {
            setText(elements.stripNetAge, 'nenhum dado na nuvem');
            elements.stripNetAge.title = '';
            setStripClass(elements.stripNetAge, 'muted');
        }
    }
    if (elements.stripNetSrc) {
        const src = telemetrySource.net;
        const serialLive = serialIsHealthy(lastSerial);
        if (src === 'serial' && serialLive) {
            setText(elements.stripNetSrc, 'USB do Mac (modem local)');
            setStripClass(elements.stripNetSrc, 'warn');
        } else if (src === 'cloud') {
            setText(elements.stripNetSrc, 'nuvem');
            setStripClass(elements.stripNetSrc, 'ok');
        } else {
            // v32: nunca deixar vazio — explica por que não há dado de rede
            const pr = lastPresence;
            if (pr && pr.isOnline) {
                setText(elements.stripNetSrc, 'sem dados de rede (só posição)');
                elements.stripNetSrc.title = 'O aparelho enviou posição/sensores, mas nenhuma mensagem DEVICE/SCELL/RSRP chegou à nuvem.';
            } else if (pr && (pr.isOffline || pr.isSleeping)) {
                setText(elements.stripNetSrc, 'sem envio recente');
                elements.stripNetSrc.title = 'O aparelho não enviou nada recentemente.';
            } else {
                setText(elements.stripNetSrc, 'sem dados');
                elements.stripNetSrc.title = '';
            }
            setStripClass(elements.stripNetSrc, 'muted');
        }
    }
    setText(elements.stripPollMs, `a cada ${POLL_MS / 1000}s`);
}

function updateConnectivityStrip({ connected, presence, parsed = {}, fromMsg = {} } = {}) {
    const p = presence || presenceFromParsed(parsed, fromMsg);
    lastStripContext = { connected: p.connectedBool, presence: p, parsed, fromMsg };
    const online = p.isOnline;
    const offline = p.isOffline;
    const sleeping = p.isSleeping;
    const cell = hasCellularPayload(parsed, fromMsg);
    const rsrp = fromMsg.rsrp ?? parsed.rsrp;
    const op = formatOperator(parsed.operator, parsed.mccMnc);
    const onPages = /github\.io|netlify/i.test(location.hostname || '');
    const noTeam = !config.teamApiKey;

    // Estado nuvem (activity-based) — tooltip mostra de onde veio a atividade
    if (elements.stripCloud) {
        elements.stripCloud.title = presenceTooltip(p);
        if (online) { setText(elements.stripCloud, 'ONLINE'); setStripClass(elements.stripCloud, 'ok'); }
        else if (sleeping) { setText(elements.stripCloud, 'EM ESPERA'); setStripClass(elements.stripCloud, 'warn'); }
        else if (offline) { setText(elements.stripCloud, 'OFFLINE'); setStripClass(elements.stripCloud, 'err'); }
        else if (p.kind === 'nodata') { setText(elements.stripCloud, 'SEM DADOS'); setStripClass(elements.stripCloud, 'muted'); }
        else { setText(elements.stripCloud, '?'); setStripClass(elements.stripCloud, 'muted'); }
    }

    // Rede celular — don't mark INDISPONÍVEL solely because CoAP shadow says disconnected
    if (elements.stripCell) {
        if (offline && !cell) {
            setText(elements.stripCell, 'INDISPONÍVEL');
            setStripClass(elements.stripCell, 'err');
        } else if (cell) {
            setText(elements.stripCell, 'DISPONÍVEL');
            setStripClass(elements.stripCell, 'ok');
        } else {
            setText(elements.stripCell, 'SEM DADOS');
            setStripClass(elements.stripCell, 'warn');
        }
    }

    // Qualidade
    if (elements.stripQuality) {
        if (rsrp != null || (op && op !== '—')) {
            const parts = [];
            if (rsrp != null) parts.push(`RSRP ${rsrp} dBm`);
            if (op && op !== '—') parts.push(op);
            setText(elements.stripQuality, parts.join(' · '));
            setStripClass(elements.stripQuality, 'ok');
        } else {
            setText(elements.stripQuality, '—');
            setStripClass(elements.stripQuality, 'muted');
        }
    }

    if (cell && fromMsg.netAt) lastNetPayloadAt = fromMsg.netAt;

    // Hint honest empty / token
    if (elements.stripHint) {
        if (!config.apiKey) {
            elements.stripHint.hidden = false;
            elements.stripHint.classList.add('need-token');
            elements.stripHint.textContent = 'Configure a User API Key na engrenagem para ver a nuvem.';
        } else if (cell && (offline || sleeping) && telemetrySource.net === 'serial') {
            elements.stripHint.hidden = false;
            elements.stripHint.classList.remove('need-token');
            elements.stripHint.textContent = `Rede/RSRP lidos pela USB do Mac (modem ligado). A nuvem não recebe dados do aparelho: ${formatPresenceAge(p) || 'sem timestamp'}.`;
        } else if (!cell && noTeam && onPages) {
            elements.stripHint.hidden = false;
            elements.stripHint.classList.add('need-token');
            elements.stripHint.textContent = 'ListMessages precisa da Simple Token da equipe (engrenagem) para MCC/célula/RSRP. Sem ela a Rede celular fica SEM DADOS.';
        } else if (!cell && offline) {
            elements.stripHint.hidden = false;
            elements.stripHint.classList.remove('need-token');
            elements.stripHint.textContent = `Sem envio do aparelho à nuvem (${formatPresenceAge(p) || 'sem timestamp'}) — sem dados celulares recentes.`;
        } else if (!cell && sleeping) {
            elements.stripHint.hidden = false;
            elements.stripHint.classList.remove('need-token');
            elements.stripHint.textContent = 'Em espera entre uploads CoAP — normal para Asset Tracker.';
        } else if (!cell) {
            elements.stripHint.hidden = false;
            elements.stripHint.classList.remove('need-token');
            elements.stripHint.textContent = online && p.activitySource
                ? `O aparelho está enviando (${p.activitySource} · ${formatPresenceAge(p)}), mas não enviou dados de rede (mensagens DEVICE/SCELL/RSRP não chegaram e o shadow não tem networkInfo). Isso não indica falta de cobertura.`
                : 'Sem DEVICE/SCELL/RSRP nas mensagens e sem networkInfo no shadow (ATT 1.5).';
        } else {
            elements.stripHint.hidden = true;
            elements.stripHint.textContent = '';
            elements.stripHint.classList.remove('need-token');
        }
    }

    renderConnectivityAges();
}

function startConnectivityAgeTicker() {
    if (connectivityAgeTimer) clearInterval(connectivityAgeTimer);
    connectivityAgeTimer = setInterval(() => {
        renderConnectivityAges();
        // keep conn panel ages fresh too
        if (lastStripContext) {
            const { connected } = lastStripContext;
            // refresh header age-less label stays; connLastSeen refreshed via lastDeviceRaw if present
        }
        if (elements.connLastSeen && lastSeenTs) {
            setText(elements.connLastSeen, `${fmtDateTime(lastSeenTs)} (${timeAgo(lastSeenTs)})`);
        }
    }, 1000);
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
    // v32: timeout (rede móvel travada não pode congelar o poll)
    const ctrl = new AbortController();
    const tmo = setTimeout(() => ctrl.abort(), options.timeoutMs || 25000);
    let res;
    try {
        res = await fetch(`${NRF_CLOUD_BASE}${path}`, { ...options, headers, signal: ctrl.signal });
    } catch (e) {
        clearTimeout(tmo);
        if (e && e.name === 'AbortError') throw new Error('Tempo esgotado ao falar com a nuvem (25s)');
        throw e;
    }
    clearTimeout(tmo);
    const latency = Date.now() - t0;
    if (res.status === 429) {
        // v32: rate-limit → pausa o poll pelo Retry-After (mín. 30s, máx. 10min)
        const ra = Number(res.headers.get('Retry-After'));
        const waitMs = Math.min(600000, Math.max(30000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60000));
        rateLimitedUntil = Date.now() + waitMs;
        log('warn', `Limite de requisições (429) em ${path} — pausando ${Math.round(waitMs / 1000)}s`);
        throw new Error(`HTTP 429: limite de requisições — nova tentativa em ${Math.round(waitMs / 1000)}s`);
    }
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let eb = {};
        if (errText && errText.trim()) {
            try { eb = JSON.parse(errText); } catch { eb = { message: errText.slice(0, 200) }; }
        }
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
            } else if (eb.needsTeamKey || eb.code === 40100 || /^\/(messages|location)/.test(path)) {
                // Memfault key works for /devices; nRF Cloud REST (msgs/location) needs the team API key
                msg = 'nRF Cloud recusou (40100) — falta a API Key da equipe (Simple Token) na engrenagem.';
            } else {
                msg = 'Chave rejeitada — confira User API Key/OAT e e-mail (Basic) ou OAT sem e-mail.';
            }
        }
        log('err', `✕ ${path} [${res.status}] ${msg}`, `${latency}ms`);
        throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    // nRF Cloud PATCH /state often returns 204 No Content (empty body). Never call res.json() on empty.
    const text = await res.text();
    let data;
    if (text && text.trim().length > 0) {
        try { data = JSON.parse(text); }
        catch { data = { ok: true, raw: text.slice(0, 200) }; }
    } else {
        data = { ok: true, empty: true, status: res.status };
    }
    logCount.api++;
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
async function getLocationHistory(id, hours = 24, opts = {}) {
    const end = new Date().toISOString(), start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const maxPages = opts.pages || 10, limit = opts.limit || 100;
    let all = [], token = null, pages = 0;
    do {
        // v30: newest first so the latest fixes are never cut by the 10-page cap (merge sorts by time)
        const p = { deviceId: id, start, end, pageLimit: String(limit), pageSort: 'desc' };
        if (token) p.pageNextToken = token;
        const { data } = await nrfFetch(`/location/history?${new URLSearchParams(p).toString()}`);
        const items = Array.isArray(data) ? data : (data?.items || data?.data || []);
        all = all.concat(items); token = data?.pageNextToken; pages++;
    } while (token && pages < maxPages);
    return all;
}
/** v32: histórico por appId (BATTERY/TEMP/HUMID/AIR_PRESS) — alimenta bateria/ambiente dos popups da trilha. */
async function getMessagesByApp(id, appId, limit = 100) {
    const q = new URLSearchParams({ deviceId: id, appId, pageLimit: String(limit), pageSort: 'desc' }).toString();
    const { data } = await nrfFetch(`/messages?${q}`);
    return Array.isArray(data) ? data : (data?.items || data?.data || []);
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
    // v32: garante ordem do mais novo para o mais antigo (não confia na ordem da API / merge por appId)
    const list = (Array.isArray(items) ? items : []).slice().sort((a, b) => (PresenceCore.msgRecvMs(b) || 0) - (PresenceCore.msgRecvMs(a) || 0));
    const byApp = {};
    for (const it of list) {
        const a = String(it.message?.appId || it.appId || it.app_id || 'UNKNOWN').toUpperCase();
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
        const rMs = PresenceCore.msgRecvMs(it);
        out[a] = { raw: m, data: m.data ?? m, receivedAt: rMs != null ? new Date(rMs).toISOString() : null };
    }
    // ATT 1.5 (nRF Cloud CoAP): BATTERY (% número), TEMP (°C), HUMID (%), AIR_PRESS (kPa) — data = número ou string numérica.
    // GNSS/localização vem pelo endpoint de localização (location history); DEVICE/SCELL só se o firmware publicar.
    const A = (...ks) => { for (const k of ks) if (out[k]) return out[k]; return undefined; };
    const g = A('GNSS', 'GPS', 'PVT')?.data, t = A('TEMP', 'TEMPERATURE')?.data, h = A('HUMID', 'HUMIDITY', 'HUM')?.data,
        p = A('AIR_PRESS', 'PRESSURE', 'PRESS')?.data, r = out.RSRP?.data,
        dev = out.DEVICE?.data, bat = A('BATTERY', 'BAT')?.data,
        env = A('ENV', 'ENVIRONMENT')?.data;
    const maxIso = (...vals) => { const ms = vals.map(v => PresenceCore.toTsMs(v)).filter(x => x != null); return ms.length ? new Date(Math.max(...ms)).toISOString() : null; };
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

    const latestMs = list.length ? PresenceCore.msgRecvMs(list[0]) : null;
    const latestAt = latestMs != null ? new Date(latestMs).toISOString() : null;
    const netAt = maxIso(out.DEVICE?.receivedAt, out.SCELL?.receivedAt, out.CELL_POS?.receivedAt,
        out.RSRP?.receivedAt, out.RSRQ?.receivedAt);
    const gpsAtMsg = A('GNSS', 'GPS', 'PVT')?.receivedAt || null;

    return {
        byApp, latestAt, netAt, gpsAt: gpsAtMsg,
        gps: (g && typeof g === 'object') ? { lat: num(pick(g, 'lat', 'latitude')), lon: num(pick(g, 'lng', 'lon', 'longitude')), accuracy: num(pick(g, 'acc', 'accuracy', 'uncertainty')), speed: num(pick(g, 'spd', 'speed')), altitude: num(pick(g, 'alt', 'altitude')), satellites: num(pick(g, 'sats', 'satellites', 'numSat')) } : {},
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
        // v32: só campos de objeto — um número puro em BATTERY é % (não pode virar "volts")
        batteryV: num((dev && typeof dev === 'object' ? pick(dev, 'batteryVoltage', 'batV', 'voltage', 'v') : undefined)
            ?? (bat && typeof bat === 'object' ? pick(bat, 'batteryVoltage', 'batV', 'voltage', 'v', 'mV', 'mv') : undefined)
            ?? pick(diMsg ?? {}, 'batteryVoltage')),
        batteryPct: (() => {
            // Explicit SoC keys first
            let n = num(pick(bat ?? {}, 'percent', 'percentage', 'SoC', 'soc', 'level'));
            if (n == null && bat != null && (typeof bat === 'number' || (typeof bat === 'string' && bat.trim() !== ''))) n = num(bat);
            if (n == null) {
                const v = num(pick(bat ?? {}, 'value', 'bat'));
                // Bare 0–100 that is NOT in typical voltage band → SoC
                if (v != null && v >= 0 && v <= 100 && !(v >= 2.5 && v <= 5.5)) n = v;
            }
            if (n == null) return undefined;
            if (n >= 0 && n <= 100) return n;
            return undefined;
        })(),
        batteryAt: maxIso(out.BATTERY?.receivedAt, out.BAT?.receivedAt) || (bat != null ? null : null),
        envAt: maxIso(out.TEMP?.receivedAt, out.TEMPERATURE?.receivedAt, out.ENV?.receivedAt, out.ENVIRONMENT?.receivedAt,
            out.HUMID?.receivedAt, out.HUMIDITY?.receivedAt, out.AIR_PRESS?.receivedAt, out.PRESSURE?.receivedAt),
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
    // v32: last_seen = Memfault; shadowMeta = $meta do shadow nRF. Duas evidências separadas (a mais nova vale).
    const lastSeen = d.last_seen || d._memfault?.last_seen || null;
    const shadowMeta = d._shadowMeta || d._nrf?.$meta?.updatedAt || d._nrf?.updatedAt || (lastSeen ? null : d.$meta?.updatedAt) || null;
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
        sampleIntervalSec: pickSampleIntervalSec({
            config: rep.config || d.state?.desired?.config || d.state?.reported?.config,
            state: d.state,
        }),
        session: rep.sessionIdentifier,
        firmware,
        lastSeen,
        shadowMeta,
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

    const gps = { ...fromMsg.gps };
    // v32: idade da posição = hora do fix (mensagem GNSS), nunca a hora de outra mensagem qualquer
    let gpsTs = fromMsg.gpsAt || (fromMsg.gps?.source === 'serial' || fromMsg.gps?.source === 'uart' ? lastSerial?.updatedAt : null) || null;
    const gpsMs = toTsMs(gpsTs), curFixMs = toTsMs(lastGpsFix?.at);
    const gpsIsNewer = gps.lat != null && gps.lon != null && (gpsMs == null || curFixMs == null || gpsMs >= curFixMs);
    if (gps.lat != null && gps.lon != null && gpsIsNewer) {
        setText(elements.gpsCoords, `${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}`);
        setGpsSourceBadge(gps.source || lastSerial?.locationSource || telemetrySource.gps);
        setText(elements.gpsLat, gps.lat.toFixed(6)); setText(elements.gpsLon, gps.lon.toFixed(6));
        setText(elements.gpsAcc, gps.accuracy != null ? `${Math.round(gps.accuracy)} m` : '—');
        setText(elements.gpsAlt, gps.altitude != null ? `${Math.round(gps.altitude)} m` : '—');
        const spd = gps.speed != null ? Number(gps.speed) : null;
        setText(elements.gpsSpeed, spd != null ? `${spd.toFixed(1)} m/s` : '—');
        updateMap(gps.lat, gps.lon, gps.accuracy);
        refreshGeofenceUi(gps.lat, gps.lon);
        lastGpsFix = { lat: Number(gps.lat), lon: Number(gps.lon), at: gpsTs || null };
    } else if (!(gps.lat != null && gps.lon != null)) {
        refreshGeofenceUi(lastGpsFix?.lat ?? null, lastGpsFix?.lon ?? null);
    }
    if (gps.lat != null && gpsIsNewer) setDataAge(elements.gpsAge, gpsTs, { missing: 'sem timestamp' });
    else if (lastGpsFix?.at) setDataAge(elements.gpsAge, lastGpsFix.at, { missing: 'sem timestamp' });
    else setDataAge(elements.gpsAge, null, { missing: 'sem fix' });

    // Ambiente
    if (fromMsg.temp != null) setText(elements.tempValue, fromMsg.temp.toFixed(1));
    if (fromMsg.hum != null) setText(elements.humValue, fromMsg.hum.toFixed(1));
    if (fromMsg.press != null) {
        const ph = normalizePressHpa(fromMsg.press);
        setText(elements.pressValue, ph != null ? ph.toFixed(1) : fromMsg.press.toFixed(1));
    }
    const envTs = fromMsg.envAt || (telemetrySource.env === 'serial' && lastSerial?.updatedAt ? lastSerial.updatedAt : null);
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
    const batTs = fromMsg.batteryAt || (telemetrySource.battery === 'serial' && lastSerial?.updatedAt ? lastSerial.updatedAt : null);
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
    setText(elements.netSource, src || (lastPresence?.isOnline ? 'sem dados de rede' : 'sem envio recente'));

    const hasSimFields = !!(parsed.imei || parsed.iccid || parsed.imsi);
    const hasCellFields = !!(mccMnc || parsed.operator || parsed.band != null || parsed.cellId != null
        || parsed.eci != null || parsed.tac != null || parsed.ipAddress || rsrp != null || parsed.networkMode
        || hasSimFields);
    const locSrc = String(gps.source || lastSerial?.locationSource || telemetrySource.gps || '').toLowerCase();
    const locWifi = /wifi|wi-?fi/.test(locSrc);
    const presence = presenceFromParsed(parsed, fromMsg);
    const online = presence.isOnline;
    const offline = presence.isOffline;
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
            } else if (presence.isSleeping) {
                elements.netEmptyHint.textContent = 'Em espera entre uploads CoAP — sem DEVICE/SCELL recente; USB serial no Mac preenche a Rede.';
            } else {
                elements.netEmptyHint.textContent = 'Sem networkInfo no shadow (ATT 1.5) e sem DEVICE/SCELL/RSRP em ListMessages. No Mac, USB serial preenche a Rede.';
            }
        }
    }
    // v32: idade do dado de rede = hora da mensagem DEVICE/SCELL/RSRP (nunca a de uma mensagem qualquer)
    const netTs = hasCellFields
        ? (lastSerial?.updatedAt && telemetrySource.net === 'serial'
            ? lastSerial.updatedAt
            : (fromMsg.netAt || null))
        : null;
    setDataAge(elements.netAge, hasCellFields ? netTs : null, {
        missing: hasCellFields ? 'sem timestamp' : (offline ? 'offline' : 'sem dados de rede'),
    });

    if (hasCellFields && fromMsg.netAt) lastNetPayloadAt = fromMsg.netAt;
    updateConnectivityStrip({ connected: presence.connectedBool, presence, parsed, fromMsg });

    lastBatteryAt = batTs || lastBatteryAt;
    updateSituacaoInteligente({
        alias,
        connected: presence.connectedBool,
        presence,
        batteryPct: batPct,
        lastSeen: presence.activityAt || ls || lastSeenTs,
        parsed,
        rsrp,
        gpsAt: lastGpsFix?.at || null,
        netAt: fromMsg.netAt || (telemetrySource.net === 'serial' ? null : lastNetPayloadAt),
        trailPts: lastTrail,
        gps: gps.lat != null ? gps : null,
    });
}

function renderMsgTable(items) {
    if (!elements.msgTable) return;
    if (!items.length) { elements.msgTable.textContent = '—'; return; }
    elements.msgTable.innerHTML = items.slice(0, 12).map(it => {
        const a = escHtml(it.message?.appId || '?'), t = escHtml(fmtDateTime(it.receivedAt));
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
    elements.deviceSelect.innerHTML = deviceList.map(d => `<option value="${escHtml(d.id)}">${escHtml(d.name || d.id)}</option>`).join('');
    if (config.deviceId) elements.deviceSelect.value = config.deviceId;
    setText(elements.fleetCount, `${deviceList.length} devices`);
}
/** v32: presença na frota — mesma função; para o aparelho atual usa também mensagens/localização da nuvem. */
function fleetPresence(f) {
    const cur = f.id === config.deviceId;
    return resolvePresence({
        cloudConnected: f.connected === true ? true : null,
        lastSeen: f.lastSeen, shadowMeta: f.shadowMeta || null,
        msgs: cur ? lastMessages : [], locs: cur ? lastCloudLocs : [],
        intervalSec: f.sampleIntervalSec,
    });
}
function renderFleetGrid(fleetData) {
    if (!elements.fleetGrid) return;
    elements.fleetGrid.innerHTML = fleetData.map(f => {
        const alias = getDeviceAlias(f.id, f.nickname || f.name || 'Asset Tracker');
        const showAlias = alias && alias !== f.id && alias !== (f.name || '');
        return `<button class="fleet-card${f.id === config.deviceId ? ' active' : ''}" data-id="${escHtml(f.id)}">
      <span class="fleet-dot" style="background:${(() => { const pr = fleetPresence(f); return pr.isOnline ? '#00b894' : pr.isSleeping ? '#fdcb6e' : pr.isOffline ? '#d63031' : '#636e72'; })()}"></span>
      <span class="fleet-name">${escHtml(alias || f.name || f.id)}</span>
      ${showAlias && f.name && f.name !== alias ? `<span class="fleet-alias">${escHtml(f.name)}</span>` : ''}
      <span class="fleet-meta">${(() => { const pr = fleetPresence(f); return `${pr.shortLabel} · ${pr.activityAt ? timeAgo(pr.activityAt) : '—'}`; })()}</span>
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
    lastConnected = null; lastTrail = []; lastTrailAll = []; lastTrailFitCount = 0; trailFailLogged = false;
    lastCloudLocs = []; lastMessages = []; lastMemfaultSeen = null; lastParsed = null; lastFromMsg = null; lastGpsFix = null; lastPresence = null;
    trailCache = { key: null, fullAt: 0, pts: [], merged: [] }; lastTrailFetchAt = 0; appMsgCache.at = 0;
    clearTrailMarkers(); routeFitPending = true; routeSig = null; clearRouteLayers();
    log('info', `Trocado para ${id}`); fetchAndUpdate(); loadTrail();
}

/* ---------- Map ---------- */
function initMap() {
    if (map) return;
    map = L.map('map').setView([-23.5505, -46.6333], 4);
    marker = L.marker([0, 0]).addTo(map); marker.setOpacity(0);
    trailMarkersLayer = L.layerGroup().addTo(map);
    initRouteLayer();
    restoreGeofence(); log('info', 'Mapa pronto');
}
/** Move marker + accuracy only. Trail polyline is owned by applyTrailPoints. */
function updateMap(lat, lon, acc, opts = {}) {
    if (!map || !marker) return;
    const appendTrail = !!opts.appendTrail;
    marker.setLatLng([lat, lon]); marker.setOpacity(1);
    setMapHint(null);
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
        if (lastTrail.length < 2) map.setView([lat, lon], 15);
    }
}
function drawFleetMarkers(fleet) {
    fleetMarkers.forEach(m => map.removeLayer(m)); fleetMarkers = [];
    log('info', `Frota online: ${fleet.filter(f => fleetPresence(f).isOnline).length}/${fleet.length}`);
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
    const recvAt = raw.insertedAt || raw.receivedAt || raw.recvAt || meta.insertedAt || null;
    const out = {
        lat, lon,
        at: at ? String(at) : null,
        recvAt: recvAt ? String(recvAt) : null,
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
function buildTrailPopupHtml(pt, popts = {}) {
    const dash = '—';
    let hora = dash;
    if (pt.at) {
        const d = new Date(pt.at);
        if (!Number.isNaN(d.getTime())) {
            hora = fmtDateTime(pt.at, { dateStyle: 'short', timeStyle: 'medium' });
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
    // v32: o popup NÃO calcula presença a partir da idade do ponto (isso dava "Online" para qualquer
    // ponto recente e "Offline" para os antigos). Último ponto = presença atual (mesma fonte do header);
    // pontos antigos = só "registro histórico" com a idade do registro.
    let status = dash;
    if (popts.latest && lastPresence) status = presenceWithAgeLabel(lastPresence);
    else if (pt.at) status = `Registro histórico · ${timeAgo(pt.at).replace(/^há /, 'há ')}`;
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
    if (pt.band != null) redeParts.push(`B${pt.band}`);
    if (pt.networkMode) redeParts.push(String(pt.networkMode));
    const rede = redeParts.length ? redeParts.join(' · ')
        : 'sem dados de rede (o aparelho não enviou DEVICE/SCELL/networkInfo)';
    const notes = [];
    if (pt._telAt && pt.at && Math.abs(new Date(pt._telAt).getTime() - new Date(pt.at).getTime()) > 120000) {
        notes.push(`bateria/ambiente da amostra das ${fmtTime(pt._telAt, { hour12: false, hour: '2-digit', minute: '2-digit' })}`);
    }
    if (popts.latest && pt._netNow) notes.push('rede: estado atual do aparelho');
    const noteHtml = notes.length ? `<br><em style="opacity:.7">${escHtml(notes.join(' · '))}</em>` : '';
    const fonte = sourceLabelPt(pt.serviceType || pt.src || pt._src);
    const fw = pt.fw ? escHtml(pt.fw) : dash;
    return `<div class="trail-popup">
<strong>Horário</strong> ${escHtml(hora)}<br>
<strong>Lat / Lon</strong> ${escHtml(lat)} / ${escHtml(lon)}<br>
<strong>Bateria</strong> ${escHtml(bat)}<br>
<strong>Status</strong> ${escHtml(status)}<br>
<strong>Ambiente</strong> ${escHtml(ambiente)}<br>
<strong>Rede</strong> ${escHtml(rede)}<br>
<strong>Fonte</strong> ${escHtml(fonte)}${popts.kmh != null ? `<br><strong>Velocidade</strong> ${Math.round(popts.kmh)} km/h <em style="opacity:.7">(estimada entre pontos)</em>` : ''}${popts.note ? `<br><em style="opacity:.7">${escHtml(popts.note)}</em>` : ''}
${pt.fw ? `<br><strong>FW</strong> ${fw}` : ''}${noteHtml}
</div>`;
}
function clearTrailMarkers() {
    if (trailMarkersLayer) trailMarkersLayer.clearLayers();
}
/** v33: mantido por compatibilidade — os pontos agora são desenhados por refreshRoute() (respeitando os filtros). */
function renderTrailMarkers() { refreshRoute(); }

/* ---------- v33: rota nas ruas (map matching) + filtros ---------- */
const ROUTE_FILTERS_KEY = 'thingy_route_filters_v1';
const ESRI_ATTR = 'Tiles © Esri — Esri, DeLorme, NAVTEQ, TomTom, Intermap, USGS, FAO, NPS, NRCAN, GeoBase, Kadaster NL, Ordnance Survey, METI, and the GIS User Community';
// CARTO (rastertiles) passou a exigir chave de API ("API KEY REQUIRED" nos tiles) — por isso o claro/escuro são os Canvas cinza da Esri (sem chave, com atribuição).
const BASEMAPS = {
    light: { name: 'Claro', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', maxZoom: 19, maxNativeZoom: 16, dark: false, attr: ESRI_ATTR },
    dark: { name: 'Escuro', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', maxZoom: 19, maxNativeZoom: 16, dark: true, attr: ESRI_ATTR },
    sat: { name: 'Satélite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19, maxNativeZoom: 19, dark: true,
        attr: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community' },
    osm: { name: 'OpenStreetMap', url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', subdomains: 'abc', maxZoom: 19, maxNativeZoom: 19, dark: false,
        attr: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }
};
let routeFilters = loadRouteFilters(), routeFiltersTouched = routeFiltersWereSaved();
let routeMatcher = null, routePrep = null, routeView = null, routeSig = null, routeFitPending = true;
let routeCanvas = null, routeSvg = null, routeLines = null, routeLive = null, routeArrows = null, routePins = null, baseLayer = null;
let routeRefreshTimer = null, routeAutoAll = false, routeNodeOf = new WeakMap(), routeLastFollowSig = null;

function routeFiltersWereSaved() { try { return !!localStorage.getItem(ROUTE_FILTERS_KEY); } catch { return false; } }
function loadRouteFilters() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(ROUTE_FILTERS_KEY) || '{}') || {}; } catch { raw = {}; }
    if (typeof RouteCore === 'undefined') return raw; // route-core.js não carregou: o resto do painel segue funcionando
    const f = RouteCore.normalizeFilters(raw);
    f.follow = !!raw.follow;
    return f;
}
function saveRouteFilters() {
    try { localStorage.setItem(ROUTE_FILTERS_KEY, JSON.stringify(routeFilters)); } catch { /* quota */ }
}
function fmtDurMs(ms) {
    if (!(ms > 0)) return '0 min';
    const min = Math.round(ms / 60000);
    if (min < 1) return '<1 min';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    if (h >= 48) return `${Math.round(h / 24)} d`;
    return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}
function fmtKmM(m) { const km = m / 1000; return km >= 10 ? `${km.toFixed(0)} km` : km >= 1 ? `${km.toFixed(1)} km` : `${Math.round(m)} m`; }

function setBasemap(name) {
    if (!map) return;
    const b = BASEMAPS[name] || BASEMAPS.light;
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = L.tileLayer(b.url, { attribution: b.attr, maxZoom: b.maxZoom, maxNativeZoom: b.maxNativeZoom, subdomains: b.subdomains || 'abc' });
    baseLayer.addTo(map);
    baseLayer.bringToBack();
    map.getContainer().classList.toggle('route-dark', !!b.dark);
}
function initRouteLayer() {
    routeCanvas = L.canvas({ padding: 0.4, tolerance: 6 });
    routeSvg = L.svg({ padding: 0.4 });
    routeLines = L.layerGroup().addTo(map);
    routeLive = L.layerGroup().addTo(map);
    routeArrows = L.layerGroup().addTo(map);
    routePins = L.layerGroup().addTo(map);
    setBasemap(routeFilters.base);
    map.attributionControl.addAttribution('Ajuste às ruas: <a href="https://valhalla1.openstreetmap.de/">Valhalla</a>/<a href="https://project-osrm.org/">OSRM</a> (FOSSGIS) · dados OSM');
    routeMatcher = RouteCore.createMatcher({ storage: window.localStorage, onUpdate: () => scheduleRouteRefresh() });
    map.on('moveend zoomend', () => { try { drawRouteArrows(); } catch { /* ignore */ } });
    map.on('dragstart', () => { if (routeFilters.follow) { routeFilters.follow = false; saveRouteFilters(); syncRouteUi(); } });
    setInterval(() => { try { refreshRoute({}); } catch { /* ignore */ } }, 30000);
    syncRouteUi();
}
function clearRouteLayers() {
    [routeLines, routeLive, routeArrows, routePins].forEach(g => g && g.clearLayers());
    if (trailMarkersLayer) trailMarkersLayer.clearLayers();
    routeView = null;
}
function scheduleRouteRefresh() {
    if (routeRefreshTimer) return;
    routeRefreshTimer = setTimeout(() => { routeRefreshTimer = null; try { refreshRoute({}); } catch (e) { console.warn('rota', e); } }, 200);
}
function playbackPts() {
    if (routeView && routeView.points) return routeView.points.filter(p => p.anchor).map(p => p.pt);
    return lastTrail || [];
}
function snappedLatLng(pt) {
    try {
        const node = routeNodeOf.get(pt);
        const sn = node && routeMatcher && routeFilters.snap ? routeMatcher.snap(node) : null;
        if (sn) return sn;
    } catch { /* ignore */ }
    return [Number(pt.lat), Number(pt.lon)];
}
function refreshRoute(opts = {}) {
    if (!map || typeof RouteCore === 'undefined' || !routeLines) return;
    if (!trailEnabled) { clearRouteLayers(); return; }
    const pts = lastTrailAll && lastTrailAll.length ? lastTrailAll : (lastTrail || []);
    const first = pts[0], last = pts[pts.length - 1];
    const sig = `${pts.length}|${first?.at}|${last?.at}|${last?.lat}`;
    if (!routePrep || sig !== routeSig) {
        routeSig = sig;
        routePrep = RouteCore.prepare(pts, { now: Date.now() });
        routeNodeOf = new WeakMap();
        routePrep.segments.forEach(sg => sg.nodes.forEach(n => n.members.forEach(m => routeNodeOf.set(m, n))));
        if (routeFilters.snap) routeMatcher.update(routePrep.segments);
    }
    const now = Date.now();
    const lookup = routeFilters.snap ? k => routeMatcher.lookup(k) : null;
    let view = RouteCore.computeView(routePrep, routeFilters, lookup, now);
    routeAutoAll = false;
    if (!routeFiltersTouched && routeFilters.period === 'today' && !view.points.length && routePrep.good.length) {
        view = RouteCore.computeView(routePrep, { ...routeFilters, period: 'all' }, lookup, now);
        routeAutoAll = true;
    }
    routeView = view;
    drawRoute(view);
    updateRouteSummary(view);
    updateRouteBadge(view);
    syncRouteUi();
    if (routeFitPending && !routeFilters.follow && fitRoute(true)) routeFitPending = false;
    if (routeFilters.follow) followDevice();
    if (opts.trailChanged === false) return;
    try { syncPlaybackUiFromTrail(); } catch (e) { console.warn('playback', e); }
}
function pairPopupHtml(p) {
    const end = p.b.pt;
    const note = p.quality === 'direct' ? 'trecho em linha direta (sem ajuste às ruas)' : (p.quality === 'routed' ? 'trecho por rota entre pontos' : (p.estimated ? 'trajeto estimado entre pontos distantes no tempo' : ''));
    return buildTrailPopupHtml(end, { latest: end === newestPoint(lastTrail), kmh: p.kmh, note });
}
function drawRoute(view) {
    routeLines.clearLayers(); routeLive.clearLayers(); routePins.clearLayers();
    trailMarkersLayer.clearLayers();
    const f = routeFilters, base = BASEMAPS[f.base] || BASEMAPS.light;
    const casing = base.dark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.95)';
    const pairs = view.pairs;
    // 1) contornos (embaixo), 2) linhas coloridas (em cima)
    pairs.forEach(p => {
        if (!p.geom) return;
        L.polyline(p.geom, { renderer: routeCanvas, color: casing, weight: 9, opacity: 0.9, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(routeLines);
    });
    pairs.forEach(p => {
        const dash = p.estimated ? '10 8' : null;
        let line;
        if (p.geom) {
            line = L.polyline(p.geom, { renderer: routeCanvas, color: RouteCore.pairColor(p, f.colorBy), weight: 5, opacity: 0.97, lineCap: 'round', lineJoin: 'round', dashArray: dash });
            line.options.routeQ = p.quality;
        } else {
            line = L.polyline([[p.a.lat, p.a.lon], [p.b.lat, p.b.lon]], { renderer: routeCanvas, color: base.dark ? '#cbd5e1' : '#4b5563', weight: 2, opacity: 0.9, dashArray: '4 6', lineCap: 'butt' });
            line.options.routeQ = 'direct';
        }
        line.on('click', e => { L.popup({ maxWidth: 280, className: 'trail-popup-wrap' }).setLatLng(e.latlng).setContent(pairPopupHtml(p)).openOn(map); });
        line.addTo(routeLines);
    });
    // trecho mais recente animado (SVG, tracejado correndo)
    if (f.animate && pairs.length) {
        const lastT = pairs[pairs.length - 1].b.t;
        pairs.filter(p => lastT - p.b.t <= 5 * 60 * 1000).slice(-10).forEach(p => {
            const g = p.geom || [[p.a.lat, p.a.lon], [p.b.lat, p.b.lon]];
            L.polyline(g, { renderer: routeSvg, color: '#ffffff', weight: 2.5, opacity: 0.95, className: 'route-live', interactive: false }).addTo(routeLive);
        });
    }
    // início / fim
    if (pairs.length) {
        const a = pairs[0].a, b = pairs[pairs.length - 1].b;
        const pin = (cls, txt, ll, tip) => L.marker(ll, { icon: L.divIcon({ className: `route-pin ${cls}`, html: `<span>${txt}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }), keyboard: false, zIndexOffset: 400 })
            .bindTooltip(tip, { direction: 'top', offset: [0, -10] }).addTo(routePins);
        pin('start', 'I', [a.lat, a.lon], `Início · ${fmtDateTime(a.t, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`);
        pin('end', 'F', [b.lat, b.lon], `Fim · ${fmtDateTime(b.t, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`);
    }
    // paradas
    view.stops.forEach(s => {
        const hh = t => fmtTime(t, { hour: '2-digit', minute: '2-digit' });
        const html = `<div class="trail-popup"><strong>Parada</strong> ${escHtml(fmtDurMs(s.durMs))}${s.ongoing ? ' (em andamento)' : ''}<br><strong>Das</strong> ${hh(s.startT)} <strong>às</strong> ${hh(s.endT)}<br><strong>Fixes</strong> ${s.count}<br><strong>Local</strong> ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</div>`;
        L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'route-pin stop', html: '<span>P</span>', iconSize: [24, 24], iconAnchor: [12, 12] }), keyboard: false, zIndexOffset: 300 })
            .bindTooltip(`Parada · ${fmtDurMs(s.durMs)}`, { direction: 'top', offset: [0, -10] })
            .bindPopup(html, { maxWidth: 260, className: 'trail-popup-wrap' }).addTo(routePins);
    });
    // pontos brutos (opcional) + descartados
    const newest = newestPoint(lastTrail);
    if (f.raw) {
        const srcColor = { gnss: '#0984e3', wifi: '#00b894', cell: '#e17055' };
        view.points.forEach(vp => {
            if (vp.pt === newest || !vp.anchor) return;
            const cls = RouteCore.sourceClass(vp.pt);
            const cm = L.circleMarker([Number(vp.pt.lat), Number(vp.pt.lon)], { renderer: routeCanvas, radius: vp.stopped ? 3 : 4, color: '#fff', weight: 1, fillColor: srcColor[cls], fillOpacity: 0.9 });
            cm.bindPopup(() => buildTrailPopupHtml(vp.pt, { latest: false, kmh: vp.kmh }), { maxWidth: 280, className: 'trail-popup-wrap' });
            trailMarkersLayer.addLayer(cm);
        });
        view.rejected.forEach(r => {
            if (!r.pt || r.pt.lat == null) return;
            const why = r.reason === 'acuracia' ? `acurácia ruim (${Math.round(r.unc)} m)` : r.reason === 'salto' ? 'salto implausível' : 'inválido';
            const cm = L.circleMarker([Number(r.pt.lat), Number(r.pt.lon)], { renderer: routeCanvas, radius: 4, color: '#94a3b8', weight: 1, fillOpacity: 0, dashArray: '2 2' });
            cm.bindTooltip(`Descartado da linha: ${why}`);
            trailMarkersLayer.addLayer(cm);
        });
    }
    // ponto mais recente: sempre visível, com o popup completo (presença única)
    if (newest) {
        const cm = L.circleMarker([Number(newest.lat), Number(newest.lon)], { radius: 8, color: '#E20074', weight: 2, fillColor: '#E20074', fillOpacity: 0.95, opacity: 0.9 });
        cm.bindPopup(() => buildTrailPopupHtml(newest, { latest: true }), { maxWidth: 280, className: 'trail-popup-wrap' });
        trailMarkersLayer.addLayer(cm);
    }
    drawRouteArrows();
    drawRouteLegend();
}
function drawRouteArrows() {
    if (!routeArrows || !map) return;
    routeArrows.clearLayers();
    if (!routeFilters.arrows || !routeView) return;
    const bounds = map.getBounds().pad(0.1), taken = [];
    routeView.pairs.forEach(p => {
        const g = p.geom || [[p.a.lat, p.a.lon], [p.b.lat, p.b.lon]];
        if (p.lenM < 60) return;
        let i = Math.max(0, Math.floor((g.length - 1) / 2));
        if (g.length === 2) i = 0;
        const from = g[i], to = g[Math.min(i + 1, g.length - 1)];
        const at = g.length === 2 ? [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2] : from;
        if (!bounds.contains(at)) return;
        const pt = map.latLngToContainerPoint(at);
        if (taken.some(q => Math.abs(q.x - pt.x) < 70 && Math.abs(q.y - pt.y) < 70)) return;
        taken.push(pt);
        const brg = RouteCore.bearing(from[0], from[1], to[0], to[1]);
        const color = p.geom ? '#ffffff' : '#e5e7eb';
        L.marker(at, { interactive: false, keyboard: false, icon: L.divIcon({ className: 'route-arrow', iconSize: [14, 14], iconAnchor: [7, 7],
            html: `<svg width="14" height="14" viewBox="0 0 14 14" style="transform:rotate(${brg.toFixed(0)}deg)"><path d="M7 1 L12.5 12.5 L7 9.6 L1.5 12.5 Z" fill="${color}" stroke="#111827" stroke-width="1.2" stroke-linejoin="round"/></svg>` }) }).addTo(routeArrows);
    });
}
function drawRouteLegend() {
    const el = $('routeLegend'); if (!el) return;
    const grad = (ramp, max) => `linear-gradient(90deg, ${ramp.map(([v, c]) => `${c} ${(v / max * 100).toFixed(0)}%`).join(', ')})`;
    const by = routeFilters.colorBy;
    let bar = '', lbl = '';
    if (by === 'hour') { bar = grad(RouteCore.HOUR_RAMP, 24); lbl = '<span>0 h</span><span>12 h</span><span>24 h</span>'; }
    else if (by === 'battery') { bar = grad(RouteCore.BAT_RAMP, 100); lbl = '<span>0%</span><span>50%</span><span>100%</span>'; }
    else { bar = grad(RouteCore.SPEED_RAMP, 110); lbl = '<span>0</span><span>55</span><span>110+ km/h</span>'; }
    el.innerHTML = `<span>Cor:</span><span class="bar" style="background:${bar}"></span>${lbl}<span class="sw"></span>linha direta<span class="sw est"></span>trecho estimado`;
}
function updateRouteSummary(view) {
    const el = $('routeSummary'); if (!el) return;
    const s = view.stats, f = routeFilters;
    if (!s.nPoints && !s.nPairs && !view.stops.length) {
        el.textContent = (lastTrail || []).length ? 'Nenhum ponto neste filtro — amplie o período ou limpe os filtros.' : 'Sem pontos de localização ainda.';
        return;
    }
    const it = (k, v) => `<span class="rs-item"><small>${k}</small>${escHtml(v)}</span>`;
    const parts = [];
    if (routeAutoAll) parts.push('<span class="rs-item"><small>Sem pontos hoje —</small>mostrando todo o período carregado</span>');
    parts.push(it('Distância', s.nPairs ? fmtKmM(s.distM) : '—'));
    parts.push(it('Em movimento', s.nPairs ? fmtDurMs(s.movingMs) : '—'));
    parts.push(it('Parado', f.mode === 'move' || (f.vmin != null && f.vmin > 0) ? '—' : `${fmtDurMs(s.stoppedMs)}${s.nStops ? ` (${s.nStops} parada${s.nStops > 1 ? 's' : ''})` : ''}`));
    parts.push(it('Média', s.avgKmh != null ? `${Math.round(s.avgKmh)} km/h` : '—'));
    parts.push(it('Máx.', s.maxKmh != null ? `${Math.round(s.maxKmh)} km/h` : '—'));
    parts.push(it('Pontos', String(s.nPoints)));
    el.innerHTML = parts.join('');
    el.title = 'Calculado só com os pontos que passam nos filtros. Velocidade = média entre dois pontos consecutivos (o aparelho não envia velocidade instantânea).';
}
function updateRouteBadge(view) {
    const el = $('routeBadge'); if (!el) return;
    const q = view.stats.quality, total = q.matched + q.routed + q.direct;
    const st = routeMatcher ? routeMatcher.status : null;
    let cls = 'direct', txt = 'Sem trilha', title = '';
    const svcDown = st && st.services.valhalla === 'down' && st.services.osrm === 'down';
    if (!routeFilters.snap) { txt = 'Linha direta · ajuste desligado'; title = 'O ajuste às ruas está desligado: os pontos são ligados em linha reta.'; }
    else if (!total) { txt = view.stats.nPoints ? 'Sem trechos' : 'Sem trilha'; }
    else if (st && st.state === 'matching' && st.total) { cls = 'busy'; txt = `Ajustando às ruas… ${st.done}/${st.total}`; title = 'Consultando o serviço de mapas (Valhalla/OSM). Os trechos novos aparecem em linha direta até terminar.'; }
    else if (q.direct === 0 && q.routed === 0) { cls = 'ok'; txt = 'Ajustado às ruas'; title = `${q.matched} trecho(s) seguindo as vias (Valhalla · OpenStreetMap).`; }
    else if (q.matched === 0 && q.direct === 0 && q.routed > 0) { cls = 'warn'; txt = 'Rota entre pontos (serviço alternativo)'; title = `${q.routed} trecho(s) calculados como rota entre os pontos (OSRM); menos exatos que o ajuste do Valhalla.`; }
    else if (q.matched === 0 && q.routed === 0) { cls = 'direct'; txt = svcDown ? 'Linha direta · serviço de ruas indisponível' : 'Linha direta'; title = svcDown ? 'Valhalla e OSRM não responderam; tentando de novo em alguns minutos. A linha reta tracejada é só uma aproximação.' : 'Não foi possível ajustar estes trechos às ruas (pontos longe das vias, ruins ou muito espaçados).'; }
    else { cls = 'warn'; txt = q.matched + q.routed ? 'Parcialmente ajustado às ruas' : 'Linha direta'; title = `${q.matched} ajustado(s), ${q.routed} por rota entre pontos, ${q.direct} em linha direta.`; }
    el.className = `route-badge ${cls}`; el.textContent = txt; el.title = title;
}
function routeBounds() {
    if (!routeView) return null;
    const b = L.latLngBounds([]);
    routeView.pairs.forEach(p => { (p.geom || [[p.a.lat, p.a.lon], [p.b.lat, p.b.lon]]).forEach(g => b.extend(g)); });
    if (!b.isValid()) routeView.points.forEach(p => b.extend([Number(p.pt.lat), Number(p.pt.lon)]));
    if (!b.isValid()) routeView.stops.forEach(s => b.extend([s.lat, s.lon]));
    return b.isValid() ? b : null;
}
function fitRoute(auto) {
    const b = routeBounds();
    if (!b) return false;
    try { map.fitBounds(b, { padding: [40, 40], maxZoom: 16 }); return true; } catch { return false; }
}
function followDevice() {
    const n = newestPoint(lastTrail);
    if (!n || !map) return;
    const sig = `${n.at}|${n.lat}|${n.lon}`;
    const first = routeLastFollowSig === null, changed = sig !== routeLastFollowSig;
    routeLastFollowSig = sig;
    const ll = [Number(n.lat), Number(n.lon)];
    const inView = map.getBounds().pad(-0.25).contains(ll);
    if (!changed && inView) return;
    // setView com zoom animado é ignorado pelo Leaflet se outra animação de zoom estiver rodando → sem animação
    if (first && map.getZoom() < 15) map.setView(ll, 16, { animate: false });
    else map.panTo(ll, { animate: true, duration: 0.4 });
}
/** Garante que a trilha carregada cobre o período pedido (24h/7d/30d/90d da nuvem). */
function ensureTrailCovers(sinceMs) {
    const sel = elements.trailRange; if (!sel || !isFinite(sinceMs)) return;
    const needH = (Date.now() - sinceMs) / 3600000;
    const cur = Number(sel.value);
    if (cur >= needH) return;
    const opt = [...sel.options].map(o => Number(o.value)).sort((a, b) => a - b).find(v => v >= needH) || Math.max(...[...sel.options].map(o => Number(o.value)));
    if (opt && opt !== cur) { sel.value = String(opt); loadTrail({ full: true }); }
}
function spLocalInput(ms) { return ms == null ? '' : new Date(ms - 3 * 3600e3).toISOString().slice(0, 16); }
function parseSpLocal(v) { if (!v) return null; const t = Date.parse(`${v}:00-03:00`); return Number.isFinite(t) ? t : null; }
function syncRouteUi() {
    const f = routeFilters, eff = routeAutoAll ? 'all' : f.period;
    document.querySelectorAll('#rfPeriod .rf-chip').forEach(b => b.classList.toggle('active', b.dataset.period === eff));
    document.querySelectorAll('#rfMode button').forEach(b => b.classList.toggle('active', b.dataset.mode === f.mode));
    const set = (id, v) => { const e = $(id); if (e && document.activeElement !== e) { if (e.type === 'checkbox') e.checked = !!v; else e.value = v == null ? '' : v; } };
    set('rfVmin', f.vmin); set('rfVmax', f.vmax); set('rfGnss', f.gnss); set('rfWifi', f.wifi); set('rfCell', f.cell);
    set('rfColor', f.colorBy); set('rfBase', f.base); set('rfSnap', f.snap); set('rfRaw', f.raw); set('rfArrows', f.arrows); set('rfAnimate', f.animate); set('rfFollow', f.follow);
    set('rfFrom', spLocalInput(f.from)); set('rfTo', spLocalInput(f.to));
    const cu = $('rfCustom'); if (cu) cu.hidden = f.period !== 'custom';
}
function onRouteFilterChange(patch, { fit = true, touched = true } = {}) {
    Object.assign(routeFilters, patch);
    routeFilters = RouteCore.normalizeFilters({ ...routeFilters, follow: routeFilters.follow });
    if (touched) routeFiltersTouched = true;
    saveRouteFilters();
    if (patch.base) setBasemap(routeFilters.base);
    if (fit) routeFitPending = true;
    refreshRoute({});
}
function setRoutePeriod(p) {
    const patch = { period: p };
    const now = Date.now();
    if (p === 'yesterday' || p === '7d') ensureTrailCovers(RouteCore.periodWindow({ period: p }, now).t0);
    if (p === 'all') ensureTrailCovers(now - 7 * 86400e3);
    if (p === 'live') patch.follow = true;
    if (p === 'custom') {
        if (routeFilters.from == null) patch.from = RouteCore.startOfDaySP(now);
        ensureTrailCovers(patch.from ?? routeFilters.from);
    }
    onRouteFilterChange(patch);
}
function wireRouteUi() {
    document.querySelectorAll('#rfPeriod .rf-chip').forEach(b => b.addEventListener('click', () => setRoutePeriod(b.dataset.period)));
    document.querySelectorAll('#rfMode button').forEach(b => b.addEventListener('click', () => onRouteFilterChange({ mode: b.dataset.mode })));
    const num = id => { const e = $(id); return e && e.value !== '' ? Number(e.value) : null; };
    $('rfVmin')?.addEventListener('change', () => onRouteFilterChange({ vmin: num('rfVmin'), vmax: num('rfVmax') }));
    $('rfVmax')?.addEventListener('change', () => onRouteFilterChange({ vmin: num('rfVmin'), vmax: num('rfVmax') }));
    [['rfGnss', 'gnss'], ['rfWifi', 'wifi'], ['rfCell', 'cell']].forEach(([id, k]) => $(id)?.addEventListener('change', e => onRouteFilterChange({ [k]: e.target.checked })));
    $('rfColor')?.addEventListener('change', e => onRouteFilterChange({ colorBy: e.target.value }, { fit: false }));
    $('rfBase')?.addEventListener('change', e => onRouteFilterChange({ base: e.target.value }, { fit: false }));
    $('rfRaw')?.addEventListener('change', e => onRouteFilterChange({ raw: e.target.checked }, { fit: false }));
    $('rfArrows')?.addEventListener('change', e => onRouteFilterChange({ arrows: e.target.checked }, { fit: false }));
    $('rfAnimate')?.addEventListener('change', e => onRouteFilterChange({ animate: e.target.checked }, { fit: false }));
    $('rfFollow')?.addEventListener('change', e => { routeLastFollowSig = null; onRouteFilterChange({ follow: e.target.checked }, { fit: false }); });
    $('rfSnap')?.addEventListener('change', e => {
        onRouteFilterChange({ snap: e.target.checked }, { fit: false });
        if (e.target.checked && routePrep && routeMatcher) { routeMatcher.clearFailures(); routeMatcher.update(routePrep.segments); }
    });
    const cust = () => { const from = parseSpLocal($('rfFrom')?.value), to = parseSpLocal($('rfTo')?.value); if (from != null) ensureTrailCovers(from); onRouteFilterChange({ period: 'custom', from, to }); };
    $('rfFrom')?.addEventListener('change', cust); $('rfTo')?.addEventListener('change', cust);
    $('rfFit')?.addEventListener('click', () => { if (!fitRoute(false)) log('warn', 'Nada para enquadrar neste filtro'); });
    $('rfReset')?.addEventListener('click', () => {
        const d = RouteCore.DEFAULT_FILTERS;
        onRouteFilterChange({ period: d.period, from: null, to: null, vmin: null, vmax: null, mode: 'all', gnss: true, wifi: true, cell: true }, {});
    });
    const det = $('routeFilters');
    try { if (localStorage.getItem('thingy_route_panel_closed') === '1' || (window.innerWidth < 700 && localStorage.getItem('thingy_route_panel_closed') == null)) det.open = false; } catch { /* ignore */ }
    det?.addEventListener('toggle', () => { try { localStorage.setItem('thingy_route_panel_closed', det.open ? '0' : '1'); } catch { /* ignore */ } });
    syncRouteUi();
}


/* ---------- Sparklines (SVG, no chart lib) ---------- */
const SPARK_MIN_PTS = 3;
function seriesFromTrail(pts, keyFn) {
    const out = [];
    for (const p of pts || []) {
        const v = keyFn(p);
        if (v == null || !Number.isFinite(Number(v))) continue;
        out.push(Number(v));
    }
    return out;
}
function batterySeries(pts) {
    return seriesFromTrail(pts, p => {
        if (p.battery != null) return Number(p.battery);
        if (p.batteryPct != null) return Number(p.batteryPct);
        if (p.batteryVoltage != null || p.batteryV != null) {
            let v = Number(p.batteryVoltage ?? p.batteryV);
            if (v > 1000) v = v / 1000;
            if (!Number.isFinite(v)) return null;
            return Math.max(0, Math.min(100, Math.round((v - 3.2) / 1.0 * 100)));
        }
        return null;
    });
}
function rsrpSeries(pts) {
    return seriesFromTrail(pts, p => (p.rsrp != null ? Number(p.rsrp) : null));
}
function sparklineSvg(values, { stroke = '#0984e3', w = 72, h = 22 } = {}) {
    if (!values || values.length < SPARK_MIN_PTS) {
        return '<span class="spark-empty">histórico insuficiente</span>';
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = (max - min) || 1;
    const n = values.length;
    const pts = values.map((v, i) => {
        const x = (i / (n - 1)) * (w - 2) + 1;
        const y = h - 2 - ((v - min) / span) * (h - 4);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points="${pts}"/></svg>`;
}
function renderSpark(el, values, stroke) {
    if (!el) return;
    el.innerHTML = sparklineSvg(values, { stroke });
}
function updateSparklines(trailPts) {
    const bat = batterySeries(trailPts);
    const rsrp = rsrpSeries(trailPts);
    renderSpark(elements.sparkBat, bat, '#00b894');
    renderSpark(elements.sparkBatSit, bat, '#00b894');
    renderSpark(elements.sparkRsrp, rsrp, '#0984e3');
    renderSpark(elements.sparkRsrpSit, rsrp, '#0984e3');
}

/* ---------- Trail playback (ghost marker) ---------- */
function ensurePlaybackGhost() {
    if (!map || playbackGhost) return playbackGhost;
    playbackGhost = L.circleMarker([0, 0], {
        radius: 9,
        color: '#6c5ce7',
        weight: 2,
        fillColor: '#a29bfe',
        fillOpacity: 0.9,
        opacity: 0.95,
        className: 'playback-ghost',
    });
    playbackGhost.setStyle({ opacity: 0, fillOpacity: 0 });
    playbackGhost.addTo(map);
    return playbackGhost;
}
function formatPlaybackChip(pt, idx, total) {
    if (!pt) return 'Sem trilha';
    const when = pt.at ? new Date(pt.at) : null;
    const hora = when && !Number.isNaN(when.getTime())
        ? fmtDateTime(pt.at, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : 'sem horário';
    const parts = [`#${idx + 1}/${total}`, hora];
    let bat = pt.battery ?? pt.batteryPct;
    if (bat == null && (pt.batteryVoltage != null || pt.batteryV != null)) {
        let v = Number(pt.batteryVoltage ?? pt.batteryV);
        if (v > 1000) v /= 1000;
        if (Number.isFinite(v)) bat = Math.max(0, Math.min(100, Math.round((v - 3.2) / 1.0 * 100)));
    }
    if (bat != null) parts.push(`Bat ${Math.round(Number(bat))}%`);
    if (pt.rsrp != null) parts.push(`RSRP ${pt.rsrp} dBm`);
    return parts.join(' · ');
}
function showPlaybackAt(index, { openPopup = false } = {}) {
    const pts = playbackPts();
    if (!pts.length) {
        stopPlayback();
        if (elements.playbackScrub) { elements.playbackScrub.disabled = true; elements.playbackScrub.max = 0; elements.playbackScrub.value = 0; }
        if (elements.playbackChip) {
            elements.playbackChip.textContent = 'Sem pontos na trilha';
            elements.playbackChip.classList.add('empty');
            elements.playbackChip.classList.remove('active');
        }
        if (playbackGhost) playbackGhost.setStyle({ opacity: 0, fillOpacity: 0 });
        return;
    }
    const i = Math.max(0, Math.min(pts.length - 1, Number(index) || 0));
    playback.index = i;
    const pt = pts[i];
    if (elements.playbackScrub) {
        elements.playbackScrub.disabled = false;
        elements.playbackScrub.max = String(pts.length - 1);
        elements.playbackScrub.value = String(i);
    }
    if (elements.playbackChip) {
        elements.playbackChip.textContent = formatPlaybackChip(pt, i, pts.length);
        elements.playbackChip.classList.remove('empty');
        elements.playbackChip.classList.add('active');
    }
    if (pt.lat == null || pt.lon == null) return;
    const g = ensurePlaybackGhost();
    if (!g) return;
    g.setLatLng(snappedLatLng(pt)); // v33: o fantasma anda em cima da rua ajustada
    g.setStyle({ opacity: 0.95, fillOpacity: 0.9 });
    g.bindPopup(buildTrailPopupHtml(pt, { latest: i === pts.length - 1 }), { maxWidth: 280, className: 'trail-popup-wrap' });
    if (openPopup) { try { g.openPopup(); } catch { /* ignore */ } }
}
function stopPlayback() {
    playback.playing = false;
    if (playback.timer) { clearInterval(playback.timer); playback.timer = null; }
    if (elements.playbackPlay) elements.playbackPlay.textContent = '▶';
}
function tickPlayback() {
    const pts = playbackPts();
    if (!pts.length) return stopPlayback();
    let next = playback.index + 1;
    if (next >= pts.length) { stopPlayback(); return; }
    showPlaybackAt(next);
}
function togglePlayback() {
    const pts = playbackPts();
    if (pts.length < 2) {
        if (elements.playbackChip) {
            elements.playbackChip.textContent = pts.length ? 'Precisa de ≥2 pontos' : 'Sem pontos na trilha';
            elements.playbackChip.classList.add('empty');
        }
        return;
    }
    if (playback.playing) { stopPlayback(); return; }
    playback.playing = true;
    playback.speed = Number(elements.playbackSpeed?.value || 1) || 1;
    if (elements.playbackPlay) elements.playbackPlay.textContent = '⏸';
    if (playback.index >= pts.length - 1) playback.index = 0;
    showPlaybackAt(playback.index);
    const ms = Math.max(120, Math.round(800 / playback.speed));
    playback.timer = setInterval(tickPlayback, ms);
}
function syncPlaybackUiFromTrail() {
    const pts = playbackPts();
    if (!pts.length) {
        stopPlayback();
        showPlaybackAt(0);
        return;
    }
    if (playback.index >= pts.length) playback.index = pts.length - 1;
    showPlaybackAt(playback.index);
}

/* ---------- Server alerts (Netlify on-demand) ---------- */
function mergeAlerts(clientAlerts, serverAlerts) {
    const byId = new Map();
    for (const a of clientAlerts || []) byId.set(a.id || a.text, a);
    for (const a of serverAlerts || []) {
        const id = a.id || a.text;
        if (!byId.has(id)) byId.set(id, {
            level: a.level === 'crítico' || a.level === 'critico' ? 'crítico'
                : a.level === 'atenção' || a.level === 'atencao' || a.level === 'atenção' ? 'atenção'
                : (a.level || 'atenção'),
            id,
            text: a.text || a.message || id,
            source: 'server',
        });
    }
    const rank = { crítico: 0, atenção: 1, ok: 2 };
    return [...byId.values()].sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9)).slice(0, INTEL.ALERTS_MAX || 5);
}
async function fetchServerAlerts() {
    const base = resolveAlertsUrl();
    if (!base || !config.deviceId || !config.apiKey) return;
    try {
        const auth = buildAuthHeader();
        if (!auth) return;
        const headers = {
            'Authorization': auth,
            'X-Memfault-Org': config.orgSlug || 'telekom',
            'X-Memfault-Project': config.projectSlug || 'nrf-project',
            'X-Org-Slug': config.orgSlug || 'telekom',
            'X-Project-Slug': config.projectSlug || 'nrf-project',
            'X-User-Api-Key': config.apiKey || '',
            'X-Device-Id': config.deviceId || '',
        };
        if (config.email) headers['X-User-Email'] = config.email;
        if (config.teamApiKey) headers['X-Nrf-Team-Key'] = config.teamApiKey;
        const url = `${base}?deviceId=${encodeURIComponent(config.deviceId)}`;
        const res = await fetch(url, { headers });
        if (!res.ok) return;
        const data = await res.json();
        lastServerAlerts = Array.isArray(data.alerts) ? data.alerts : [];
        // Re-render situação with merged alerts if we already have client ones
        updateSituacaoInteligente({ trailPts: lastTrail });
    } catch { /* soft — keep client alerts */ }
}
function scheduleServerAlerts() {
    if (serverAlertsTimer) clearInterval(serverAlertsTimer);
    if (!resolveAlertsUrl()) return;
    fetchServerAlerts();
    serverAlertsTimer = setInterval(fetchServerAlerts, 5 * 60 * 1000);
}

function applyTrailPoints(points) {
    const validPts = (points || []).filter(p => p && p.lat != null && p.lon != null);
    const deduped = dedupeConsecutive(validPts);
    lastTrail = deduped;
    // v33: o motor de rota usa TODOS os fixes (sem o dedupe de 15 m) — senão uma parada de 20 min vira 1 ponto e some a duração
    lastTrailAll = validPts;
    const km = trailDistanceKm(deduped);
    updateTrailPointsUI(deduped.length, km);
    if (lastTrailFitCount === 0) routeFitPending = true;
    lastTrailFitCount = deduped.length;
    // v33: linha ajustada às ruas + filtros + pontos (um único renderizador)
    try { refreshRoute({ trailChanged: true }); } catch (e) { console.warn('rota', e); }
    // Refresh autonomia / resumo / alertas that depend on trail
    // Sparklines/playback must never abort the poll loop
    try { updateSituacaoInteligente({ trailPts: deduped }); } catch (e) { console.warn('situacao', e); }
    try { updateSparklines(deduped); } catch (e) { console.warn('sparklines', e); }
    try { syncPlaybackUiFromTrail(); } catch (e) { console.warn('playback', e); }
    return deduped;
}
function applyPositionFromPoint(pt, srcLabel, force = false) {
    if (!pt || pt.lat == null || pt.lon == null) return false;
    // v32: nunca troca a posição atual por um ponto MAIS VELHO (era o bug do "Posição há 1d")
    const newMs = toTsMs(pt.at), curMs = toTsMs(lastGpsFix?.at);
    if (!force && newMs != null && curMs != null && newMs < curMs) return false;
    const lat = Number(pt.lat), lon = Number(pt.lon);
    setText(elements.gpsCoords, `${lat.toFixed(6)}, ${lon.toFixed(6)}`);
    setText(elements.gpsLat, lat.toFixed(6));
    setText(elements.gpsLon, lon.toFixed(6));
    if (pt.unc != null) setText(elements.gpsAcc, `${Math.round(pt.unc)} m`);
    setGpsSourceBadge(srcLabel || pt.serviceType || pt.src || 'trail');
    updateMap(lat, lon, pt.unc, { skipZoom: (lastTrail.length >= 2), appendTrail: false });
    checkGeofence(lat, lon);
    lastGpsFix = { lat, lon, at: pt.at || null };
    setDataAge(elements.gpsAge, pt.at || null, { missing: 'sem timestamp' });
    if (elements.gpsAge) elements.gpsAge.title = `${fmtDateTime(pt.at)} · fonte: ${sourceLabelPt(srcLabel || pt.serviceType || pt.src)}`;
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
async function fetchAndUpdate(opts = {}) {
    // Pausar poll enquanto o modal de config está aberto
    if (elements.configModal?.classList.contains('show')) return;
    if (!config.apiKey) {
        lastPollAuthFail = true;
        updateAuthBanner();
        setStatus(false, 'Sem chave');
        updateConnectivityStrip({ connected: null, parsed: {}, fromMsg: {} });
        updateSituacaoInteligente({ connected: null });
        showModal();
        return;
    }
    // v32: sem sobreposição de polls e respeita rate-limit (429)
    if (pollBusy) return;
    if (!opts.manual && Date.now() < rateLimitedUntil) return;
    pollBusy = true;
    if (opts.manual) setStripRefreshing(true);
    try {
        if (!config.deviceId || !deviceList.length) await loadFleet(true);
        if (!config.deviceId) throw new Error('Sem dispositivos na conta');
        const [{ device, latency }, msgs50, serial, appMsgs] = await Promise.all([
            getDevice(config.deviceId),
            getMessages(config.deviceId, 50).then(m => { cloudLocState.msgs = 'ok'; return m; }).catch(e => {
                cloudLocState.msgs = /HTTP (401|403)/.test(e.message) ? 'auth' : 'err';
                log('warn', 'Msgs falharam — tentando overlay serial', e.message);
                return [];
            }),
            fetchSerialTelemetry(),
            cloudLocState.msgs === 'auth' ? Promise.resolve(appMsgCache.items) : refreshAppMessages(),
        ]);
        lastLatencyMs = latency;
        // v32: junta as últimas 50 mensagens com o histórico por appId (BATTERY/TEMP/HUMID/AIR_PRESS)
        const messages = mergeMessageLists(msgs50, appMsgs);
        lastDeviceRaw = device; lastMessages = messages;
        let parsed = parseDevice(device), fromMsg = extractFromMessages(messages);
        lastMemfaultSeen = parsed.lastSeen || null;
        parsed = mergeCloudNetwork(parsed, fromMsg);
        if (fromMsg.rsrp != null || fromMsg.mccMnc || fromMsg.netSourceHint) telemetrySource.net = telemetrySource.net || 'cloud';
        const overlay = applySerialOverlay(fromMsg, parsed, serial || lastSerial);
        fromMsg = overlay.fromMsg; parsed = overlay.parsed;
        lastParsed = parsed; lastFromMsg = fromMsg;
        const ser = serial || lastSerial;
        const healthy = serialIsHealthy(ser);
        const hasGps = fromMsg.gps?.lat != null && fromMsg.gps?.lon != null;
        // Live fix → rich snapshot for trail (1 pt/min; clickable device state)
        if (hasGps && fromMsg.gpsAt) {
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
                at: fromMsg.gpsAt,            // v32: hora REAL do fix (antes usava a hora da última mensagem qualquer)
                src: fromMsg.gps.source || telemetrySource.gps || 'live',
                unc: fromMsg.gps.accuracy,
                serviceType: fromMsg.gps.source || null,
                battery: batPct,
                batteryVoltage: batV != null ? (Number(batV) > 1000 ? Number(batV) / 1000 : Number(batV)) : null,
                charging,
                connected: null,
                lastSeen: null,
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
            // v32: fallback = ponto MAIS RECENTE (por horário) da trilha da nuvem / local
            const fallback = newestPoint(lastTrail) || newestPoint(loadLocalTrailRaw().map(normalizeLocItem));
            if (fallback && applyPositionFromPoint(fallback, fallback.serviceType || fallback.src || 'trilha')) {
                // position shown from history/local
            } else if (lastGpsFix) {
                // já existe posição mostrada (mais nova ou igual) — mantém
            } else if (!healthy) {
                const onCloud = location.hostname.includes('github.io') || location.hostname.includes('netlify');
                setText(elements.gpsCoords, onCloud ? noPositionReason() : 'Sem fix — conecte o USB ou aguarde scan Wi‑Fi/célula');
                if (onCloud) setMapHint(noPositionReason());
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
        const presence = presenceFromParsed(parsed, fromMsg, { msgs: messages });
        lastPresence = presence;
        if (lastConnected !== null && lastConnected !== presence.connectedBool)
            log(presence.isOnline ? 'ok' : 'warn', presence.isOnline ? 'ATIVIDADE RECENTE' : (presence.isSleeping ? 'EM ESPERA' : 'SEM ATIVIDADE'), presence.activitySource || parsed.session || '');
        lastConnected = presence.connectedBool;
        lastPollAuthFail = false;
        updateAuthBanner();
        lastSuccessfulPollAt = Date.now();
        updateUI(parsed, fromMsg); renderMsgTable(messages); updateSourceBadge();
        refreshPresenceUi();
        pulseConnectivity();
        setStripRefreshing(false);
        const apps = Object.keys(fromMsg.byApp || {});
        const st = lastTrail.length ? [...new Set(lastTrail.map(t => t.serviceType).filter(Boolean))].join(',') : '';
        if (st) setText(elements.serviceType, st);
        const src = overlay.used ? ' +serial' : '';
        log('info', `Poll OK · ${messages.length} msgs [${apps.join(',') || '-'}]${src} · ${presence.activityAt ? timeAgo(presence.activityAt) : '—'}`, `fw ${parsed.firmware} · ${latency}ms · poll ${POLL_MS / 1000}s`);
        if (presence.isOffline) log('warn', `Offline por inatividade (${formatPresenceAge(presence) || 'sem ts'}). CoAP não mantém MQTT.`);
        else if (parsed.connected === false && presence.isOnline) log('info', 'Shadow connected=false (CoAP) — atividade recente → Online.', presence.activitySource || '');
        // Trilha/localização também é evidência de presença: recarrega e repinta tudo
        await loadTrail({ quiet: true });
    } catch (e) {
        const isAuth = /401|403|Nenhuma chave|Chave rejeitada|Sem API key/i.test(e.message);
        const short = isAuth ? 'Sem chave' : `Erro: ${e.message.slice(0, 48)}`;
        log('err', `Poll: ${e.message}`);
        setStatus(false, short);
        setStripRefreshing(false);
        if (isAuth) {
            lastPollAuthFail = true;
            updateAuthBanner();
            updateConnectivityStrip({ connected: false, parsed: {}, fromMsg: {} });
            showModal();
        } else {
            renderConnectivityAges();
        }
    } finally {
        pollBusy = false;
    }
}
/** Ponto mais recente (por horário) de uma lista de pontos de trilha. */
function newestPoint(list) {
    let best = null, bestMs = -Infinity;
    for (const p of list || []) {
        if (!p || p.lat == null || p.lon == null) continue;
        const t = toTsMs(p.at);
        const v = t != null ? t : -1e15;
        if (v >= bestMs) { best = p; bestMs = v; }
    }
    return best;
}
/* ---------- v32: histórico por appId (bateria/ambiente) ---------- */
const appMsgCache = { at: 0, deviceId: null, items: [] };
const APP_IDS = ['BATTERY', 'TEMP', 'HUMID', 'AIR_PRESS'];
async function refreshAppMessages() {
    if (appMsgCache.deviceId !== config.deviceId) { appMsgCache.items = []; appMsgCache.at = 0; appMsgCache.deviceId = config.deviceId; }
    if (Date.now() - appMsgCache.at < APP_HISTORY_MS) return appMsgCache.items;
    appMsgCache.at = Date.now(); // evita martelar mesmo em falha
    try {
        const res = await Promise.allSettled(APP_IDS.map(a => getMessagesByApp(config.deviceId, a, 100)));
        const items = [];
        for (const r of res) if (r.status === 'fulfilled') items.push(...r.value);
        if (items.length) appMsgCache.items = items;
    } catch { /* soft */ }
    return appMsgCache.items;
}
function mergeMessageLists(a, b) {
    const seen = new Set(), out = [];
    for (const m of [...(a || []), ...(b || [])]) {
        const k = `${PresenceCore.msgAppId(m)}|${PresenceCore.msgRecvMs(m)}|${JSON.stringify(m?.message?.data ?? '').slice(0, 40)}`;
        if (seen.has(k)) continue;
        seen.add(k); out.push(m);
    }
    out.sort((x, y) => (PresenceCore.msgRecvMs(y) || 0) - (PresenceCore.msgRecvMs(x) || 0));
    return out;
}
/** Séries por appId (asc) a partir das mensagens da nuvem. */
function buildAppSeries(msgs) {
    const S = { BATTERY: [], TEMP: [], HUMID: [], AIR_PRESS: [] };
    const alias = { BAT: 'BATTERY', TEMPERATURE: 'TEMP', HUMIDITY: 'HUMID', PRESSURE: 'AIR_PRESS', PRESS: 'AIR_PRESS' };
    for (const m of msgs || []) {
        let app = PresenceCore.msgAppId(m); app = alias[app] || app;
        if (!S[app]) continue;
        const ms = PresenceCore.msgRecvMs(m); if (ms == null) continue;
        const d = m.message?.data ?? m.data;
        let v = (d && typeof d === 'object') ? (d.value ?? d.v ?? d.percent ?? d.percentage ?? d.voltage ?? d.temp ?? d.humidity ?? d.pressure) : d;
        v = num(typeof v === 'string' ? v.trim() : v);
        if (v == null) continue;
        S[app].push({ ms, v });
    }
    for (const k of Object.keys(S)) S[k].sort((a, b) => a.ms - b.ms);
    return S;
}
function nearestSample(arr, ms, winMs) {
    if (!arr || !arr.length) return null;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].ms < ms) lo = mid + 1; else hi = mid; }
    let best = arr[lo];
    if (lo > 0 && Math.abs(arr[lo - 1].ms - ms) < Math.abs(best.ms - ms)) best = arr[lo - 1];
    return Math.abs(best.ms - ms) <= winMs ? best : null;
}
/** Anexa bateria/ambiente (mensagens BATTERY/TEMP/HUMID/AIR_PRESS da nuvem) e, no ponto mais recente, a rede atual. */
function enrichTrailWithCloudTelemetry(points) {
    const S = buildAppSeries(lastMessages);
    if (!points?.length) return points;
    const WIN = 30 * 60 * 1000;
    const newest = newestPoint(points);
    return points.map(pt => {
        const t = toTsMs(pt.at);
        if (t == null) return pt;
        const b = nearestSample(S.BATTERY, t, WIN);
        const te = nearestSample(S.TEMP, t, WIN), hu = nearestSample(S.HUMID, t, WIN), pr = nearestSample(S.AIR_PRESS, t, WIN);
        const out = { ...pt };
        let telAt = null;
        if (b && pt.battery == null && b.v >= 0 && b.v <= 100) { out.battery = Math.round(b.v); telAt = b.ms; } // ATT: BATTERY = % (número)
        if (te && pt.temp == null) { out.temp = te.v; telAt = telAt || te.ms; }
        if (hu && pt.hum == null) { out.hum = hu.v; telAt = telAt || hu.ms; }
        if (pr && pt.press == null) { out.press = normalizePressHpa(pr.v) ?? pr.v; telAt = telAt || pr.ms; }
        if (telAt) out._telAt = new Date(telAt).toISOString();
        if (pt === newest && lastParsed) {
            const P = lastParsed, F = lastFromMsg || {};
            const rsrp = F.rsrp ?? P.rsrp;
            if (out.rsrp == null && rsrp != null) { out.rsrp = rsrp; out._netNow = true; }
            if (!out.operator && (P.operator || P.mccMnc)) { out.operator = shortOperatorName(P) || P.operator; out._netNow = true; }
            if (P.band != null) { out.band = P.band; out._netNow = true; }
            if (P.networkMode) { out.networkMode = P.networkMode; out._netNow = true; }
        }
        return out;
    });
}
/** v30: overlay on the map explaining why there is no marker (null = hide). */
function setMapHint(text) {
    const host = document.getElementById('map');
    if (!host) return;
    let el = document.getElementById('mapEmptyHint');
    if (!text) { if (el) el.style.display = 'none'; return; }
    if (!el) {
        el = document.createElement('div');
        el.id = 'mapEmptyHint';
        el.className = 'map-empty-hint';
        host.appendChild(el);
    }
    el.textContent = text;
    el.style.display = '';
}
/** v30: human reason for an empty map (Pages / cloud-only). */
function noPositionReason() {
    const st = cloudLocState;
    if (st.msgs === 'auth' || st.hist === 'auth') {
        return 'Sem posição — nRF Cloud recusou a leitura de GPS/trilha (401): cole a API Key da equipe (Simple Token) na engrenagem.';
    }
    if (st.hist === 'ok' && st.histCount === 0) {
        return `Sem posição — nenhum fix (GNSS/Wi‑Fi/célula) na nuvem nas últimas ${st.hours}h. Leve o Thingy para céu aberto ou aguarde o próximo envio.`;
    }
    if (st.msgs === 'err' || st.hist === 'err') return 'Sem posição — falha ao consultar a nuvem (tente de novo em instantes).';
    return 'Sem fix — configure as chaves na engrenagem (cloud). USB só no Mac.';
}
async function loadTrail(opts = {}) {
    if (!config.deviceId || !trailEnabled) {
        updateTrailPointsUI(lastTrail.length, trailDistanceKm(lastTrail));
        return;
    }
    const quiet = !!opts.quiet;
    const hours = Number(elements.trailRange?.value || 168);
    // v32: poll normal busca só a página mais nova (1 request) a cada 60s; a trilha completa (10 págs)
    // só ao abrir, ao trocar período/aparelho, e a cada 10 min.
    const now = Date.now();
    const needFull = !!opts.full || !trailCache.pts.length || trailCache.key !== `${config.deviceId}|${hours}`
        || now - trailCache.fullAt > TRAIL_FULL_REFRESH_MS;
    if (!needFull && now - lastTrailFetchAt < TRAIL_REFRESH_MS) {
        applyTrailAndPresence(trailCache.merged, hours, quiet, { cloudOk: true });
        return;
    }
    let cloudItems = [];
    let cloudOk = false;
    let cloudErr = null;
    try {
        if (!quiet) log('info', `Trilha ${hours}h…`);
        cloudItems = needFull
            ? await getLocationHistory(config.deviceId, hours)
            : await getLocationHistory(config.deviceId, hours, { pages: 1, limit: 100 });
        cloudOk = true;
        cloudLocState.hist = 'ok';
        trailFailLogged = false;
        lastTrailFetchAt = now;
    } catch (e) {
        cloudErr = e;
        cloudLocState.hist = /HTTP (401|403)/.test(e.message) ? 'auth' : 'err';
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
    let cloudPts = (cloudItems || []).map(normalizeLocItem).filter(Boolean);
    if (cloudOk) {
        if (needFull) {
            trailCache = { key: `${config.deviceId}|${hours}`, fullAt: now, pts: cloudPts, merged: [] };
        } else {
            // funde a página nova com o cache (dedupe por horário+coordenada)
            const seen = new Set(trailCache.pts.map(p => `${p.at}|${p.lat}|${p.lon}`));
            for (const p of cloudPts) if (!seen.has(`${p.at}|${p.lat}|${p.lon}`)) trailCache.pts.push(p);
            cloudPts = trailCache.pts;
        }
        cloudLocState.histCount = trailCache.pts.length;
        cloudLocState.hours = hours;
        // v32: evidência de presença = localização vinda da NUVEM (guardada à parte, sem misturar com o cache local)
        lastCloudLocs = trailCache.pts.map(p => ({ recvAt: p.recvAt || p.at, at: p.at, serviceType: p.serviceType }));
        // Semeia o cache local só com pontos novos (coords + hora) — sem regravar o localStorage inteiro a cada poll
        seedLocalTrail(trailCache.pts);
    } else {
        cloudPts = trailCache.pts; // falhou: mantém o que já tínhamos
    }
    const cutoff = Date.now() - hours * 3600 * 1000;
    const localRaw = loadLocalTrailRaw();
    const localPts = localRaw
        .map(normalizeLocItem)
        .filter(Boolean)
        .filter(p => !p.at || new Date(p.at).getTime() >= cutoff);
    let merged = mergeTrailPoints(cloudPts, localPts); // v33: sem dedupe aqui (applyTrailPoints deduplica só lastTrail; a rota precisa dos fixes parados)
    merged = enrichWithLocalSnapshots(merged, localRaw);
    trailCache.merged = merged;
    applyTrailAndPresence(merged, hours, quiet, { cloudOk, cloudErr });
}
let trailCache = { key: null, fullAt: 0, pts: [], merged: [] };
function seedLocalTrail(pts) {
    const store = loadLocalTrailRaw();
    const have = new Set(store.map(p => `${p.at}|${Number(p.lat).toFixed(5)}|${Number(p.lon).toFixed(5)}`));
    let added = 0;
    for (const p of pts) {
        const k = `${p.at}|${Number(p.lat).toFixed(5)}|${Number(p.lon).toFixed(5)}`;
        if (have.has(k)) continue;
        accumulateLocalPoint({ ...p, src: p.src || 'cloud' });
        have.add(k); added++;
    }
    return added;
}
function applyTrailAndPresence(merged, hours, quiet, { cloudOk, cloudErr } = {}) {
    merged = enrichTrailWithCloudTelemetry(merged);
    const applied = applyTrailPoints(merged);
    const sts = [...new Set(applied.map(i => i.serviceType).filter(Boolean))];
    if (sts.length) setText(elements.serviceType, sts.join(', '));
    // Posição atual = ponto MAIS RECENTE (por horário) da trilha/mensagens; idade correta
    const last = newestPoint(applied);
    if (last) {
        applyPositionFromPoint(last, last.serviceType || last._src || 'trilha');
    } else {
        // v30: explain precisely why the map is empty (team key missing vs. no fixes in cloud)
        const gpsEl = elements.gpsCoords?.textContent || '';
        if (!gpsEl || gpsEl === '—' || /Sem fix|Sem posição/i.test(gpsEl)) {
            setText(elements.gpsCoords, noPositionReason());
            setMapHint(noPositionReason());
        }
    }
    // Keep geofence + situação in sync with trail-derived position
    try {
        const lat = lastGpsFix?.lat ?? last?.lat ?? marker?.getLatLng()?.lat;
        const lon = lastGpsFix?.lon ?? last?.lon ?? marker?.getLatLng()?.lng;
        refreshGeofenceUi(lat, lon);
    } catch { refreshGeofenceUi(null, null); }
    // v32: a localização da nuvem entra na presença → repinta header, strip, situação, alertas
    if (!refreshPresenceUi()) {
        updateSituacaoInteligente({ alias: getDeviceAlias(config.deviceId), connected: lastConnected, trailPts: applied });
    }
    if (!quiet) {
        if (applied.length) log('ok', `Trilha: ${applied.length} pts · ${trailDistanceKm(applied).toFixed(1)} km [${sts.join(',') || '?'}]`);
        else if (cloudOk) log('warn', 'Trilha vazia no período — aguardando fixes (local + nuvem)');
        else if (cloudErr) { /* already logged once */ }
    }
}
function init() {
    updateAuthBanner();
    setText(elements.connPoll, `${POLL_MS / 1000}s`);
    setText(elements.stripPollMs, `a cada ${POLL_MS / 1000}s`);
    startConnectivityAgeTicker();
    if (!config.apiKey) {
        setStatus(false, 'Sem chave');
        updateConnectivityStrip({ connected: null, parsed: {}, fromMsg: {} });
        updateSituacaoInteligente({ connected: null });
        showModal();
        log('warn', 'Sem User API Key / OAT');
        return;
    }
    updateSituacaoInteligente({});
    if (!config.email) log('info', 'Sem e-mail — usando Bearer (OAT) no Memfault.');
    if (!config.teamApiKey) log('warn', 'Sem API Key da equipe — GPS/sensores (ListMessages) vão dar 401.');
    initMap(); fetchAndUpdate(); loadTrail(); scheduleServerAlerts();
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(() => fetchAndUpdate(), POLL_MS);
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
    if (!trailEnabled) { clearRouteLayers(); clearTrailMarkers(); lastTrailFitCount = 0; }
    else { lastTrailFitCount = 0; routeFitPending = true; loadTrail(); }
});
elements.trailRange?.addEventListener('change', () => loadTrail({ full: true }));
wireRouteUi();
elements.playbackPlay?.addEventListener('click', togglePlayback);
elements.playbackSpeed?.addEventListener('change', () => {
    playback.speed = Number(elements.playbackSpeed.value || 1) || 1;
    if (playback.playing) { stopPlayback(); togglePlayback(); }
});
elements.playbackScrub?.addEventListener('input', () => {
    stopPlayback();
    showPlaybackAt(Number(elements.playbackScrub.value || 0), { openPopup: true });
});

elements.clearLog?.addEventListener('click', () => { logStore.length = 0; elements.logPanel.innerHTML = ''; });
elements.logFilter?.addEventListener('change', rerenderLog);
elements.exportLog?.addEventListener('click', () => { download(`thingy91x-log-${Date.now()}.json`, JSON.stringify(logStore, null, 2)); log('info', 'Log exportado'); });
elements.deviceSelect?.addEventListener('change', e => switchDevice(e.target.value));
elements.refreshFleet?.addEventListener('click', () => loadFleet(false));
elements.pollFleet?.addEventListener('click', () => loadFleet(false));
elements.refreshNowBtn?.addEventListener('click', () => {
    log('info', 'Atualizar agora (manual)');
    fetchAndUpdate({ manual: true });
});

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
        const m = String(e.message || e);
        let hint = 'Se 401/403: configure NRF_TEAM_WRITE_TOKEN no Netlify ou cole Simple Token na engrenagem — OAT só lê.';
        if (/Unexpected end of JSON|failed to execute ['"]json['"]/i.test(m)) {
            hint = 'Resposta vazia do proxy/nuvem (ex.: 204). Atualize para v26+; se persistir, confira proxy/Netlify.';
        } else if (/401|403/.test(m)) {
            hint = 'Auth: NRF_TEAM_WRITE_TOKEN no Netlify (preferido) ou Simple Token na engrenagem — OAT só lê.';
        }
        log('err', `Desired falhou: ${m}`, hint);
    }
});
elements.sendPing?.addEventListener('click', async () => {
    try {
        await sendC2D(config.deviceId, { ping: Date.now() });
        log('ok', 'Ping c2d enviado (SendDeviceMessage)');
    } catch (e) {
        log('err', `Ping: ${e.message}`, 'c2d: NRF_TEAM_WRITE_TOKEN no Netlify ou Simple Token; ATT costuma preferir shadow desired/command.');
    }
});

elements.geoSet?.addEventListener('click', () => {
    try {
        const p = marker.getLatLng(); if (!p || p.lat === 0) return log('warn', 'Sem posição atual');
        geo = { lat: p.lat, lon: p.lng, radius: Number(elements.geoRadius?.value || 500) };
        localStorage.setItem('thingy_geo', JSON.stringify(geo));
        restoreGeofence();
        refreshGeofenceUi(p.lat, p.lng);
        updateSituacaoInteligente({});
        log('ok', 'Geofence definido', `${geo.lat},${geo.lon} r=${geo.radius}m`);
    } catch { log('warn', 'Sem posição para geofence'); }
});
elements.geoClear?.addEventListener('click', () => {
    geo = null; localStorage.removeItem('thingy_geo');
    if (geoCircle && map) map.removeLayer(geoCircle); geoCircle = null;
    setText(elements.geoState, 'Sem cerca definida.'); if (elements.geoState) elements.geoState.style.color = '';
    updateSituacaoInteligente({});
    log('info', 'Geofence limpo');
});
if (elements.geoRadius && geo) elements.geoRadius.value = geo.radius;
if (geo && elements.geoState) setText(elements.geoState, 'Cerca ativa — aguardando fix.');
else if (elements.geoState) setText(elements.geoState, 'Sem cerca definida.');

elements.refreshFota?.addEventListener('click', async () => {
    try {
        const fw = await listFirmware();
        if (elements.fotaList) elements.fotaList.innerHTML = fw.map(f => `<option value="${escHtml(f.id || f.name)}">${escHtml(f.name || f.id)} (${escHtml(f.version || '')})</option>`).join('') || '<option value="">—</option>';
        const jobs = await listFotaJobs(config.deviceId);
        if (elements.fotaJobs) elements.fotaJobs.innerHTML = jobs.map(j => `<div class="msg-row"><span class="msg-app">${escHtml(j.status || j.state || '?')}</span><span>${escHtml(j.id || j.jobId)}</span></div>`).join('') || 'Sem jobs';
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
        const swHref = new URL('service-worker.js?v=32', document.baseURI || location.href).href;
        // Limpa caches antigos (Cmd+Shift+R no Safari muitas vezes não basta)
        const bustKey = 'thingy_sw_bust_v32';
        caches.keys().then(keys => Promise.all(keys.filter(k => k !== 'thingy91x-v32').map(k => caches.delete(k)))).catch(() => {});
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
