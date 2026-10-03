"""Headless Chrome (playwright) — rota ajustada às ruas + filtros (v33).
Uso: python3 tests/e2e_route.py [cenario ...]    (padrão: matched osrm fallback filters)
  matched   Valhalla simulado devolve a geometria da rua (com esquina) -> badge 'Ajustado às ruas', linhas 'matched'
  osrm      Valhalla 503 -> OSRM simulado -> 'Rota entre pontos'
  fallback  Valhalla e OSRM fora do ar -> 'Linha direta' (tracejada fina), sem erro de página
  filters   chips/velocidade/paradas/persistência em localStorage/cache (2ª visita não chama a rede)
  live      (manual, precisa de internet) serviços e mapas reais + screenshots em /workspace/thingy-debug/
Não usa chaves reais; intercepta /.netlify/functions/** e serve os arquivos locais."""
import json, os, sys, math, random, mimetypes, base64, datetime as dt, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
import e2e_presence as base

ROOT, PAGES, DEV = base.ROOT, base.PAGES, base.DEV
OUT = '/workspace/thingy-debug'
os.makedirs(OUT, exist_ok=True)
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')

def hav(a, b):
    R = 6371000; p1, p2 = math.radians(a[0]), math.radians(b[0]); dl = math.radians(b[1] - a[1]); dp = p2 - p1
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))

def enc(coords, prec=6):
    f = 10 ** prec; pl = po = 0; s = ''
    def e(v):
        v = ~(v << 1) if v < 0 else (v << 1); o = ''
        while v >= 32: o += chr((32 | (v & 31)) + 63); v >>= 5
        return o + chr(v + 63)
    for la, lo in coords:
        la, lo = round(la * f), round(lo * f); s += e(la - pl) + e(lo - po); pl, po = la, lo
    return s

def sample(line, step, noise, rnd):
    out = []; cum = 0; nxt = 0
    for i in range(1, len(line)):
        d = hav(line[i - 1], line[i])
        while nxt <= cum + d:
            f = (nxt - cum) / d if d else 0
            out.append((line[i - 1][0] + (line[i][0] - line[i - 1][0]) * f + rnd.gauss(0, noise / 110574),
                        line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f + rnd.gauss(0, noise / 102000)))
            nxt += step
        cum += d
    return out

# "rua" sintética em L perto da Av. Paulista: 900 m a leste e 700 m ao norte (esquina = cruzamento)
A = (-23.5614, -46.6559)
CORNER = (A[0], A[1] + 900 / 102000)
END = (A[0] + 700 / 110574, CORNER[1])
STREET = [A, CORNER, END]

def build_history(points, t_end, step_s, stop_after=None, stop_min=0):
    """pontos mais antigos primeiro; t_end = hora do último ponto; opcional parada (pontos repetidos) depois do índice stop_after."""
    items = []; t = t_end - dt.timedelta(seconds=step_s * (len(points) - 1)) - dt.timedelta(minutes=stop_min)
    for i, (la, lo) in enumerate(points):
        items.append({"id": f"r{i}", "deviceId": DEV, "serviceType": "GNSS", "insertedAt": base.iso(t), "lat": f"{la:.6f}", "lon": f"{lo:.6f}", "uncertainty": "9"})
        if stop_after is not None and i == stop_after:
            for k in range(1, 5):  # parado stop_min minutos, pequenos tremores
                t2 = t + dt.timedelta(minutes=stop_min * k / 4)
                items.append({"id": f"s{k}", "deviceId": DEV, "serviceType": "GNSS", "insertedAt": base.iso(t2), "lat": f"{la + k * 1e-6:.6f}", "lon": f"{lo:.6f}", "uncertainty": "9"})
            t = t + dt.timedelta(minutes=stop_min)
        t += dt.timedelta(seconds=step_s)
    return list(reversed(items))  # API devolve o mais novo primeiro

def run(sc, opts, hist_items, results, screenshots=()):
    out = {"scenario": sc, "console": [], "valhalla": [], "osrm": 0, "tiles": 0}
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
        ctx = b.new_context(viewport=opts.get('viewport', {'width': 1400, 'height': 1000}), service_workers='block', locale='pt-BR', timezone_id='America/Sao_Paulo')
        pg = ctx.new_page()
        pg.on('console', lambda m: out["console"].append(f"{m.type}: {m.text}"[:240]) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
        pg.on('pageerror', lambda e: out["console"].append(f"PAGEERROR: {e}"[:400]))
        init = "localStorage.setItem('nrf_api_key','FAKE');localStorage.setItem('nrf_user_email','t@example.com');localStorage.setItem('nrf_team_api_key','FAKE');localStorage.setItem('nrf_device_id','%s');" % DEV
        for k, v in (opts.get('ls') or {}).items(): init += f"if(!sessionStorage.getItem('_seed_{k}')){{localStorage.setItem('{k}',{json.dumps(v)});sessionStorage.setItem('_seed_{k}','1')}}"
        pg.add_init_script(init)
        H = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS'}
        def api(route):
            u = route.request.url
            J = lambda o: route.fulfill(status=200, content_type='application/json', body=json.dumps(o), headers=H)
            if '/functions/alerts' in u: return J({"alerts": []})
            path = u.split('/functions/nrfcloud')[-1]
            if path.startswith('/devices?'): return J({"items": [base.device('full')], "total": 1})
            if path.startswith('/devices/'): return J(base.device('full'))
            if path.startswith('/messages'): return J({"items": [], "total": 0})
            if path.startswith('/location/history'): return J({"items": hist_items, "total": len(hist_items)})
            return route.fulfill(status=404, content_type='application/json', body='{}', headers=H)
        pg.route('**/.netlify/functions/**', api)
        def local(route):
            path = route.request.url.split('/thingy91x-dashboard/')[-1].split('?')[0].split('#')[0] or 'index.html'
            fp = os.path.join(ROOT, path)
            if not os.path.isfile(fp): return route.fulfill(status=404, body='')
            return route.fulfill(status=200, body=open(fp, 'rb').read(), content_type=mimetypes.guess_type(fp)[0] or 'application/octet-stream')
        pg.route(PAGES + '**', local)
        if opts.get('tiles', 'stub') == 'stub':
            def tile(route): out["tiles"] += 1; route.fulfill(status=200, body=PNG, content_type='image/png', headers=H)
            for pat in ('**/arcgisonline.com/**', '**/tile.openstreetmap.org/**', '**/arcgisonline.com/**'): pg.route(pat, tile)
        vmode = opts.get('valhalla', 'stub'); omode = opts.get('osrm', 'stub')
        def valhalla(route):
            if route.request.method == 'OPTIONS': return route.fulfill(status=204, headers=H)
            body = json.loads(route.request.post_data or '{}'); out["valhalla"].append(len(body.get('shape', [])))
            if vmode == 'fail': return route.fulfill(status=503, body='{"error":"down"}', content_type='application/json', headers=H)
            return route.fulfill(status=200, content_type='application/json', headers=H, body=json.dumps({"trip": {"legs": [{"shape": enc(opts['street'])}], "summary": {"length": 1.6}}}))
        def osrm(route):
            out["osrm"] += 1
            if omode == 'fail': return route.fulfill(status=500, body='{"code":"Error"}', content_type='application/json', headers=H)
            return route.fulfill(status=200, content_type='application/json', headers=H, body=json.dumps({"code": "Ok", "routes": [{"geometry": enc(opts['street']), "distance": 1600}]}))
        if vmode != 'live': pg.route('**/valhalla1.openstreetmap.de/**', valhalla)
        if omode != 'live': pg.route('**/router.project-osrm.org/**', osrm)
        pg.goto(PAGES, wait_until='domcontentloaded', timeout=60000)
        pg.wait_for_timeout(opts.get('wait', 9000))
        if opts.get('after'): opts['after'](pg, out)
        ev = lambda js: pg.evaluate(js)
        out.update({
            "badge": ev("document.getElementById('routeBadge').textContent"),
            "badgeClass": ev("document.getElementById('routeBadge').className"),
            "summary": ev("document.getElementById('routeSummary').textContent"),
            "layers": ev("routeLines.getLayers().map(l=>({q:l.options.routeQ||'casing',n:l.getLatLngs().length,color:l.options.color,dash:l.options.dashArray||null,w:l.options.weight}))"),
            "pins": ev("routePins.getLayers().length"), "arrows": ev("routeArrows.getLayers().length"), "live": ev("routeLive.getLayers().length"),
            "nPairs": ev("routeView.pairs.length"), "nPoints": ev("routeView.points.length"), "nStops": ev("routeView.stops.length"),
            "filters": ev("JSON.parse(localStorage.getItem('thingy_route_filters_v1')||'null')"),
            "cacheEntries": ev("Object.keys(JSON.parse(localStorage.getItem('thingy_rm_cache_v1')||'{}')).length"),
            "pillActive": ev("[...document.querySelectorAll('#rfPeriod .rf-chip.active')].map(b=>b.textContent)"),
            "playbackMax": ev("document.getElementById('playbackScrub').max"),
            "cornerM": ev("(()=>{const C=%s;let best=1e9;routeLines.getLayers().filter(l=>l.options.routeQ==='matched').forEach(l=>l.getLatLngs().forEach(p=>{best=Math.min(best,map.distance(p,C))}));return best})()" % json.dumps(list(CORNER))),
        })
        for name, clip in screenshots:
            pg.evaluate("document.querySelector('.card-map').scrollIntoView({block:'start'})"); pg.wait_for_timeout(1200)
            pg.locator('.card-map').screenshot(path=f'{OUT}/{name}')
        pg.screenshot(path=f'/tmp/e2e/route_{sc}.png') if os.makedirs('/tmp/e2e', exist_ok=True) is None else None
        if opts.get('keep'): out['_page'] = None
        b.close()
    results.append(out); return out

def street_points(seed=3, step=150):
    rnd = random.Random(seed)
    return sample(STREET, step, 6, rnd)

# viagem longa sintética para os filtros: 3 trechos, parada de 6 min na esquina, velocidades diferentes
LONG = [A, (A[0], A[1] + 6000 / 102000), (A[0] + 6000 / 110574, A[1] + 6000 / 102000), (A[0] + 6000 / 110574, A[1] + 10500 / 102000)]

def long_history(end_min_ago=2):
    rnd = random.Random(5); items = []; t_end = base.now - dt.timedelta(minutes=end_min_ago)
    pts = []  # (lat, lon, minutos_depois_do_anterior)
    leg1 = sample(LONG[:2], 600, 5, rnd)          # 600 m/min = 36 km/h
    leg2 = sample(LONG[1:3], 1500, 5, rnd)        # 1500 m/min = 90 km/h
    leg3 = sample(LONG[2:4], 500, 5, rnd)
    seq = [(p, 1) for p in leg1]
    seq += [((leg1[-1][0] + 2e-6, leg1[-1][1]), 3), ((leg1[-1][0], leg1[-1][1] + 3e-6), 3)]   # parado 6 min
    seq += [(p, 1) for p in leg2] + [(p, 1) for p in leg3]
    total = sum(m for _, m in seq)
    t = t_end - dt.timedelta(minutes=total)
    for k, ((la, lo), m) in enumerate(seq):
        t += dt.timedelta(minutes=m)
        items.append({"id": f"L{k}", "deviceId": DEV, "serviceType": "GNSS", "insertedAt": base.iso(t), "lat": f"{la:.6f}", "lon": f"{lo:.6f}", "uncertainty": "9"})
    return list(reversed(items))

def now_end(): return base.now - dt.timedelta(minutes=2)

def check(o, errs):
    sc = o['scenario']
    def need(c, m):
        if not c: errs.append(f"[{sc}] {m}")
    need(not [c for c in o['console'] if 'PAGEERROR' in c], f"erros de página: {[c for c in o['console'] if 'PAGEERROR' in c]}")
    need(o['nPairs'] >= 5, f"pares={o['nPairs']}")
    main = [l for l in o['layers'] if l['q'] != 'casing']
    if sc == 'matched':
        need(o['badge'] == 'Ajustado às ruas' and 'ok' in o['badgeClass'], f"badge={o['badge']!r} {o['badgeClass']}")
        need(o['valhalla'] and max(o['valhalla']) >= 10, f"Valhalla recebeu {o['valhalla']}")
        need(all(l['q'] == 'matched' for l in main), 'há linhas que não são matched')
        need(o['cornerM'] < 5, f"a linha ajustada não passa pela esquina (menor distância {o['cornerM']:.0f} m)")
        need(any(l['q'] == 'casing' for l in o['layers']), 'sem contorno')
        need(o['pins'] >= 2, f"marcadores início/fim={o['pins']}")
        need(o['arrows'] >= 1, f"setas={o['arrows']}")
        need(o['live'] >= 1, 'sem trecho animado recente')
        need(len({l['color'] for l in main}) >= 1, 'sem cor')
        need(o['cacheEntries'] >= 1, 'cache localStorage vazio')
        need('km' in o['summary'] or ' m' in o['summary'], f"resumo={o['summary']!r}")
    if sc == 'osrm':
        need('Rota entre pontos' in o['badge'], f"badge={o['badge']!r}")
        need(o['osrm'] >= 1 and all(l['q'] == 'routed' for l in main), 'linhas não são routed')
    if sc == 'fallback':
        need(o['badge'].startswith('Linha direta'), f"badge={o['badge']!r}")
        need(main and all(l['q'] == 'direct' and l['dash'] == '4 6' and l['w'] == 2 for l in main), f"linhas diretas tracejadas finas: {main[:2]}")
        need(not any(l['q'] == 'casing' for l in o['layers']), 'sem contorno em linha direta')
    return errs

def scenario_matched():
    pts = street_points(); h = build_history(pts, now_end(), 60)
    return h, dict(street=STREET)


def live_route():
    """rota real em São Paulo (OSRM público): Sé -> Av. Paulista -> Ibirapuera, amostrada com passos variáveis (1 fix/min) + ruído de 7 m"""
    u = 'https://router.project-osrm.org/route/v1/driving/-46.6333,-23.5505;-46.6559,-23.5614;-46.6576,-23.5874?overview=full&geometries=geojson'
    j = json.loads(urllib.request.urlopen(u, timeout=30).read()); line = [(y, x) for x, y in j['routes'][0]['geometry']['coordinates']]
    rnd = random.Random(11); pat = [250, 420, 600, 300, 520, 700, 220, 480]; pts = []; cum = 0; nxt = 0; k = 0
    for i in range(1, len(line)):
        d = hav(line[i - 1], line[i])
        while nxt <= cum + d:
            f = (nxt - cum) / d if d else 0
            pts.append((line[i - 1][0] + (line[i][0] - line[i - 1][0]) * f + rnd.gauss(0, 7 / 110574), line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f + rnd.gauss(0, 7 / 102000)))
            nxt += pat[k % len(pat)]; k += 1
        cum += d
    paulista = min(range(len(pts)), key=lambda i: hav(pts[i], (-23.5614, -46.6559)))
    return pts, paulista

def run_live(results):
    pts, stop_i = live_route(); h = build_history(pts, now_end(), 60, stop_after=stop_i, stop_min=6)
    print('rota real:', len(pts), 'pontos; parada após o ponto', stop_i)
    common = dict(valhalla='live', osrm='live', tiles='live', wait=16000, street=None)
    r1 = run('live', dict(common), h, results, screenshots=[('rota-sp-desktop.png', None)])
    r2 = run('live_dark', dict(common, ls={'thingy_route_filters_v1': json.dumps({'base': 'dark', 'colorBy': 'speed', 'period': 'today', 'raw': True})}), h, results, screenshots=[('rota-sp-escuro.png', None)])
    r3 = run('live_mobile', dict(common, viewport={'width': 390, 'height': 844}), h, results, screenshots=[('rota-sp-mobile.png', None)])
    r4 = run('live_direta', dict(common, ls={'thingy_route_filters_v1': json.dumps({'snap': False, 'period': 'today', 'colorBy': 'speed'})}), h, results, screenshots=[('rota-sp-linha-direta-antes.png', None)])
    for r in (r1, r2, r3, r4):
        print(r['scenario'], '|', r['badge'], '|', r['summary'], '| camadas:', len({l['q'] for l in r['layers']}), 'tipos', sorted({l['q'] for l in r['layers']}), '| valhalla chamadas:', len(r['valhalla']), '| paradas:', r['nStops'])
    return r1, r2, r3, r4

if __name__ == '__main__':
    names = sys.argv[1:] or ['matched', 'osrm', 'fallback']
    errs = []; res = []
    for sc in names:
        if sc in ('matched', 'osrm', 'fallback'):
            h, o = scenario_matched()
            if sc == 'osrm': o.update(valhalla='fail')
            if sc == 'fallback': o.update(valhalla='fail', osrm='fail')
            r = run(sc, o, h, res, screenshots=[(f'e2e-rota-{sc}.png', None)] if sc == 'matched' else [])
            check(r, errs)
            print(('FAIL ' if any(e.startswith(f'[{sc}]') for e in errs) else 'PASS ') + sc, json.dumps({k: r[k] for k in ('badge', 'summary', 'nPairs', 'valhalla', 'osrm', 'pins', 'arrows', 'live', 'cacheEntries')}, ensure_ascii=False))
        elif sc == 'live':
            run_live(res)
        elif sc == 'filters':
            h = long_history(); steps = []
            def after(pg, out):
                st = lambda name, js: steps.append((name, pg.evaluate(js)))
                snap = "({pairs:routeView.pairs.length,points:routeView.points.length,stops:routeView.stops.length,minKmh:Math.min(...routeView.pairs.map(p=>p.kmh??1e9)),stoppedPairs:routeView.pairs.filter(p=>p.stopped).length,period:routeFilters.period,mode:routeFilters.mode,follow:routeFilters.follow,pb:+document.getElementById('playbackScrub').max,summary:document.getElementById('routeSummary').textContent,pins:routePins.getLayers().length,raw:trailMarkersLayer.getLayers().length,z:map.getZoom(),c:[+map.getCenter().lat.toFixed(3),+map.getCenter().lng.toFixed(3)]})"
                st('inicial', snap)
                pg.click('#rfMode button[data-mode="move"]'); st('so_movimento', snap)
                pg.click('#rfMode button[data-mode="stop"]'); st('so_paradas', snap)
                pg.click('#rfMode button[data-mode="all"]')
                pg.fill('#rfVmin', '60'); pg.dispatch_event('#rfVmin', 'change'); st('vmin60', snap)
                pg.fill('#rfVmin', ''); pg.dispatch_event('#rfVmin', 'change')
                pg.fill('#rfVmax', '40'); pg.dispatch_event('#rfVmax', 'change'); st('vmax40', snap)
                pg.fill('#rfVmax', ''); pg.dispatch_event('#rfVmax', 'change')
                pg.click('#rfPeriod [data-period="live"]'); st('ao_vivo', snap)
                pg.click('#rfPeriod [data-period="yesterday"]'); st('ontem', snap)
                pg.click('#rfPeriod [data-period="1h"]'); st('1h', snap)
                pg.click('#rfPeriod [data-period="today"]')
                pg.uncheck('#rfGnss'); st('sem_gnss', snap); pg.check('#rfGnss')
                pg.check('#rfRaw'); st('pontos_brutos', snap)
                pg.select_option('#rfColor', 'hour'); st('cor_hora', "routeLines.getLayers().filter(l=>l.options.routeQ).map(l=>l.options.color).filter((c,i,a)=>a.indexOf(c)===i).length")
                pg.select_option('#rfColor', 'battery'); pg.select_option('#rfColor', 'speed')
                pg.select_option('#rfBase', 'dark'); st('mapa_escuro', "document.getElementById('map').classList.contains('route-dark')")
                pg.select_option('#rfBase', 'sat'); st('mapa_sat', "baseLayer._url")
                pg.select_option('#rfBase', 'light')
                pg.click('#rfPeriod [data-period="custom"]'); pg.fill('#rfFrom', '2020-01-01T00:00'); pg.dispatch_event('#rfFrom', 'change'); pg.fill('#rfTo', '2020-01-02T00:00'); pg.dispatch_event('#rfTo', 'change'); st('personalizado_vazio', snap)
                pg.click('#rfPeriod [data-period="today"]'); pg.check('#rfFollow'); pg.wait_for_timeout(400)
                st('seguir', "(()=>{const n=newestPoint(lastTrail);const c=map.getCenter();return {dLat:Math.abs(c.lat-n.lat),dLon:Math.abs(c.lng-n.lon),follow:routeFilters.follow,z:map.getZoom(),sig:routeLastFollowSig,fit:routeFitPending}})()")
                pg.mouse.move(400, 700); pg.mouse.down(); pg.mouse.move(520, 760, steps=5); pg.mouse.up(); pg.wait_for_timeout(300)
                st('arrastar_desliga_seguir', "routeFilters.follow")
                pg.click('#rfMode button[data-mode="move"]'); pg.select_option('#rfBase', 'dark')
                n_before = len(out['valhalla'])
                pg.reload(wait_until='domcontentloaded'); pg.wait_for_timeout(8000)
                steps.append(('persistiu', pg.evaluate("({mode:routeFilters.mode,base:routeFilters.base,active:[...document.querySelectorAll('#rfMode button.active')].map(b=>b.dataset.mode),dark:document.getElementById('map').classList.contains('route-dark')})")))
                steps.append(('cache_sem_rede', (n_before, len(out['valhalla']), pg.evaluate("document.getElementById('routeBadge').textContent"))))
                pg.click('#rfMode button[data-mode="all"]'); pg.select_option('#rfBase', 'light')
                pg.click('#rfPeriod [data-period="all"]')
                pg.click('#rfFit'); st('enquadrar', "(()=>{const b=routeBounds();return map.getBounds().contains(b)})()")
                out['steps'] = dict(steps)
            r = run('filters', dict(street=LONG, after=after, wait=9000), h, res)
            S = r['steps']; E = lambda c, m: None if c else errs.append('[filters] ' + m)
            E(S['inicial']['stops'] == 1 and S['inicial']['pairs'] >= 10, f"inicial {S['inicial']}")
            E(S['so_movimento']['stops'] == 0 and S['so_movimento']['stoppedPairs'] == 0 and S['so_movimento']['mode'] == 'move', f"só movimento {S['so_movimento']}")
            E(S['so_paradas']['pairs'] == 0 and S['so_paradas']['stops'] == 1, f"só paradas {S['so_paradas']}")
            E(0 < S['vmin60']['pairs'] < S['inicial']['pairs'] and S['vmin60']['minKmh'] >= 60, f"vmin {S['vmin60']}")
            E(0 < S['vmax40']['pairs'] < S['inicial']['pairs'], f"vmax {S['vmax40']}")
            E(S['ao_vivo']['period'] == 'live' and S['ao_vivo']['follow'] is True and 1 <= S['ao_vivo']['points'] <= 16, f"ao vivo {S['ao_vivo']}")
            E(S['ontem']['points'] == 0 and 'Nenhum ponto' in S['ontem']['summary'], f"ontem {S['ontem']}")
            E(S['sem_gnss']['points'] == 0, f"sem gnss {S['sem_gnss']}")
            E(S['pontos_brutos']['raw'] >= S['pontos_brutos']['points'] - 3 and S['pontos_brutos']['raw'] > 10, f"brutos {S['pontos_brutos']}")
            E(S['cor_hora'] >= 1 and S['mapa_escuro'] is True and 'World_Imagery' in S['mapa_sat'], f"cor/mapa {S['cor_hora']} {S['mapa_escuro']} {S['mapa_sat']}")
            E(S['personalizado_vazio']['points'] == 0 and S['personalizado_vazio']['period'] == 'custom', f"custom {S['personalizado_vazio']}")
            E(S['seguir']['dLat'] < 0.0005 and S['seguir']['dLon'] < 0.0005, f"seguir {S['seguir']}")
            E(S['arrastar_desliga_seguir'] is False, 'arrastar o mapa deveria desligar "seguir"')
            E(S['persistiu']['mode'] == 'move' and S['persistiu']['base'] == 'dark' and S['persistiu']['dark'], f"persistência {S['persistiu']}")
            E(S['cache_sem_rede'][0] == S['cache_sem_rede'][1], f"2ª visita chamou o Valhalla de novo {S['cache_sem_rede']}")
            E(S['enquadrar'] is True, 'enquadrar rota')
            E(not [c for c in r['console'] if 'PAGEERROR' in c], f"erros de página {r['console']}")
            print(('FAIL ' if any(e.startswith('[filters]') for e in errs) else 'PASS ') + 'filters', json.dumps({k: (v if not isinstance(v, dict) else {a: b for a, b in v.items() if a in ('pairs','points','stops','follow','z','c')}) for k, v in S.items()}, ensure_ascii=False)[:3000])
    for e in errs: print('   ✗', e)
    sys.exit(1 if errs else 0)
