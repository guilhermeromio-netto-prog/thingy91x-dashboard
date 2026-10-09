/* nRF9151 NTN Lab v34 — lê o resumo publicado pelo uploader do Mac (Netlify Blobs) com polling de 15 s. */
(function () {
  'use strict';
  const onNetlify = /netlify\.app$/i.test(location.hostname) || /^(localhost|127\.)/.test(location.hostname);
  const API = (onNetlify ? '' : 'https://thingy91x-x-dashboard.netlify.app') + '/.netlify/functions/ntn-lab';
  const POLL_MS = 15000, STALE_MS = 120000, TZ = 'America/Sao_Paulo';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtT = (iso) => iso ? new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  const fmtDT = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const dur = (s) => s == null ? '—' : (s >= 60 ? Math.floor(s / 60) + ' min ' + String(Math.round(s % 60)).padStart(2, '0') + ' s' : Math.round(s) + ' s');
  const ago = (iso) => { if (!iso) return '—'; const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? 'há ' + Math.round(s) + ' s' : 'há ' + dur(s); };
  const ms = (v) => v == null ? '' : (v >= 10000 ? (v / 1000).toFixed(1).replace('.', ',') + ' s' : v + ' ms');
  const ACT = { '7': 'LTE-M (Cat-M)', '9': 'NB-IoT', '14': 'NTN NB-IoT (satélite)' };
  const COLORS = { NTN: '#7b2ff7', CATM: '#1e6fff', GNSS: '#e49b0f' };

  let data = null, mode = 'live', selected = null, map, layer, fitted = false, tick = null;

  function initMap() {
    map = L.map('map', { zoomControl: true }).setView([-23.55, -46.70], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    layer = L.layerGroup().addTo(map);
  }

  async function load() {
    try {
      const r = await fetch(API + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!j.data) throw new Error('sem dados publicados');
      data = j.data; mode = 'live';
    } catch (e) {
      if (!data || mode === 'demo') {
        try { const r2 = await fetch('demo.json?t=' + Date.now(), { cache: 'no-store' }); data = await r2.json(); mode = 'demo'; } catch { /* nada */ }
      } else mode = 'offline';
    }
    render();
  }

  function sessionOf(id) { return (data.sessions || []).find((s) => s.id === id); }

  function render() {
    if (!data) { $('statusLabel').textContent = 'Sem dados'; return; }
    const age = Date.now() - new Date(data.generatedAt);
    const feed = $('feed');
    const banner = $('banner');
    if (mode === 'demo') {
      feed.className = 'feed stale'; feed.textContent = 'Modo demonstração';
      banner.hidden = false; banner.textContent = 'Sem dados ao vivo do uploader. Mostrando o último snapshot salvo (' + fmtDT(data.generatedAt) + ').';
    } else if (mode === 'offline' || age > STALE_MS) {
      feed.className = 'feed stale'; feed.textContent = 'Uploader parado · último dado ' + ago(data.generatedAt);
      banner.hidden = false; banner.textContent = 'O Mac não publica há ' + ago(data.generatedAt).replace('há ', '') + '. O status abaixo pode estar desatualizado.';
    } else {
      feed.className = 'feed live'; feed.textContent = '● Ao vivo · atualizado ' + ago(data.generatedAt);
      banner.hidden = true;
    }
    const c = data.current || {};
    const last = sessionOf(c.session) || (data.sessions || []).slice(-1)[0] || {};
    $('statusDot').className = 'dot ' + (c.state || 'off');
    $('statusLabel').textContent = c.label || '—';
    $('statusDetail').textContent = [c.detail, c.live ? 'teste rodando agora' : null, c.since ? 'sessão iniciada ' + fmtT(c.since) : null].filter(Boolean).join(' · ');
    const searchBase = c.searchSeconds, gen = new Date(data.generatedAt);
    const paintSearch = () => {
      let s = searchBase;
      if (s != null && c.state === 'ntn_searching' && mode === 'live') s += (Date.now() - gen) / 1000;
      $('kSearch').textContent = last.regSeconds != null && last.kind === 'ntn' ? 'registrou em ' + dur(last.regSeconds) : dur(s);
    };
    paintSearch(); clearInterval(tick); tick = setInterval(paintSearch, 1000);
    $('kNet').textContent = last.act ? (ACT[last.act] || 'AcT ' + last.act) + (last.operator ? ' · ' + last.operator : '') + (last.band ? ' · B' + last.band : '') : '—';
    $('kCell').textContent = last.cell ? last.cell + ' / ' + last.tac : '—';
    $('kPing').textContent = last.ip ? last.ip + (last.pingAvg ? ' · ping ' + ms(last.pingAvg) : '') : 'ainda sem IP';
    renderSteps(last, c);
    renderDevice();
    renderMap();
    renderHist();
    if (!selected || !sessionOf(selected)) selected = last.id;
    renderSessSel();
    renderTimeline();
  }

  function renderSteps(s, c) {
    if (s.kind !== 'ntn') { $('steps').innerHTML = ''; return; }
    const ev = s.events || [];
    const has = (re) => ev.some((e) => re.test(e.text));
    const fix = !!s.fix, cfg = has(/Modo de sistema: NTN/), on = !!s.cfun1At, cell = !!s.cell, prach = ev.some((e) => e.tag === 'prach'), reg = s.registered && s.kind === 'ntn', ip = !!s.ip;
    const failed = s.result === 'não registrou';
    const steps = [['1. Posição GNSS', fix], ['2. Configura NTN', cfg], ['3. Rádio ligado', on], ['4. Célula do satélite', cell], ['5. Acesso (PRACH)', prach], ['6. Registrado', reg], ['7. IP / ping', ip]];
    const firstPending = steps.findIndex((x) => !x[1]);
    $('steps').innerHTML = steps.map(([t, ok], i) => '<div class="step ' + (ok ? 'done' : (i === firstPending ? (failed ? 'fail' : (c.live ? 'now' : '')) : '')) + '">' + (ok ? '✓ ' : '') + esc(t) + '</div>').join('');
  }

  function renderDevice() {
    const d = data.device || {};
    const rows = [['Placa', d.model], ['App', d.app], ['Firmware do modem', d.fw], ['SIM', d.sim], ['ICCID', d.iccid], ['IMSI', d.imsi], ['APN', d.apn],
      ['Uploader', (data.uploader && data.uploader.host || '—') + ' · a cada ' + ((data.uploader && data.uploader.intervalSec) || 30) + ' s']];
    $('device').innerHTML = rows.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v || '—') + '</dd>').join('');
  }

  function renderMap() {
    layer.clearLayers();
    const pts = [];
    (data.sessions || []).forEach((s) => {
      if (!s.fix) return;
      const net = s.kind === 'ntn' ? 'NTN' : 'CATM';
      const isCur = data.current && data.current.session === s.id;
      const color = COLORS[net];
      const ll = [s.fix.lat, s.fix.lon]; pts.push(ll);
      L.circle(ll, { radius: s.fix.rounded ? 110 : (s.fix.acc || 20), color, weight: 1, fillOpacity: .08 }).addTo(layer);
      L.circleMarker(ll, { radius: isCur ? 11 : 7, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 })
        .bindPopup('<b>' + (net === 'NTN' ? 'NTN (satélite)' : 'Cat-M') + '</b> · ' + esc(s.id) + '<br>' + esc(data.current && isCur ? data.current.label : (s.result || '')) +
          '<br>Fix GNSS ' + fmtT(s.fix.t) + ' · precisão ' + esc(s.fix.acc) + ' m · TTFF ' + esc(s.fix.ttff) + ' s' + (s.fix.rounded ? '<br><i>posição arredondada (~100 m)</i>' : ''))
        .addTo(layer);
    });
    if (pts.length && !fitted) { map.setView(pts[pts.length - 1], 15); fitted = true; }
    const f = data.fix;
    $('fixInfo').textContent = f ? 'Último fix GNSS ' + fmtDT(f.t) + ' · ' + f.lat + ', ' + f.lon + (f.rounded ? ' (arredondado)' : '') + ' · alt ' + f.alt + ' m · precisão ' + f.acc + ' m · em ' + f.ttff + ' s'
      : 'Sem fix GNSS. As sessões Cat-M de hoje foram dentro de casa (sem posição).';
  }

  function resultCell(s) {
    if (s.live) return '<span class="res-live">em andamento</span>';
    if (s.registered) return '<span class="res-ok">registrado' + (s.regSeconds != null ? ' (' + dur(s.regSeconds) + ')' : '') + '</span>';
    if (s.result === 'não registrou') return '<span class="res-err">não registrou</span>';
    return '<span class="muted">configuração / sem registro</span>';
  }
  function renderHist() {
    const rows = (data.sessions || []).slice().reverse();
    $('hist').innerHTML = rows.map((s) => '<tr data-id="' + esc(s.id) + '"><td>' + fmtDT(s.start) + '</td><td><span class="pill ' + s.kind + '">' + (s.kind === 'ntn' ? 'NTN' : 'Cat-M') + '</span></td><td>' + resultCell(s) + '</td><td>' +
      esc([s.operator, s.band ? 'B' + s.band : null].filter(Boolean).join(' · ') || (s.kind === 'ntn' ? 'Skylo' + (s.cell ? ' · célula ' + s.cell : '') : '—')) + '</td><td>' + (s.rsrp != null ? esc(s.rsrp) + ' dBm' : '—') + '</td><td>' +
      (s.regSeconds != null ? dur(s.regSeconds) : '—') + '</td><td>' + (s.pingAvg ? ms(s.pingAvg) : '—') + '</td><td>' + esc(s.fw || '—') + '</td></tr>').join('');
    $('hist').querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => { selected = tr.dataset.id; renderSessSel(); renderTimeline(); $('timeline').scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
  }
  function renderSessSel() {
    const sel = $('sessSel');
    sel.innerHTML = (data.sessions || []).slice().reverse().map((s) => '<option value="' + esc(s.id) + '"' + (s.id === selected ? ' selected' : '') + '>' + (s.kind === 'ntn' ? 'NTN' : 'Cat-M') + ' · ' + fmtDT(s.start) + (s.live ? ' (ao vivo)' : '') + '</option>').join('');
  }
  function renderTimeline() {
    const s = sessionOf(selected); if (!s) return;
    const important = $('fImportant').checked, raw = $('fRaw').checked;
    let ev = (s.events || []).slice();
    if (important) ev = ev.filter((e) => e.level !== 'muted' || e.tag === 'step');
    ev.reverse();
    $('tlTitle').textContent = '· ' + (s.kind === 'ntn' ? 'NTN' : 'Cat-M') + ' ' + fmtDT(s.start) + ' · ' + ev.length + ' eventos (mais recente no topo)';
    $('timeline').innerHTML = ev.map((e) => '<li class="' + esc(e.level) + '"><span class="tm">' + fmtT(e.t) + '</span><span class="lv ' + esc(e.level) + '"></span><span class="tx">' + esc(e.text) +
      (raw && e.raw ? '<span class="raw">' + esc(e.raw) + '</span>' : '') + '</span></li>').join('') || '<li><span></span><span></span><span class="muted">Sem eventos.</span></li>';
  }

  document.addEventListener('DOMContentLoaded', () => {
    initMap();
    $('sessSel').addEventListener('change', (e) => { selected = e.target.value; renderTimeline(); });
    $('fImportant').addEventListener('change', renderTimeline);
    $('fRaw').addEventListener('change', renderTimeline);
    load(); setInterval(load, POLL_MS);
  });
})();
