"""Headless Chrome (playwright) — Painel NTN Pro (/ntn/, v36) com dados simulados Cat-M + NTN.
Uso: python3 tests/e2e_ntn_pro.py     Screenshots em /workspace/thingy-debug/ntn-pro-*.png
Intercepta /.netlify/functions/ntn-lab (sem tokens) e serve os arquivos locais; mapas/Leaflet vêm da internet."""
import json, os, sys, math, mimetypes, datetime as dt
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = 'https://guilhermeromio-netto-prog.github.io/thingy91x-dashboard/'
OUT = '/workspace/thingy-debug'; os.makedirs(OUT, exist_ok=True)
now = dt.datetime.now(dt.timezone.utc)
iso = lambda d: d.isoformat().replace('+00:00', 'Z')

def sim():
    R = []; seq = 0
    route = [(-23.5452 + 0.0011 * i, -46.7811 + 0.0016 * i + 0.0004 * math.sin(i / 2)) for i in range(40)]
    def add(i, mins, typ, net, **k):
        nonlocal seq; seq += 1
        la, lo = route[min(i, len(route) - 1)]
        t = now - dt.timedelta(minutes=mins)
        r = dict(type=typ, seq=seq, ts=iso(t - dt.timedelta(seconds=k.get('late', 0))), rx=iso(t), net=net, lat=round(la, 3), lon=round(lo, 3), late=0, bytes=None)
        r.update(k); R.append(r)
    add(0, 80, 'event', 'catm', event='boot', value=20, info='mfw_nrf9151-ntn_1.0.1')
    add(0, 79.9, 'event', 'catm', event='reg', value=3, info='Cat-M')
    for i in range(1, 16): add(i, 80 - i, 'telemetry', 'catm', plmn='72410', act=7, band='3', rsrp=-88 - i % 5, snr=8, ce=0, mv=5180, temp=38, bytes=196, prevRttMs=700 + 40 * (i % 4), posSrc='gnss', counters=dict(tries=i, ok=i, fail=0, switches=0))
    seq += 1  # mensagem perdida
    add(16, 63, 'event', 'catm', event='sw', value=1, info='botao1')
    add(16, 61, 'event', 'catm', event='fix', value=104, info='gnss')
    add(16, 49, 'event', 'ntn', event='reg', value=728, info='NTN', posSrc='injetada')
    for j, m in enumerate([48, 43, 38, 33]): add(16, m, 'telemetry', 'ntn', plmn='90198', act=14, band='', rsrp=-131 - j, snr=-3, ce=2, mv=5170, temp=40, bytes=198, prevRttMs=21000 + 900 * j, posSrc='injetada', late=150 if j == 2 else 0, counters=dict(tries=16 + j, ok=15 + j, fail=1, switches=1))
    add(16, 30, 'event', 'ntn', event='sw', value=0, info='botao1', posSrc='injetada')
    add(17, 29.9, 'event', 'catm', event='reg', value=3, info='Cat-M')
    for i in range(18, 40): add(i, 29.8 - (i - 18) * 1.3, 'telemetry', 'catm', plmn='72410', act=7, band='3', rsrp=-86 - i % 6, snr=9, ce=0, mv=5190, temp=39, bytes=196, prevRttMs=650 + 30 * (i % 5) if i > 18 else 24000, posSrc='gnss', late=95 if i == 18 else 0, counters=dict(tries=20 + i, ok=19 + i, fail=1, switches=2))
    return R

def main():
    recs = sim(); out = {}; errs = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = b.new_page(viewport={'width': 1440, 'height': 1000})
        pg.on('pageerror', lambda e: errs.append(str(e)))
        def api(route):
            u = route.request.url
            body = {"ok": True, "schema": "ntn-pro/1", "records": recs} if 'pro=1' in u else {"ok": True, "data": None, "pings": []}
            route.fulfill(status=200, content_type='application/json', body=json.dumps(body), headers={'access-control-allow-origin': '*'})
        pg.route('**/.netlify/functions/**', api)
        def local(route):
            path = route.request.url.split('/thingy91x-dashboard/')[-1].split('?')[0].split('#')[0] or 'index.html'
            if path.endswith('/'): path += 'index.html'
            fp = os.path.join(ROOT, path)
            if not os.path.isfile(fp): return route.fulfill(status=404, body='')
            route.fulfill(status=200, body=open(fp, 'rb').read(), content_type=mimetypes.guess_type(fp)[0] or 'application/octet-stream')
        pg.route(PAGES + '**', local)
        pg.add_init_script("localStorage.clear()")
        pg.goto(PAGES + 'ntn/', wait_until='domcontentloaded', timeout=60000)
        pg.wait_for_timeout(6000)
        g = lambda i: pg.evaluate(f"document.getElementById('{i}')?.textContent?.trim()")
        out['live'] = {k: g(k) for k in ['lvNet', 'lvSince', 'lvSig', 'lvAge', 'swCount', 'msgCount']}
        out['kpis'] = pg.evaluate("[...document.querySelectorAll('.kpi')].map(k=>k.innerText.replace(/\\n/g,' | '))")
        out['markers'] = pg.evaluate("document.querySelectorAll('.leaflet-interactive').length")
        pg.screenshot(path=f'{OUT}/ntn-pro-live.png', full_page=True)
        assert 'Cat-M' in out['live']['lvNet'], out
        assert out['live']['swCount'].startswith('2'), out
        assert out['markers'] > 30, out
        # filtro: só satélite
        pg.click('#fNet button[data-net="ntn"]'); pg.wait_for_timeout(800)
        out['ntnRows'] = pg.evaluate("document.querySelectorAll('#msgBody tr').length")
        assert out['ntnRows'] == 6, out['ntnRows']
        # popup de um ponto atrasado
        pg.click('#fNet button[data-net="all"]'); pg.wait_for_timeout(500)
        # replay
        pg.click('#srcSeg button[data-src="replay"]'); pg.wait_for_timeout(2500)
        out['replay'] = {k: g(k) for k in ['replayTitle', 'lvNet', 'swCount']}
        out['replayKpis'] = pg.evaluate("[...document.querySelectorAll('.kpi')].map(k=>k.innerText.replace(/\\n/g,' | '))")
        assert not pg.evaluate("document.getElementById('replayBanner').hidden")
        assert '12 min 28 s' in ' '.join(out['replayKpis']), out['replayKpis']
        pg.screenshot(path=f'{OUT}/ntn-pro-replay.png', full_page=True)
        pg.click('#srcSeg button[data-src="live"]'); pg.wait_for_timeout(800)
        pg.evaluate("document.body.classList.add('present')"); pg.wait_for_timeout(800)
        pg.screenshot(path=f'{OUT}/ntn-pro-present.png')
        pg.set_viewport_size({'width': 820, 'height': 1180}); pg.evaluate("document.body.classList.remove('present')"); pg.wait_for_timeout(800)
        pg.screenshot(path=f'{OUT}/ntn-pro-tablet.png', full_page=True)
        b.close()
    out['pageErrors'] = errs
    print(json.dumps(out, ensure_ascii=False, indent=1))
    assert not errs, errs
    print('E2E NTN Pro OK')

if __name__ == '__main__':
    main()
