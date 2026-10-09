/* nRF9151 NTN Pro (v36) — UI. Lógica em pro-core.js (window.NtnPro). */
(() => {
  const P = window.NtnPro;
  const onNetlify = /netlify\.app$/i.test(location.hostname) || /^(localhost|127\.)/.test(location.hostname);
  const API = (onNetlify ? '' : 'https://thingy91x-x-dashboard.netlify.app') + '/.netlify/functions/ntn-lab';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
  const dmy = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const netTag = (n) => (n ? `<span class="tag ${n}">${n === 'ntn' ? 'Satélite' : 'Cat-M'}</span>` : '—');
  const LS = 'ntnpro.filters';
  const st = Object.assign({ src: 'live', period: '24h', net: 'all', sw: false }, JSON.parse(localStorage.getItem(LS) || '{}'));
  const params = new URLSearchParams(location.search);
  if (params.get('replay') === '1') st.src = 'replay';
  let live = [], replay = null, rpCursor = null, rpTimer = null, lastLoad = null, fitted = false;

  // ---------- mapa ----------
  const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([-23.55, -46.70], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap', className: 'tiles' }).addTo(map);
  const layer = L.layerGroup().addTo(map);

  function recs() {
    if (st.src === 'replay') { const all = replay ? replay.records : []; return rpCursor == null ? all : all.filter((r) => Date.parse(r.ts) <= rpCursor); }
    return live;
  }
  function nowRef() { return st.src === 'replay' ? (rpCursor ?? (replay ? Date.parse(replay.records[replay.records.length - 1].ts) + 60000 : Date.now())) : Date.now(); }
  function view() {
    const f = { period: st.src === 'replay' ? 'all' : st.period, net: st.net, switchesOnly: st.sw };
    return P.filterRecords(recs(), f, nowRef());
  }

  function popup(r) {
    const rows = [['Horário', dmy(r.ts)], ['Rede', r.net === 'ntn' ? 'Satélite NTN (Skylo)' : 'Cat-M (celular)']];
    if (r.type === 'event') rows.push(['Evento', (P.EVENT_PT[r.event] || r.event) + (r.info ? ' — ' + r.info : '')]);
    if (r.plmn) rows.push(['Operadora (PLMN)', r.plmn + (r.band ? ' · banda ' + r.band : '') + (r.act != null ? ' · AcT ' + r.act : '')]);
    if (r.rsrp != null) rows.push(['Sinal', r.rsrp + ' dBm' + (r.snr != null ? ' · SNR ' + r.snr + ' dB' : '') + (r.ce != null ? ' · CE ' + r.ce : '')]);
    if (r.rttMs != null) rows.push(['Latência (medida)', P.fmtMs(r.rttMs)]);
    if (r.prevRttMs != null) rows.push(['Latência msg anterior', P.fmtMs(r.prevRttMs)]);
    if (r.bytes) rows.push(['Bytes', r.bytes + ' B (payload)']);
    rows.push(['Entrega', r.late > 0 ? `atrasada ${P.fmtDur(r.late)} (fila)` : 'em tempo real']);
    if (r.posSrc) rows.push(['Posição', r.posSrc + (r.acc != null ? ' · ±' + r.acc + ' m' : '')]);
    if (r.mv != null) rows.push(['Tensão / temp.', r.mv + ' mV' + (r.temp != null ? ' · ' + r.temp + ' °C' : '')]);
    if (r.replay) rows.push(['Fonte', 'REPLAY (log real)']);
    return '<table>' + rows.map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('') + '</table>';
  }
  function drawMap(rs) {
    layer.clearLayers();
    const pts = P.mapPoints(rs);
    for (const s of P.segments(pts)) L.polyline(s.pts, { color: P.NET[s.net]?.color || '#888', weight: 4, opacity: 0.85 }).addTo(layer);
    pts.forEach((p, i) => {
      const r = p.rec, c = P.NET[p.net]?.color || '#888', ev = r.type === 'event';
      const jitter = 0.00012 * (i % 7); // separa pontos sobrepostos da placa parada (visual)
      const ll = [p.lat + (pts.length > 1 ? jitter * Math.sin(i) : 0), p.lon + (pts.length > 1 ? jitter * Math.cos(i) : 0)];
      const m = ev && ['sw', 'reg', 'fail'].includes(r.event)
        ? L.marker(ll, { icon: L.divIcon({ className: '', html: `<div style="width:14px;height:14px;background:${c};border:2px solid #fff;border-radius:3px;transform:rotate(45deg)"></div>`, iconSize: [14, 14] }) })
        : L.circleMarker(ll, { radius: ev ? 5 : 7, color: r.late > 0 ? '#ffb020' : '#fff', dashArray: r.late > 0 ? '3' : null, weight: r.late > 0 ? 2.5 : 1.5, fillColor: c, fillOpacity: 0.95 });
      m.bindPopup(popup(r)).addTo(layer);
    });
    if (pts.length && (!fitted || st.src === 'replay')) { map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])).pad(0.4), { maxZoom: 16 }); fitted = true; }
  }

  function drawLive(all) {
    const s = P.liveStatus(all, nowRef());
    const dot = $('lvDot'); dot.className = 'dot ' + (s ? (s.stale && st.src !== 'replay' ? 'stale' : s.net) : '');
    if (!s) { $('lvNet').textContent = 'sem dados'; ['lvSince', 'lvSig', 'lvOp', 'lvAge', 'lvRx', 'lvDev', 'lvCnt'].forEach((k) => ($(k).textContent = '')); return; }
    $('lvNet').textContent = s.net === 'ntn' ? 'Satélite NTN (Skylo)' : 'Cat-M (LTE-M)';
    $('lvSince').textContent = s.sinceSec != null ? 'há ' + P.fmtDur(s.sinceSec) : '';
    $('lvSig').textContent = s.rsrp != null ? s.rsrp + ' dBm' : '—';
    $('lvOp').textContent = [s.plmn && 'PLMN ' + s.plmn, s.band && 'banda ' + s.band, s.snr != null && 'SNR ' + s.snr + ' dB'].filter(Boolean).join(' · ');
    $('lvAge').textContent = 'há ' + P.fmtDur(s.ageSec);
    $('lvRx').textContent = dmy(s.lastRx) + (s.stale && st.src !== 'replay' ? ' · sem novidades' : '');
    $('lvDev').textContent = s.mv != null ? (s.mv / 1000).toFixed(2) + ' V' + (s.temp != null ? ' · ' + s.temp + ' °C' : '') : '—';
    $('lvCnt').textContent = s.counters ? `envios ${s.counters.tries} · ok ${s.counters.ok} · falhas ${s.counters.fail} · comutações ${s.counters.switches}` : '';
  }
  function pctS(x) { return x == null ? '—' : (x * 100).toFixed(x >= 0.995 ? 0 : 1) + '%'; }
  function drawKpis(rs) {
    const k = P.kpis(rs, nowRef()), c = k.net.catm, n = k.net.ntn;
    const card = (t, main, split) => `<div class="kpi"><small>${t}</small><b>${main}</b>${split ? `<div class="split">${split}</div>` : ''}</div>`;
    $('kpis').innerHTML = [
      card('Taxa de entrega', pctS(k.delivery), `<span class="c">Cat-M ${pctS(c.delivery)}</span><span class="n">Sat ${pctS(n.delivery)}</span>`),
      card('Latência média', `<span class="c">${P.fmtMs(c.rttAvg)}</span> / <span class="n">${P.fmtMs(n.rttAvg)}</span>`, `p95: <span class="c">${P.fmtMs(c.rttP95)}</span> · <span class="n">${P.fmtMs(n.rttP95)}</span>`),
      card('Tempo médio registro NTN', P.fmtDur(k.ntnRegAvg), `${k.ntnRegCount} registro(s) · ${k.ntnRegFails} falha(s)`),
      card('Bytes por mensagem', c.bytesAvg || n.bytesAvg ? Math.round(((c.bytesAvg || 0) * c.received + (n.bytesAvg || 0) * n.received) / ((c.bytesAvg ? c.received : 0) + (n.bytesAvg ? n.received : 0) || 1)) + ' B' : '—', 'payload ≤ 256 B (limite Skylo)'),
      card('Mensagens atrasadas', String(k.late), 'reenviadas pela fila'),
      card('Disponibilidade', pctS(k.availability), `${k.switches} comutação(ões) · ${k.total} registros`),
    ].join('');
  }
  function drawSwitches(rs) {
    const sw = P.switches(rs);
    $('swCount').textContent = sw.length + ' comutação(ões)';
    $('swList').innerHTML = sw.length ? sw.slice().reverse().map((s) => {
      const res = s.ok === true ? `<span class="ok">registrou em ${P.fmtDur(s.regSec)}</span>` : s.ok === false ? `<span class="bad">falhou${s.failWhy ? ' (' + esc(s.failWhy) + ')' : ''}</span>` : '<span class="pend">aguardando registro…</span>';
      return `<li><span class="mono">${hhmm(s.at)}</span><span><span class="arrow">${s.to === 'ntn' ? 'Cat-M → <span style="color:#c8a2ff">Satélite</span>' : 'Satélite → <span style="color:#8fb6ff">Cat-M</span>'}</span><br><small>${esc(s.why)}${s.fixSec != null ? ' · fix GNSS ' + (s.fixSec < 0 ? 'falhou' : P.fmtDur(s.fixSec)) : ''}</small></span>${res}</li>`;
    }).join('') : '<li class="muted">Nenhuma comutação no período.</li>';
    // faixa proporcional ao tempo em cada rede
    const all = P.sortRecs(rs); if (all.length < 2) { $('swBar').innerHTML = ''; return; }
    const t0 = Date.parse(all[0].ts), t1 = Math.max(Date.parse(all[all.length - 1].ts), t0 + 1);
    let html = '', prev = all[0];
    for (let i = 1; i <= all.length; i++) {
      const r = all[i];
      if (!r || r.net !== prev.net) { const end = r ? Date.parse(r.ts) : t1; html += `<div title="${prev.net} ${hhmm(prev.ts)}" style="width:${((end - Date.parse(prev.ts)) / (t1 - t0)) * 100}%;background:${P.NET[prev.net]?.color || '#555'}"></div>`; prev = r; }
    }
    $('swBar').innerHTML = html;
  }
  function drawTable(rs) {
    const rows = rs.slice(-300).reverse();
    $('msgCount').textContent = rs.length + ' registros';
    $('msgBody').innerHTML = rows.map((r) => {
      const det = r.type === 'event' ? (P.EVENT_PT[r.event] || r.event) + (r.info ? ' — ' + r.info : '') + (r.event === 'reg' || r.event === 'fix' ? ' (' + P.fmtDur(r.value) + ')' : '') : 'Telemetria' + (r.plmn ? ' · ' + r.plmn : '');
      const lat = r.rttMs != null ? P.fmtMs(r.rttMs) : r.prevRttMs != null ? P.fmtMs(r.prevRttMs) + ' (ant.)' : '—';
      return `<tr><td class="mono">${hhmm(r.ts)}</td><td>${r.seq ?? '—'}</td><td>${netTag(r.net)}</td><td>${r.type === 'event' ? 'evento' : 'telemetria'}</td><td>${esc(det)}</td><td>${r.rsrp != null ? r.rsrp + ' dBm' : '—'}</td><td>${r.bytes ?? '—'}</td><td>${lat}</td><td>${r.late > 0 ? `<span class="tag late">atrasada ${P.fmtDur(r.late)}</span>` : 'tempo real'}</td></tr>`;
    }).join('');
  }
  function render() {
    const rs = view();
    const all = st.src === 'replay' ? recs() : live;
    $('replayBanner').hidden = st.src !== 'replay';
    document.querySelectorAll('#srcSeg button').forEach((b) => b.classList.toggle('on', b.dataset.src === st.src));
    document.querySelectorAll('#fNet button').forEach((b) => b.classList.toggle('on', b.dataset.net === st.net));
    $('fPeriod').value = st.period; $('fPeriod').disabled = st.src === 'replay'; $('fSw').checked = st.sw;
    drawLive(all); drawKpis(rs); drawSwitches(st.sw ? all : rs); drawMap(rs); drawTable(rs);
    const empty = $('empty');
    empty.hidden = rs.length > 0;
    if (!rs.length) empty.innerHTML = st.src === 'live' ? 'Nenhum dado da placa neste período. Verifique se a placa está ligada (app NTN Pro v2.0) ou use <b>Replay da demonstração</b>.' : 'Sem dados de replay.';
    $('foot').textContent = st.src === 'replay' ? 'REPLAY: ' + (replay?.source || '') : 'atualizado ' + (lastLoad ? hhmm(lastLoad) : '—') + ' · atualiza a cada 15 s';
  }
  function save() { localStorage.setItem(LS, JSON.stringify({ period: st.period, net: st.net, sw: st.sw })); }

  async function loadLive() {
    try {
      const r = await fetch(API + '?pro=1&days=7&t=' + Date.now(), { cache: 'no-store' });
      const j = await r.json();
      if (j && Array.isArray(j.records)) { live = j.records; lastLoad = new Date().toISOString(); }
    } catch (e) { console.warn('ntn-pro: falha ao carregar', e); }
    if (st.src === 'live') render();
  }
  async function loadReplay() {
    if (replay) return replay;
    const r = await fetch('replay.json?v=36', { cache: 'no-store' }); replay = await r.json();
    $('replayTitle').textContent = replay.title; return replay;
  }
  function stopReplay() { clearInterval(rpTimer); rpTimer = null; $('rpPlay').textContent = '▶ Reproduzir'; }
  function playReplay() {
    if (rpTimer) { stopReplay(); return; }
    const rs = replay.records, t0 = Date.parse(rs[0].ts) - 5000, t1 = Date.parse(rs[rs.length - 1].ts) + 5000;
    if (rpCursor == null || rpCursor >= t1) rpCursor = t0;
    $('rpPlay').textContent = '❚❚ Pausar';
    rpTimer = setInterval(() => {
      rpCursor += +$('rpSpeed').value * 250;
      $('rpClock').textContent = new Date(rpCursor).toLocaleTimeString('pt-BR');
      if (rpCursor >= t1) { rpCursor = null; stopReplay(); }
      render();
    }, 250);
  }

  // ---------- export ----------
  function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
  function doExport(kind) {
    const rs = view(), stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
    const tag = st.src === 'replay' ? 'replay' : 'live';
    if (kind === 'csv') download(`ntn-pro-${tag}-${stamp}.csv`, P.toCSV(rs), 'text/csv;charset=utf-8');
    if (kind === 'json') download(`ntn-pro-${tag}-${stamp}.json`, JSON.stringify({ schema: 'ntn-pro/1', source: tag, exportedAt: new Date().toISOString(), kpis: P.kpis(rs, nowRef()), switches: P.switches(rs), records: rs }, null, 1), 'application/json');
    if (kind === 'print') window.print();
  }

  // ---------- eventos de UI ----------
  document.querySelectorAll('#srcSeg button').forEach((b) => b.onclick = async () => { st.src = b.dataset.src; stopReplay(); rpCursor = null; fitted = false; if (st.src === 'replay') await loadReplay(); render(); });
  document.querySelectorAll('#fNet button').forEach((b) => b.onclick = () => { st.net = b.dataset.net; save(); render(); });
  $('fPeriod').onchange = (e) => { st.period = e.target.value; save(); fitted = false; render(); };
  $('fSw').onchange = (e) => { st.sw = e.target.checked; save(); render(); };
  $('rpPlay').onclick = playReplay;
  $('btnExport').onclick = () => ($('exportMenu').hidden = !$('exportMenu').hidden);
  $('exportMenu').onclick = (e) => { const k = e.target.dataset.x; if (k) { $('exportMenu').hidden = true; doExport(k); } };
  $('btnPresent').onclick = async () => {
    document.body.classList.toggle('present');
    try { if (document.body.classList.contains('present')) await document.documentElement.requestFullscreen?.(); else if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* sem permissão */ }
    setTimeout(() => map.invalidateSize(), 300);
  };
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) document.body.classList.remove('present'); setTimeout(() => map.invalidateSize(), 300); });
  if (params.get('present') === '1') document.body.classList.add('present');

  (async () => {
    if (st.src === 'replay') await loadReplay();
    await loadLive();
    render();
    setInterval(loadLive, 15000);
  })();
  window.__ntnPro = { st, render, get live() { return live; } };
})();
