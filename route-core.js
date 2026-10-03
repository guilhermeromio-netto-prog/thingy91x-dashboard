/* Thingy:91X Dashboard v33 — route-core.js
 * Lógica PURA da trilha: limpeza (jitter/acurácia/saltos), segmentos por lacuna, paradas,
 * lotes + cliente de "ajuste às vias" (map matching) com cache/throttle/fallback, filtros e resumo.
 * Sem DOM. Carregado como <script> (window.RouteCore) e importado nos testes Node (globalThis.RouteCore).
 *
 * Serviços (públicos, sem chave, CORS liberado — testado com curl em São Paulo):
 *   1) Valhalla trace_route (valhalla1.openstreetmap.de) — map_snap, ~80 pontos/lote, ~1 s
 *   2) OSRM /route (router.project-osrm.org) por waypoints — fallback ("rota entre pontos")
 *   3) linha reta tracejada — se tudo falhar
 * (OSRM /match do servidor demo aceita no máximo 10 coordenadas -> não serve para trilhas.)
 */
(function (root) {
  'use strict';
  var DEF = {
    JITTER_M: 15,            // pontos a menos disso do último ponto mantido = ruído/parado
    MAX_UNC_M: 150,          // acurácia pior que isso: não entra na linha
    MAX_GAP_MS: 10 * 60e3,   // lacuna maior que isso: não une os trechos
    MAX_SPEED_KMH: 250,      // salto implausível = outlier
    STOP_MIN_MS: 3 * 60e3,   // parada = >3 min dentro do raio
    STOP_RADIUS_M: 40,
    MOVING_MIN_KMH: 3,
    CHUNK_SIZE: 80,          // pontos por chamada de map matching
    ESTIMATED_GAP_MS: 150e3, // intervalo > 2,5 min entre pontos: trajeto entre eles é estimado
    DETOUR_FACTOR: 3,        // trecho ajustado > 3x a reta (+slack) = descartado (reta)
    DETOUR_SLACK_M: 250,
    SNAP_MAX_M: 120          // ponto a mais que isso da via ajustada = não ajustável
  };
  var SP_OFFSET_MS = 3 * 3600e3; // America/Sao_Paulo = UTC-3 (sem horário de verão desde 2019)
  var DAY = 86400e3;

  /* ---------- util ---------- */
  function hav(lat1, lon1, lat2, lon2) {
    var R = 6371000, t = Math.PI / 180;
    var dp = (lat2 - lat1) * t, dl = (lon2 - lon1) * t;
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(lat1 * t) * Math.cos(lat2 * t) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function toMs(v) {
    if (v == null || v === '') return null;
    var t = typeof v === 'number' ? v : Date.parse(v);
    return isFinite(t) ? t : null;
  }
  function numOrNull(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function startOfDaySP(ms) { return Math.floor((ms - SP_OFFSET_MS) / DAY) * DAY + SP_OFFSET_MS; }
  function hourSP(ms) { return (((ms - SP_OFFSET_MS) % DAY) + DAY) % DAY / 3600e3; }
  function polyLen(g) { var m = 0; for (var i = 1; i < g.length; i++) m += hav(g[i - 1][0], g[i - 1][1], g[i][0], g[i][1]); return m; }
  function bearing(lat1, lon1, lat2, lon2) {
    var t = Math.PI / 180, y = Math.sin((lon2 - lon1) * t) * Math.cos(lat2 * t);
    var x = Math.cos(lat1 * t) * Math.sin(lat2 * t) - Math.sin(lat1 * t) * Math.cos(lat2 * t) * Math.cos((lon2 - lon1) * t);
    return (Math.atan2(y, x) / t + 360) % 360;
  }
  function fnv(str, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16);
  }
  function hash(str) { return fnv(str, 2166136261) + fnv(str, 40503); }

  /* ---------- polyline (Google/Valhalla/OSRM) ---------- */
  function decodePolyline(str, prec) {
    var f = Math.pow(10, prec == null ? 6 : prec), i = 0, lat = 0, lon = 0, out = [];
    while (i < str.length) {
      for (var k = 0; k < 2; k++) {
        var sh = 0, r = 0, b;
        do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32 && i <= str.length);
        var d = (r & 1) ? ~(r >> 1) : (r >> 1);
        if (k === 0) lat += d; else lon += d;
      }
      out.push([lat / f, lon / f]);
    }
    return out;
  }
  function encodePolyline(coords, prec) {
    var f = Math.pow(10, prec == null ? 6 : prec), pl = 0, po = 0, s = '';
    function enc(v) { v = v < 0 ? ~(v << 1) : (v << 1); var o = ''; while (v >= 32) { o += String.fromCharCode((32 | (v & 31)) + 63); v >>= 5; } return o + String.fromCharCode(v + 63); }
    coords.forEach(function (c) {
      var la = Math.round(c[0] * f), lo = Math.round(c[1] * f);
      s += enc(la - pl) + enc(lo - po); pl = la; po = lo;
    });
    return s;
  }

  /* ---------- preparo: acurácia, saltos, segmentos, jitter ---------- */
  function speedKmh(a, b) {
    var dt = Math.max(5, Math.abs(b.t - a.t) / 1000);
    return hav(a.lat, a.lon, b.lat, b.lon) / dt * 3.6;
  }
  function prepare(points, opts) {
    var o = Object.assign({}, DEF, opts || {});
    var valid = [], rejected = [];
    (points || []).forEach(function (p) {
      if (!p) return;
      var lat = numOrNull(p.lat), lon = numOrNull(p.lon), t = toMs(p.at);
      if (lat == null || lon == null || t == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) { rejected.push({ pt: p, reason: 'invalido', t: t }); return; }
      valid.push({ p: p, lat: lat, lon: lon, t: t });
    });
    valid.sort(function (a, b) { return a.t - b.t; });
    var acc = [];
    valid.forEach(function (v) {
      var u = numOrNull(v.p.unc);
      if (u != null && u > o.MAX_UNC_M) rejected.push({ pt: v.p, reason: 'acuracia', unc: u, t: v.t });
      else acc.push(v);
    });
    var good = [];
    for (var i = 0; i < acc.length; i++) {
      var cur = acc[i];
      if (good.length) {
        var last = good[good.length - 1];
        if (speedKmh(last, cur) > o.MAX_SPEED_KMH) {
          var next = acc[i + 1];
          if (!next || speedKmh(last, next) <= o.MAX_SPEED_KMH) { rejected.push({ pt: cur.p, reason: 'salto', t: cur.t }); continue; }
        }
      }
      cur.i = good.length;
      good.push(cur);
    }
    var segments = [], seg = null, prev = null;
    good.forEach(function (g) {
      if (!seg || g.t - prev.t > o.MAX_GAP_MS) { seg = { i: segments.length, nodes: [] }; segments.push(seg); }
      var last = seg.nodes[seg.nodes.length - 1];
      if (last && hav(last.lat, last.lon, g.lat, g.lon) < o.JITTER_M) {
        last.tEnd = g.t; last.members.push(g.p); g.node = last;
      } else {
        var nd = { lat: g.lat, lon: g.lon, t: g.t, tEnd: g.t, pt: g.p, members: [g.p], seg: seg.i, k: seg.nodes.length };
        seg.nodes.push(nd); g.node = nd;
      }
      prev = g;
    });
    var stops = detectStops(good, o, opts && opts.now);
    var pairs = buildPairs(segments, stops, o);
    return { opts: o, good: good, rejected: rejected, segments: segments, stops: stops, pairs: pairs };
  }
  function detectStops(good, o, nowMs) {
    var stops = [], n = good.length, i = 0;
    while (i < n) {
      var a = good[i], j = i;
      while (j + 1 < n && hav(a.lat, a.lon, good[j + 1].lat, good[j + 1].lon) <= o.STOP_RADIUS_M) j++;
      if (j > i && good[j].t - a.t >= o.STOP_MIN_MS) {
        var sl = 0, so = 0;
        for (var k = i; k <= j; k++) { sl += good[k].lat; so += good[k].lon; }
        var cnt = j - i + 1;
        stops.push({ startT: a.t, endT: good[j].t, durMs: good[j].t - a.t, lat: sl / cnt, lon: so / cnt, count: cnt, i0: i, i1: j,
          ongoing: j === n - 1 && nowMs != null && nowMs - good[j].t < 20 * 60e3 });
        i = j + 1;
      } else i++;
    }
    return stops;
  }
  function pairKey(a, b) {
    return a.t + '|' + a.lat.toFixed(5) + ',' + a.lon.toFixed(5) + '>' + b.t + '|' + b.lat.toFixed(5) + ',' + b.lon.toFixed(5);
  }
  function inStop(stops, t0, t1) {
    for (var i = 0; i < stops.length; i++) if (stops[i].startT <= t0 && t1 <= stops[i].endT) return true;
    return false;
  }
  function buildPairs(segments, stops, o) {
    var out = [];
    segments.forEach(function (seg) {
      for (var k = 1; k < seg.nodes.length; k++) {
        var a = seg.nodes[k - 1], b = seg.nodes[k];
        var dt = b.t - a.tEnd; if (dt <= 0) dt = Math.max(0, b.t - a.t);
        out.push({
          a: a, b: b, seg: seg.i, key: pairKey(a, b), dtMs: dt,
          straightM: hav(a.lat, a.lon, b.lat, b.lon),
          estimated: dt > o.ESTIMATED_GAP_MS,
          stopped: inStop(stops, a.t, b.tEnd)
        });
      }
    });
    return out;
  }

  /* ---------- lotes ---------- */
  function buildChunks(segments, size) {
    size = Math.max(3, size || DEF.CHUNK_SIZE);
    var out = [];
    (segments || []).forEach(function (seg) {
      var n = seg.nodes.length;
      for (var s = 0; s < n - 1; s += size - 1) {
        var nodes = seg.nodes.slice(s, s + size);
        if (nodes.length < 2) continue;
        var key = hash('v1|' + nodes.map(function (q) { return q.lat.toFixed(5) + ',' + q.lon.toFixed(5); }).join(';'));
        out.push({ seg: seg.i, start: s, nodes: nodes, key: key });
      }
    });
    return out;
  }

  /* ---------- divide a geometria ajustada em um pedaço por par de pontos ---------- */
  function densify(shape, stepM) {
    var D = { lat: [], lon: [], seg: [] };
    for (var i = 0; i < shape.length - 1; i++) {
      var a = shape[i], b = shape[i + 1], d = hav(a[0], a[1], b[0], b[1]);
      var k = Math.max(1, Math.ceil(d / stepM));
      for (var s = 0; s < k; s++) {
        D.lat.push(a[0] + (b[0] - a[0]) * s / k); D.lon.push(a[1] + (b[1] - a[1]) * s / k); D.seg.push(i);
      }
    }
    var l = shape[shape.length - 1];
    D.lat.push(l[0]); D.lon.push(l[1]); D.seg.push(shape.length - 1);
    return D;
  }
  function assignMonotone(nodes, D) {
    var n = nodes.length, m = D.lat.length, KX = Math.cos(nodes[0].lat * Math.PI / 180) * 111320, KY = 110574;
    function dist(nd, j) { var dx = (D.lon[j] - nd.lon) * KX, dy = (D.lat[j] - nd.lat) * KY; return Math.sqrt(dx * dx + dy * dy); }
    var cost = new Float64Array(m), back = new Array(n), j, i;
    for (j = 0; j < m; j++) cost[j] = dist(nodes[0], j);
    for (i = 1; i < n; i++) {
      var bi = new Int32Array(m), cur = new Float64Array(m), best = Infinity, arg = 0;
      for (j = 0; j < m; j++) {
        if (cost[j] < best) { best = cost[j]; arg = j; }
        bi[j] = arg; cur[j] = best + dist(nodes[i], j);
      }
      back[i] = bi; cost = cur;
    }
    var bj = 0, bc = Infinity;
    for (j = 0; j < m; j++) if (cost[j] < bc) { bc = cost[j]; bj = j; }
    var idx = new Array(n); idx[n - 1] = bj;
    for (i = n - 1; i >= 1; i--) idx[i - 1] = back[i][idx[i]];
    return idx;
  }
  function piece(shape, D, A, B) {
    var out = [[D.lat[A], D.lon[A]]];
    for (var v = D.seg[A] + 1; v <= D.seg[B]; v++) out.push([shape[v][0], shape[v][1]]);
    var end = [D.lat[B], D.lon[B]], last = out[out.length - 1];
    if (last[0] !== end[0] || last[1] !== end[1]) out.push(end);
    if (out.length < 2) out.push(end);
    return out;
  }
  /** shape: [[lat,lon]...] do serviço. Retorna { pairs:[{g,lenM,q}|{q:'direct'}], snaps:[[lat,lon]|null] } alinhados a nodes. */
  function splitShape(shape, nodes, opts) {
    var o = Object.assign({}, DEF, opts || {});
    if (!shape || shape.length < 2 || !nodes || nodes.length < 2) return null;
    var D = densify(shape, 20), idx = assignMonotone(nodes, D);
    var snaps = nodes.map(function (nd, i) {
      var j = idx[i];
      return hav(nd.lat, nd.lon, D.lat[j], D.lon[j]) <= o.SNAP_MAX_M ? [D.lat[j], D.lon[j]] : null;
    });
    var pairs = [];
    for (var i = 0; i < nodes.length - 1; i++) {
      var a = nodes[i], b = nodes[i + 1];
      if (!snaps[i] || !snaps[i + 1]) { pairs.push({ q: 'direct', why: 'longe-da-via' }); continue; }
      var g = piece(shape, D, idx[i], idx[i + 1]), len = polyLen(g), st = hav(a.lat, a.lon, b.lat, b.lon);
      if (len > o.DETOUR_FACTOR * st + o.DETOUR_SLACK_M) { pairs.push({ q: 'direct', why: 'desvio' }); continue; }
      pairs.push({ g: g, lenM: len, q: 'matched' });
    }
    return { pairs: pairs, snaps: snaps };
  }

  /* ---------- cores ---------- */
  function lerp(a, b, t) { return a + (b - a) * t; }
  function hex(c) { c = c.replace('#', ''); return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]; }
  function rgb(r) { return '#' + r.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }
  function ramp(stops, x) {
    if (x <= stops[0][0]) return stops[0][1];
    for (var i = 1; i < stops.length; i++) {
      if (x <= stops[i][0]) {
        var t = (x - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]), A = hex(stops[i - 1][1]), B = hex(stops[i][1]);
        return rgb([lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)]);
      }
    }
    return stops[stops.length - 1][1];
  }
  var SPEED_RAMP = [[0, '#22c55e'], [30, '#a3e635'], [55, '#facc15'], [80, '#f97316'], [110, '#dc2626']];
  var HOUR_RAMP = [[0, '#1e3a8a'], [6, '#7c3aed'], [9, '#f59e0b'], [13, '#10b981'], [17, '#ef4444'], [20, '#be185d'], [24, '#1e3a8a']];
  var BAT_RAMP = [[0, '#dc2626'], [20, '#f97316'], [50, '#facc15'], [100, '#22c55e']];
  function speedColor(kmh) { return kmh == null ? '#94a3b8' : ramp(SPEED_RAMP, kmh); }
  function hourColor(h) { return h == null ? '#94a3b8' : ramp(HOUR_RAMP, h); }
  function batteryColor(p) { return p == null ? '#94a3b8' : ramp(BAT_RAMP, p); }
  function batteryPct(pt) {
    if (!pt) return null;
    var b = numOrNull(pt.battery); if (b != null) return b;
    var v = numOrNull(pt.batteryVoltage); if (v == null) return null;
    if (v > 1000) v /= 1000;
    return Math.max(0, Math.min(100, Math.round((v - 3.2) / 1.0 * 100)));
  }
  function pairColor(pair, colorBy) {
    if (colorBy === 'hour') return hourColor(hourSP((pair.a.t + pair.b.t) / 2));
    if (colorBy === 'battery') { var p = batteryPct(pair.b.pt); if (p == null) p = batteryPct(pair.a.pt); return batteryColor(p); }
    return speedColor(pair.kmh);
  }

  /* ---------- filtros / visão / resumo ---------- */
  var DEFAULT_FILTERS = {
    period: 'today', from: null, to: null, vmin: null, vmax: null, mode: 'all',
    gnss: true, wifi: true, cell: true, colorBy: 'speed',
    snap: true, raw: false, arrows: true, animate: true, follow: false, base: 'light'
  };
  function normalizeFilters(f) {
    var o = Object.assign({}, DEFAULT_FILTERS, f || {});
    if (['live', '1h', 'today', 'yesterday', '7d', 'all', 'custom'].indexOf(o.period) < 0) o.period = 'today';
    if (['all', 'move', 'stop'].indexOf(o.mode) < 0) o.mode = 'all';
    if (['speed', 'hour', 'battery'].indexOf(o.colorBy) < 0) o.colorBy = 'speed';
    if (['light', 'dark', 'sat', 'osm'].indexOf(o.base) < 0) o.base = 'light';
    o.vmin = numOrNull(o.vmin); o.vmax = numOrNull(o.vmax);
    if (o.vmin != null && o.vmin < 0) o.vmin = 0;
    if (o.vmin != null && o.vmax != null && o.vmax < o.vmin) { var t = o.vmin; o.vmin = o.vmax; o.vmax = t; }
    o.from = toMs(o.from); o.to = toMs(o.to);
    ['gnss', 'wifi', 'cell', 'snap', 'raw', 'arrows', 'animate', 'follow'].forEach(function (k) { o[k] = !!o[k]; });
    return o;
  }
  function filtersActive(f) {
    var d = DEFAULT_FILTERS;
    return f.period !== d.period || f.vmin != null || f.vmax != null || f.mode !== 'all' || !f.gnss || !f.wifi || !f.cell;
  }
  function periodWindow(f, now) {
    var d0 = startOfDaySP(now);
    switch (f.period) {
      case 'live': return { t0: now - 15 * 60e3, t1: now };
      case '1h': return { t0: now - 3600e3, t1: now };
      case 'today': return { t0: d0, t1: now };
      case 'yesterday': return { t0: d0 - DAY, t1: d0 };
      case '7d': return { t0: now - 7 * DAY, t1: now };
      case 'custom': return { t0: f.from == null ? -Infinity : f.from, t1: f.to == null ? Infinity : f.to };
      default: return { t0: -Infinity, t1: Infinity };
    }
  }
  function sourceClass(pt) {
    var s = String((pt && (pt.serviceType || pt.src || pt._src)) || '').toLowerCase();
    if (s.indexOf('wifi') >= 0) return 'wifi';
    if (s.indexOf('cell') >= 0 || s.indexOf('ground') >= 0) return 'cell';
    return 'gnss';
  }
  /** lookup(key) -> {g,lenM,q} | null */
  function computeView(prep, filters, lookup, now) {
    var f = normalizeFilters(filters), w = periodWindow(f, now);
    var srcOk = function (pt) { return f[sourceClass(pt)]; };
    var nodeOk = function (n) { return n.t >= w.t0 && n.t <= w.t1 && srcOk(n.pt); };
    var arrival = new Map(); // node.t -> kmh de chegada
    var pairs = [], quality = { matched: 0, routed: 0, direct: 0 };
    var distM = 0, movingMs = 0, maxKmh = null;
    prep.pairs.forEach(function (p) {
      var m = lookup ? lookup(p.key) : null;
      var usable = m && m.g && m.q !== 'direct';
      var lenM = usable ? m.lenM : p.straightM;
      var kmh = p.dtMs >= 5000 ? Math.min(lenM / (p.dtMs / 1000) * 3.6, 300) : null;
      arrival.set(p.b.t, kmh);
      if (!nodeOk(p.a) || !nodeOk(p.b)) return;
      if (f.mode === 'move' && p.stopped) return;
      if (f.mode === 'stop') return;
      if (kmh != null && ((f.vmin != null && kmh < f.vmin) || (f.vmax != null && kmh > f.vmax))) return;
      var q = usable ? (m.q === 'routed' ? 'routed' : 'matched') : 'direct';
      quality[q]++;
      var vp = { a: p.a, b: p.b, key: p.key, seg: p.seg, kmh: kmh, stopped: p.stopped, estimated: p.estimated, lenM: lenM, dtMs: p.dtMs, geom: usable ? m.g : null, quality: q };
      pairs.push(vp);
      distM += lenM;
      if (!p.stopped && p.dtMs > 0) movingMs += p.dtMs;
      if (kmh != null && p.dtMs >= 10000 && (maxKmh == null || kmh > maxKmh)) maxKmh = kmh;
    });
    var stopsOn = f.mode !== 'move' && !(f.vmin != null && f.vmin > 0);
    var stops = stopsOn ? prep.stops.filter(function (s) { return s.endT >= w.t0 && s.startT <= w.t1 && f[sourceClass(prep.good[s.i0].p)]; }) : [];
    var stoppedMs = 0;
    stops.forEach(function (s) { stoppedMs += Math.max(0, Math.min(s.endT, w.t1) - Math.max(s.startT, w.t0)); });
    var points = [];
    prep.good.forEach(function (g) {
      if (g.t < w.t0 || g.t > w.t1 || !srcOk(g.p)) return;
      var st = inStop(prep.stops, g.t, g.t);
      if (f.mode === 'move' && st) return;
      if (f.mode === 'stop' && !st) return;
      var kmh = arrival.has(g.t) ? arrival.get(g.t) : null;
      if (kmh != null && ((f.vmin != null && kmh < f.vmin) || (f.vmax != null && kmh > f.vmax))) return;
      points.push({ pt: g.p, t: g.t, kmh: kmh, stopped: st, anchor: !!(g.node && g.node.pt === g.p) });
    });
    var rejected = prep.rejected.filter(function (r) { return r.t != null && r.t >= w.t0 && r.t <= w.t1; });
    return {
      filters: f, window: w, pairs: pairs, points: points, stops: stops, rejected: rejected,
      stats: {
        distM: distM, movingMs: movingMs, stoppedMs: stoppedMs, nStops: stops.length, nPoints: points.length, nPairs: pairs.length,
        avgKmh: movingMs >= 30000 ? distM / (movingMs / 1000) * 3.6 : null, maxKmh: maxKmh, quality: quality
      }
    };
  }

  /* ---------- cliente de map matching (Valhalla -> OSRM -> reta) ---------- */
  function createMatcher(cfg) {
    cfg = Object.assign({
      fetch: typeof root.fetch === 'function' ? root.fetch.bind(root) : null,
      storage: null, storageKey: 'thingy_rm_cache_v1', maxCacheEntries: 160, maxCacheChars: 1.3e6,
      minIntervalMs: 1200, timeoutMs: 12000, maxPerRun: 40, now: Date.now,
      sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
      clientId: 'thingy91x-dashboard',
      valhallaUrl: 'https://valhalla1.openstreetmap.de/trace_route',
      osrmUrl: 'https://router.project-osrm.org/route/v1/driving/',
      breakerFails: 3, breakerMs: 5 * 60e3, failRetryMs: 10 * 60e3, opts: {}, onUpdate: null
    }, cfg || {});
    var o = Object.assign({}, DEF, cfg.opts);
    var pairsMap = new Map(), snapMap = new Map(), failUntil = new Map(), memShape = new Map();
    var svc = { valhalla: { fails: 0, until: 0 }, osrm: { fails: 0, until: 0 } };
    var lastReq = 0, running = false, latest = null, version = 0, cache = null, calls = { valhalla: 0, osrm: 0 };
    var status = { state: 'idle', total: 0, done: 0, failed: 0, deferred: 0, services: { valhalla: 'ok', osrm: 'ok' } };

    function loadCache() {
      if (cache) return cache;
      cache = {};
      try { if (cfg.storage) cache = JSON.parse(cfg.storage.getItem(cfg.storageKey) || '{}') || {}; } catch (e) { cache = {}; }
      return cache;
    }
    function saveCache() {
      if (!cfg.storage) return;
      var c = loadCache(), keys = Object.keys(c).sort(function (a, b) { return (c[a].t || 0) - (c[b].t || 0); });
      var chars = keys.reduce(function (s, k) { return s + (c[k].s || '').length + 40; }, 0);
      while (keys.length && (keys.length > cfg.maxCacheEntries || chars > cfg.maxCacheChars)) {
        var k = keys.shift(); chars -= (c[k].s || '').length + 40; delete c[k];
      }
      for (var tries = 0; tries < 4; tries++) {
        try { cfg.storage.setItem(cfg.storageKey, JSON.stringify(c)); return; }
        catch (e) { // quota: descarta metade dos mais antigos
          keys = Object.keys(c).sort(function (a, b) { return (c[a].t || 0) - (c[b].t || 0); });
          keys.slice(0, Math.ceil(keys.length / 2)).forEach(function (kk) { delete c[kk]; });
        }
      }
    }
    function lookupShape(key) {
      if (memShape.has(key)) return memShape.get(key);
      var e = loadCache()[key];
      if (e && e.s) {
        var r = { shape: decodePolyline(e.s, 6), svc: e.v === 'o' ? 'osrm' : 'valhalla' };
        memShape.set(key, r); return r;
      }
      return null;
    }
    function storeShape(key, shape, service) {
      memShape.set(key, { shape: shape, svc: service });
      loadCache()[key] = { s: encodePolyline(shape, 6), v: service === 'osrm' ? 'o' : 'v', t: cfg.now() };
      saveCache();
    }
    function apply(chunk, res) {
      var sp = splitShape(res.shape, chunk.nodes, o);
      if (!sp) return false;
      for (var i = 0; i < chunk.nodes.length - 1; i++) {
        var key = pairKey(chunk.nodes[i], chunk.nodes[i + 1]), p = sp.pairs[i];
        if (p.q === 'direct') pairsMap.set(key, { q: 'direct', why: p.why });
        else pairsMap.set(key, { g: p.g, lenM: p.lenM, q: res.svc === 'osrm' ? 'routed' : 'matched', svc: res.svc });
      }
      sp.snaps.forEach(function (s, i) { if (s) snapMap.set(chunk.nodes[i].t + '|' + chunk.nodes[i].k + '|' + chunk.seg, s); });
      return true;
    }
    async function http(url, init) {
      var wait = lastReq + cfg.minIntervalMs - cfg.now();
      lastReq = Math.max(cfg.now(), lastReq + cfg.minIntervalMs); // reserva o slot
      if (wait > 0) await cfg.sleep(wait);
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, cfg.timeoutMs) : null;
      var res;
      try { res = await cfg.fetch(url, Object.assign({}, init, ctl ? { signal: ctl.signal } : {})); }
      catch (e) { var er = new Error('rede: ' + (e && e.message || e)); er.network = true; throw er; }
      finally { if (timer) clearTimeout(timer); }
      if (!res.ok) {
        var er2 = new Error('HTTP ' + res.status); er2.status = res.status;
        var ra = res.headers && res.headers.get && res.headers.get('retry-after');
        if (ra && isFinite(+ra)) er2.retryAfterMs = +ra * 1000;
        try { er2.body = await res.json(); } catch (e) { /* sem corpo */ }
        throw er2;
      }
      return res.json();
    }
    async function callValhalla(nodes) {
      calls.valhalla++;
      var uncs = nodes.map(function (n) { return numOrNull(n.pt && n.pt.unc); }).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });
      var med = uncs.length ? uncs[Math.floor(uncs.length / 2)] : 15;
      var body = {
        shape: nodes.map(function (n) { return { lat: n.lat, lon: n.lon }; }),
        costing: 'auto', shape_match: 'map_snap',
        trace_options: { search_radius: 50, gps_accuracy: Math.max(10, Math.min(40, med)) },
        directions_options: { narrative: false }
      };
      var j;
      try {
        j = await http(cfg.valhallaUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Id': cfg.clientId }, body: JSON.stringify(body) });
      } catch (e) {
        if (e.status === 400 && e.body && (e.body.error_code === 443 || e.body.error_code === 442 || e.body.error_code === 171)) e.noPath = true;
        throw e;
      }
      var shape = [];
      ((j && j.trip && j.trip.legs) || []).forEach(function (leg) {
        var s = decodePolyline(leg.shape, 6);
        if (shape.length && s.length) s.shift();
        shape = shape.concat(s);
      });
      if (shape.length < 2) { var er = new Error('Valhalla sem geometria'); er.noPath = true; throw er; }
      return shape;
    }
    async function callOsrm(nodes) {
      calls.osrm++;
      var coords = nodes.map(function (n) { return n.lon.toFixed(6) + ',' + n.lat.toFixed(6); }).join(';');
      var j = await http(cfg.osrmUrl + coords + '?overview=full&geometries=polyline6&steps=false', { method: 'GET' });
      if (!j || j.code !== 'Ok' || !j.routes || !j.routes[0] || !j.routes[0].geometry) { var er = new Error('OSRM: ' + (j && j.code)); er.noPath = true; throw er; }
      var shape = decodePolyline(j.routes[0].geometry, 6);
      if (shape.length < 2) { var e2 = new Error('OSRM sem geometria'); e2.noPath = true; throw e2; }
      return shape;
    }
    function svcOk(name) { return cfg.now() >= svc[name].until; }
    function markOk(name) { svc[name].fails = 0; status.services[name] = 'ok'; }
    function markFail(name, e) {
      if (e && e.noPath) return; // sem rota para este lote não é falha do serviço
      var s = svc[name]; s.fails++;
      if (e && e.retryAfterMs) s.until = cfg.now() + Math.min(e.retryAfterMs, 5 * 60e3);
      else if (e && e.status === 429) s.until = cfg.now() + 60e3;
      if (s.fails >= cfg.breakerFails) { s.until = cfg.now() + cfg.breakerMs; s.fails = 0; }
      if (!svcOk(name)) status.services[name] = 'down';
    }
    async function fetchChunk(chunk) {
      if (!cfg.fetch) return null;
      if (svcOk('valhalla')) {
        try { var sh = await callValhalla(chunk.nodes); markOk('valhalla'); return { shape: sh, svc: 'valhalla' }; }
        catch (e) { markFail('valhalla', e); }
      }
      if (svcOk('osrm')) {
        try { var so = await callOsrm(chunk.nodes); markOk('osrm'); return { shape: so, svc: 'osrm' }; }
        catch (e2) { markFail('osrm', e2); }
      }
      return null;
    }
    function emit() { if (typeof cfg.onUpdate === 'function') { try { cfg.onUpdate(status); } catch (e) { /* UI */ } } }
    async function processAll(segments, myVersion) {
      var chunks = buildChunks(segments, o.CHUNK_SIZE), pending = [];
      status.total = chunks.length; status.done = 0; status.failed = 0; status.deferred = 0;
      chunks.forEach(function (c) {
        var hit = lookupShape(c.key);
        if (hit && apply(c, hit)) status.done++; else pending.push(c);
      });
      status.state = pending.length ? 'matching' : 'done';
      emit();
      pending.reverse(); // mais recentes primeiro
      var budget = cfg.maxPerRun;
      for (var i = 0; i < pending.length; i++) {
        if (myVersion !== version) return false; // chegaram pontos novos: recomeça (cache já guardou o progresso)
        var c = pending[i];
        if ((failUntil.get(c.key) || 0) > cfg.now()) { status.failed++; continue; }
        if (budget-- <= 0) { status.deferred++; continue; }
        var res = await fetchChunk(c);
        if (res && apply(c, res)) { storeShape(c.key, res.shape, res.svc); status.done++; }
        else { failUntil.set(c.key, cfg.now() + cfg.failRetryMs); status.failed++; }
        emit();
      }
      status.state = 'done'; emit();
      return true;
    }
    function update(segments) {
      latest = segments; version++;
      if (running) return;
      running = true;
      (async function loop() {
        try {
          for (;;) {
            var v = version, ok = await processAll(latest, v);
            if (ok && v === version) break;
          }
        } catch (e) { status.state = 'done'; emit(); }
        running = false;
      })();
    }
    return {
      update: update,
      lookup: function (key) { return pairsMap.get(key) || null; },
      snap: function (node) { return snapMap.get(node.t + '|' + node.k + '|' + node.seg) || null; },
      status: status, calls: calls, _svc: svc,
      isRunning: function () { return running; },
      clearFailures: function () { failUntil.clear(); svc.valhalla.until = 0; svc.osrm.until = 0; svc.valhalla.fails = 0; svc.osrm.fails = 0; status.services = { valhalla: 'ok', osrm: 'ok' }; },
      _cacheSize: function () { return Object.keys(loadCache()).length; }
    };
  }

  root.RouteCore = {
    DEF: DEF, DEFAULT_FILTERS: DEFAULT_FILTERS,
    hav: hav, toMs: toMs, startOfDaySP: startOfDaySP, hourSP: hourSP, bearing: bearing, polyLen: polyLen, hash: hash,
    decodePolyline: decodePolyline, encodePolyline: encodePolyline,
    prepare: prepare, detectStops: detectStops, buildPairs: buildPairs, pairKey: pairKey, buildChunks: buildChunks,
    densify: densify, splitShape: splitShape,
    speedColor: speedColor, hourColor: hourColor, batteryColor: batteryColor, batteryPct: batteryPct, pairColor: pairColor,
    SPEED_RAMP: SPEED_RAMP, HOUR_RAMP: HOUR_RAMP, BAT_RAMP: BAT_RAMP,
    normalizeFilters: normalizeFilters, filtersActive: filtersActive, periodWindow: periodWindow, sourceClass: sourceClass,
    computeView: computeView, createMatcher: createMatcher
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
