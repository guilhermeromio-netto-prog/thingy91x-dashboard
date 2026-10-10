/* nRF9151 NTN Pro (v36) — lógica pura do painel (sem DOM). Usado no navegador (window.NtnPro) e nos testes Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NtnPro = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const NET = { catm: { label: 'Cat-M', color: '#2f7cf6' }, ntn: { label: 'Satélite (NTN)', color: '#9b4dff' } };
  const t = (r) => Date.parse(r.ts || r.rx);
  const sortRecs = (rs) => rs.slice().sort((a, b) => t(a) - t(b) || (a.seq ?? 0) - (b.seq ?? 0));

  function periodStart(period, now) {
    const H = 3600000;
    if (period === '1h') return now - H;
    if (period === '6h') return now - 6 * H;
    if (period === '24h') return now - 24 * H;
    if (period === '7d') return now - 7 * 24 * H;
    if (period === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
    return -Infinity;
  }
  const SWITCH_EVENTS = new Set(['sw', 'reg', 'fail', 'lost', 'fix', 'demo', 'auto']);
  function filterRecords(recs, f = {}, now = Date.now()) {
    const from = periodStart(f.period || 'all', now);
    return sortRecs(recs).filter((r) => {
      if (t(r) < from) return false;
      if (f.net && f.net !== 'all' && r.net !== f.net) return false;
      if (f.pos && f.pos !== 'all' && (r.posSrc || '').split(' ')[0] !== f.pos) return false;
      if (f.switchesOnly && !(r.type === 'event' && SWITCH_EVENTS.has(r.event))) return false;
      return true;
    });
  }
  function pct(arr, p) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  /** Comutações: cada evento 'sw' vira uma linha com o próximo 'reg' ou 'fail'. */
  function switches(recs) {
    const rs = sortRecs(recs).filter((r) => r.type === 'event');
    const out = [];
    let cur = null;
    for (const r of rs) {
      if (r.event === 'sw' && ['boot', 'reinicio'].includes(r.info)) continue; // boot/reinicio nao e comutacao
      if (r.event === 'sw') {
        if (cur) out.push(cur);
        cur = { at: r.ts, to: r.value === 1 ? 'ntn' : 'catm', why: r.info || '', regSec: null, ok: null, fixSec: null, replay: !!r.replay };
      } else if (cur && r.event === 'fix') cur.fixSec = r.value;
      else if (cur && r.event === 'reg' && cur.ok === null) { cur.ok = true; cur.regSec = r.value; cur.regAt = r.ts; }
      else if (cur && r.event === 'fail' && cur.ok === null) { cur.ok = false; cur.failWhy = r.info; }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** KPIs por rede. */
  function kpis(recs, now = Date.now()) {
    const rs = sortRecs(recs);
    const per = { catm: { rx: 0, missing: 0, rtt: [], bytes: [], late: 0 }, ntn: { rx: 0, missing: 0, rtt: [], bytes: [], late: 0 } };
    let prev = null;
    for (const r of rs) {
      const p = per[r.net]; if (!p) continue;
      p.rx++; if (r.bytes) p.bytes.push(r.bytes); if (r.late > 0) p.late++;
      if (prev && r.seq != null && prev.seq != null && r.seq > prev.seq + 1 && r.seq - prev.seq < 1000) p.missing += r.seq - prev.seq - 1;
      if (prev && r.prevRttMs != null && per[prev.net]) per[prev.net].rtt.push(r.prevRttMs);
      if (r.rttMs != null) p.rtt.push(r.rttMs); // replay: RTT medido (ping)
      if (r.seq != null) prev = r;
    }
    const net = {};
    for (const k of Object.keys(per)) {
      const p = per[k];
      net[k] = { received: p.rx, delivery: p.rx + p.missing ? p.rx / (p.rx + p.missing) : null, rttAvg: avg(p.rtt), rttP95: pct(p.rtt, 95),
        bytesAvg: avg(p.bytes), late: p.late, samples: p.rtt.length };
    }
    const sw = switches(rs);
    const ntnReg = sw.filter((s) => s.to === 'ntn' && s.ok).map((s) => s.regSec).filter((x) => x != null);
    // disponibilidade: tempo registrado / tempo observado, a partir de lost/reg/sw
    let up = 0, span = 0, state = null, last = null;
    for (const r of rs.filter((x) => x.type === 'event' || x.type === 'telemetry')) {
      const tt = t(r);
      if (last != null) { span += tt - last; if (state) up += tt - last; }
      last = tt;
      if (r.type === 'event' && (r.event === 'lost' || r.event === 'sw' || r.event === 'boot' || r.event === 'rst')) state = false;
      else if ((r.type === 'event' && r.event === 'reg') || r.type === 'telemetry') state = true;
    }
    if (last != null && state && now - last < 15 * 60000) { span += now - last; up += now - last; }
    const rxT = per.catm.rx + per.ntn.rx, miss = per.catm.missing + per.ntn.missing;
    return { net, delivery: rxT + miss ? rxT / (rxT + miss) : null, switches: sw.length, ntnRegAvg: avg(ntnReg), ntnRegCount: ntnReg.length, ntnRegFails: sw.filter((s) => s.to === 'ntn' && s.ok === false).length,
      late: per.catm.late + per.ntn.late, availability: span > 0 ? up / span : null, total: rs.length };
  }

  /** Estado ao vivo a partir do último registro. */
  /** v37: estado do GPS a partir da ultima telemetria Cat-M com gnssAge. */
  function gpsStatus(recs, now = Date.now()) {
    const rs = sortRecs(recs);
    const lastG = [...rs].reverse().find((r) => r.posSrc === 'gnss');
    const lastT = [...rs].reverse().find((r) => r.type === 'telemetry' && r.gnssAge !== undefined && r.gnssAge !== null || (r.type === 'telemetry' && r.posSrc));
    let age = null;
    if (lastT && lastT.gnssAge != null && lastT.gnssAge >= 0) age = lastT.gnssAge + Math.round((now - Date.parse(lastT.rx || lastT.ts)) / 1000);
    else if (lastG) age = Math.round((now - Date.parse(lastG.ts)) / 1000);
    return { age, sats: lastT ? lastT.gnssSats ?? null : null, src: lastT ? lastT.posSrc : null, acc: lastT ? lastT.acc : null };
  }
  function liveStatus(recs, now = Date.now()) {
    const rs = sortRecs(recs);
    if (!rs.length) return null;
    const last = rs[rs.length - 1];
    const lastTel = [...rs].reverse().find((r) => r.type === 'telemetry') || null;
    const lastSw = [...rs].reverse().find((r) => r.type === 'event' && r.event === 'sw');
    const lastRx = Math.max(...rs.map((r) => Date.parse(r.rx || r.ts)));
    const net = last.net;
    let since = null;
    for (let i = rs.length - 1; i >= 0; i--) { if (rs[i].net !== net) break; since = rs[i].ts; }
    const lastOther = [...rs].reverse().find((r) => r.net !== net && !(r.type === 'event' && r.event === 'sw'));
    if (lastSw && (!lastOther || t(lastSw) >= t(lastOther)) && (lastSw.value === 1 ? 'ntn' : 'catm') === net) since = lastSw.ts;
    const ageSec = Math.round((now - lastRx) / 1000);
    return { net, since, sinceSec: since ? Math.round((now - Date.parse(since)) / 1000) : null, rsrp: lastTel ? lastTel.rsrp : null, snr: lastTel ? lastTel.snr : null,
      plmn: lastTel ? lastTel.plmn : null, band: lastTel ? lastTel.band : null, mv: lastTel ? lastTel.mv : null, temp: lastTel ? lastTel.temp : null,
      lastRx: new Date(lastRx).toISOString(), ageSec, stale: ageSec > (net === 'ntn' ? 900 : 300), counters: lastTel ? lastTel.counters : null, failReasons: lastTel ? lastTel.failReasons : null,
      waiting: (() => { const w = [...rs].reverse().find((r) => r.type === 'event' && (r.event === 'wait' || r.event === 'reg' || r.event === 'sw')); return !!(w && w.event === 'wait'); })() };
  }

  /** Pontos do mapa (com posição) e segmentos coloridos por rede. */
  function mapPoints(recs, showSaved = false) {
    return sortRecs(recs).filter((r) => r.lat != null && r.lon != null && (showSaved || !/^salva|sem posicao/.test(r.posSrc || ''))).map((r) => ({ lat: r.lat, lon: r.lon, net: r.net, rec: r }));
  }
  function segments(points) {
    const segs = []; let cur = null;
    for (const p of points.filter((q) => q.rec.posSrc !== 'salva' && q.rec.posSrc !== 'celula sem posicao')) {
      if (!cur || cur.net !== p.net) { const start = cur ? [cur.pts[cur.pts.length - 1]] : []; cur = { net: p.net, pts: start }; segs.push(cur); }
      cur.pts.push([p.lat, p.lon]);
    }
    return segs.filter((s) => s.pts.length > 1);
  }

  const CSV_COLS = ['ts', 'rx', 'type', 'net', 'seq', 'event', 'value', 'info', 'plmn', 'act', 'band', 'rsrp', 'snr', 'ce', 'mv', 'temp', 'regFor', 'lat', 'lon', 'acc', 'posSrc', 'gnssAge', 'gnssSats', 'cell', 'transport', 'bytes', 'late', 'prevRttMs', 'rttMs', 'replay'];
  function toCSV(recs) {
    const esc = (v) => (v == null ? '' : /[",\n;]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    return [CSV_COLS.join(','), ...sortRecs(recs).map((r) => CSV_COLS.map((c) => esc(r[c])).join(','))].join('\n');
  }
  function fmtDur(s) {
    if (s == null || !isFinite(s)) return '—';
    s = Math.round(s);
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s';
    return Math.floor(s / 3600) + ' h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ' min';
  }
  function fmtMs(ms) { if (ms == null) return '—'; return ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + ' s' : Math.round(ms) + ' ms'; }
  const EVENT_PT = { sw: 'Comutação', reg: 'Registrado', lost: 'Perdeu rede', fix: 'Fix GNSS', fail: 'Falha', auto: 'Modo automático', demo: 'Demo de comutação', boot: 'Placa ligou', rst: 'Reinício Cat-M', ping: 'Ping', wait: 'Aguardando dados do satélite/rede', wdog: 'Watchdog: reinício da rede' };
  return { NET, gpsStatus, filterRecords, switches, kpis, liveStatus, mapPoints, segments, toCSV, fmtDur, fmtMs, pct, EVENT_PT, sortRecs };
});
