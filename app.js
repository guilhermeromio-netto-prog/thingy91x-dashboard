const NRF_CLOUD_BASE = '/.netlify/functions/nrfcloud';

let config = {
    apiKey: localStorage.getItem('nrf_api_key') || '',
    teamId: localStorage.getItem('nrf_team_id') || '',
    deviceId: localStorage.getItem('nrf_device_id') || ''
};

let map, marker, trailLayer = [], trailEnabled = true;
let pollInterval = null;
const POLL_MS = 10000;

const elements = {
    connectionStatus: document.getElementById('connectionStatus'),
    deviceId: document.getElementById('deviceId'),
    deviceName: document.getElementById('deviceName'),
    firmwareVersion: document.getElementById('firmwareVersion'),
    lastSeen: document.getElementById('lastSeen'),
    gpsLat: document.getElementById('gpsLat'),
    gpsLon: document.getElementById('gpsLon'),
    gpsAcc: document.getElementById('gpsAcc'),
    gpsSats: document.getElementById('gpsSats'),
    gpsAlt: document.getElementById('gpsAlt'),
    gpsSpeed: document.getElementById('gpsSpeed'),
    tempValue: document.getElementById('tempValue'),
    humValue: document.getElementById('humValue'),
    pressValue: document.getElementById('pressValue'),
    accelX: document.getElementById('accelX'),
    accelY: document.getElementById('accelY'),
    accelZ: document.getElementById('accelZ'),
    steps: document.getElementById('steps'),
    batteryFill: document.getElementById('batteryFill'),
    batteryValue: document.getElementById('batteryValue'),
    rsrp: document.getElementById('rsrp'),
    rsrq: document.getElementById('rsrq'),
    operator: document.getElementById('operator'),
    centerMap: document.getElementById('centerMap'),
    toggleTrail: document.getElementById('toggleTrail'),
    trailStatus: document.getElementById('trailStatus'),
    configModal: document.getElementById('configModal'),
    apiKey: document.getElementById('apiKey'),
    teamId: document.getElementById('teamId'),
    deviceIdInput: document.getElementById('deviceIdInput'),
    saveConfig: document.getElementById('saveConfig'),
    cancelConfig: document.getElementById('cancelConfig')
};

function showModal() {
    elements.apiKey.value = config.apiKey;
    elements.teamId.value = config.teamId;
    elements.deviceIdInput.value = config.deviceId;
    elements.configModal.classList.add('show');
}

function hideModal() {
    elements.configModal.classList.remove('show');
}

function saveConfig() {
    config.apiKey = elements.apiKey.value.trim();
    config.teamId = elements.teamId.value.trim();
    config.deviceId = elements.deviceIdInput.value.trim();

    localStorage.setItem('nrf_api_key', config.apiKey);
    localStorage.setItem('nrf_team_id', config.teamId);
    localStorage.setItem('nrf_device_id', config.deviceId);

    hideModal();
    init();
}

function setStatus(text, className) {
    elements.connectionStatus.textContent = text;
    elements.connectionStatus.className = 'status ' + (className || '');
}

async function nrfFetch(path, options = {}) {
    const headers = {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers
    };
    if (config.teamId) headers['X-Team-Id'] = config.teamId;

    const res = await fetch(`${NRF_CLOUD_BASE}${path}`, { ...options, headers });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
}

async function getDevices() {
    const data = await nrfFetch('/devices');
    return data.devices || [];
}

async function getDeviceShadow(deviceId) {
    return nrfFetch(`/devices/${deviceId}/shadow`);
}

async function getLocationHistory(deviceId, hours = 24) {
    const end = Date.now();
    const start = end - hours * 3600 * 1000;
    return nrfFetch(`/devices/${deviceId}/location?start=${start}&end=${end}`);
}

function parseShadow(shadow) {
    const reported = shadow.state?.reported || {};
    const desired = shadow.state?.desired || {};

    const gps = reported.gps || desired.gps || {};
    const env = reported.environment || desired.environment || {};
    const motion = reported.motion || desired.motion || {};
    const battery = reported.battery || desired.battery || {};
    const cellular = reported.cellular || desired.cellular || {};

    return {
        gps: {
            lat: gps.lat,
            lon: gps.lon,
            accuracy: gps.accuracy,
            satellites: gps.satellites,
            altitude: gps.altitude,
            speed: gps.speed,
            timestamp: gps.timestamp
        },
        env: {
            temperature: env.temperature,
            humidity: env.humidity,
            pressure: env.pressure
        },
        motion: {
            x: motion.x,
            y: motion.y,
            z: motion.z,
            steps: motion.steps
        },
        battery: {
            level: battery.level,
            voltage: battery.voltage,
            charging: battery.charging
        },
        cellular: {
            rsrp: cellular.rsrp,
            rsrq: cellular.rsrq,
            operator: cellular.operator
        },
        timestamp: shadow.metadata?.reported?.gps?.timestamp || shadow.timestamp
    };
}

function updateUI(data) {
    elements.deviceId.textContent = config.deviceId || '-';
    elements.deviceName.textContent = data.deviceName || '-';
    elements.firmwareVersion.textContent = data.firmwareVersion || '-';
    elements.lastSeen.textContent = data.timestamp ? new Date(data.timestamp).toLocaleString('pt-BR') : '-';

    const gps = data.gps;
    elements.gpsLat.textContent = gps.lat?.toFixed(6) || '-';
    elements.gpsLon.textContent = gps.lon?.toFixed(6) || '-';
    elements.gpsAcc.textContent = gps.accuracy ? `${gps.accuracy} m` : '-';
    elements.gpsSats.textContent = gps.satellites || '-';
    elements.gpsAlt.textContent = gps.altitude ? `${gps.altitude} m` : '-';
    elements.gpsSpeed.textContent = gps.speed ? `${gps.speed} km/h` : '-';

    elements.tempValue.textContent = gps.env?.temperature?.toFixed(1) ?? data.env?.temperature?.toFixed(1) ?? '-';
    elements.humValue.textContent = data.env?.humidity?.toFixed(1) ?? '-';
    elements.pressValue.textContent = data.env?.pressure?.toFixed(1) ?? '-';

    elements.accelX.textContent = data.motion?.x?.toFixed(2) ?? '-';
    elements.accelY.textContent = data.motion?.y?.toFixed(2) ?? '-';
    elements.accelZ.textContent = data.motion?.z?.toFixed(2) ?? '-';
    elements.steps.textContent = data.motion?.steps ?? '-';

    const bat = data.battery?.level;
    if (bat !== undefined) {
        elements.batteryFill.style.width = `${bat}%`;
        elements.batteryValue.textContent = `${bat}%`;
        elements.batteryFill.className = 'battery-fill';
        if (bat < 20) elements.batteryFill.classList.add('critical');
        else if (bat < 40) elements.batteryFill.classList.add('low');
    } else {
        elements.batteryValue.textContent = '-';
    }

    elements.rsrp.textContent = data.cellular?.rsrp ?? '-';
    elements.rsrq.textContent = data.cellular?.rsrq ?? '-';
    elements.operator.textContent = data.cellular?.operator || '-';

    if (gps.lat && gps.lon) {
        updateMap(gps.lat, gps.lon, gps.accuracy);
    }
}

function initMap() {
    map = L.map('map').setView([-23.5505, -46.6333], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);

    marker = L.marker([0, 0], { visible: false }).addTo(map);
    trailLayer = L.polyline([], { color: '#0984e3', weight: 3, opacity: 0.7 }).addTo(map);
}

function updateMap(lat, lon, accuracy) {
    if (!map) return;

    const pos = [lat, lon];
    marker.setLatLng(pos).setVisible(true);

    if (accuracy) {
        if (marker.accuracyCircle) map.removeLayer(marker.accuracyCircle);
        marker.accuracyCircle = L.circle(pos, { radius: accuracy, color: '#0984e3', fillColor: '#0984e3', fillOpacity: 0.1, weight: 1 }).addTo(map);
    }

    if (trailEnabled) {
        trailLayer.addLatLng(pos);
    }

    if (map.getZoom() < 12) {
        map.setView(pos, 15);
    }
}

async function fetchAndUpdate() {
    try {
        if (!config.deviceId) {
            const devices = await getDevices();
            if (devices.length === 0) throw new Error('Nenhum dispositivo encontrado no nRF Cloud');
            config.deviceId = devices[0].id;
            localStorage.setItem('nrf_device_id', config.deviceId);
        }

        const shadow = await getDeviceShadow(config.deviceId);
        const parsed = parseShadow(shadow);
        parsed.deviceName = shadow.deviceName;
        parsed.firmwareVersion = shadow.reported?.firmwareVersion || shadow.desired?.firmwareVersion;

        updateUI(parsed);
        setStatus('Conectado', 'connected');
    } catch (err) {
        console.error(err);
        setStatus(`Erro: ${err.message}`, 'error');
        if (err.message.includes('401') || err.message.includes('403')) {
            showModal();
        }
    }
}

async function loadTrail() {
    if (!config.deviceId || !trailEnabled) return;
    try {
        const history = await getLocationHistory(config.deviceId, 24);
        const points = (history.locations || [])
            .filter(l => l.lat && l.lon)
            .map(l => [l.lat, l.lon]);
        if (points.length) {
            trailLayer.setLatLngs(points);
        }
    } catch (err) {
        console.warn('Trail load failed:', err);
    }
}

function init() {
    if (!config.apiKey) {
        showModal();
        return;
    }

    if (!map) initMap();
    fetchAndUpdate();
    loadTrail();

    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(fetchAndUpdate, POLL_MS);
}

elements.saveConfig.addEventListener('click', saveConfig);
elements.cancelConfig.addEventListener('click', hideModal);
elements.centerMap.addEventListener('click', () => {
    if (marker.getLatLng().lat !== 0) map.setView(marker.getLatLng(), 15);
});
elements.toggleTrail.addEventListener('click', () => {
    trailEnabled = !trailEnabled;
    elements.trailStatus.textContent = trailEnabled ? 'ON' : 'OFF';
    if (!trailEnabled) trailLayer.setLatLngs([]);
    else loadTrail();
});

document.addEventListener('DOMContentLoaded', init);