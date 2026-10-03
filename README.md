# Thingy:91X Dashboard

Dashboard rastreador **Nordic Thingy:91X** (Deutsche Telekom style) via **Memfault + nRF Cloud**.

PT-BR abaixo · English short section at the end.

---


## URL pública (GitHub Pages)

**v33:** trilha **ajustada às ruas** + filtros. `route-core.js` (lógica pura, testada em Node) limpa a trilha (jitter < 15 m, acurácia > 150 m, saltos > 250 km/h), divide em segmentos (lacuna > 10 min não une), detecta paradas (> 3 min) e envia lotes de até 80 pontos ao **Valhalla público** (`valhalla1.openstreetmap.de/trace_route`, map_snap, sem chave, CORS liberado) — fallback **OSRM `/route`** por waypoints e, por fim, linha reta tracejada fina. Cache por lote em `localStorage` (`thingy_rm_cache_v1`), 1 chamada a cada ≥ 1,2 s, disjuntor após 3 falhas, Retry-After respeitado. O OSRM `/match` do servidor demo aceita só 10 coordenadas, por isso não é usado. Visual: cor por velocidade/hora/bateria, contorno, setas, trecho recente animado, início/fim, paradas com duração, pontos brutos opcionais, mapa Claro/Escuro/Satélite/OSM (Esri e OSM; os tiles raster da CARTO passaram a exigir chave). Filtros persistidos em `thingy_route_filters_v1` (período, velocidade, só movimento/paradas, fonte, seguir aparelho, enquadrar). Testes: `node tests/route.test.mjs` (em `npm test`), `python3 tests/e2e_route.py [matched|osrm|fallback|filters|live]`.

**v32:** UMA fonte de verdade de presença (`presence-core.js`, usada pelo front, `nrfcloud.js`, `alerts.js` e `proxy.js`). Evidência = o mais recente entre `last_seen` (Memfault), **qualquer mensagem da nuvem** (BATTERY/TEMP/…/GNSS), **location history da nuvem** (GNSS/Wi‑Fi/célula) e `$meta` do shadow. Continua NÃO contando: hora do poll, USB serial do Mac, cache/localStorage. O tooltip do header / "Último dado do aparelho (nuvem)" mostra a fonte. "Posição" usa o ponto mais recente por horário (idade correta). Sem DEVICE/SCELL o app diz "aparelho enviou posição, mas não dados de rede" (sem falso "Aguardando LTE"). Também: fuso America/Sao_Paulo fixo, trilha incremental (1 request por minuto), bateria/ambiente da trilha vindos das mensagens BATTERY/TEMP/HUMID/AIR_PRESS, timeout + 429, SRI no Leaflet, `netlify.toml` bloqueia arquivos locais (serial-telemetry.json etc.) no deploy. Testes: `npm test` e `npm run test:e2e`.

**v31:** presença só com evidência da nuvem (last_seen / mensagens / shadow $meta) — hora do poll, USB serial local, trilha e cache não contam mais como "online"; `connected=true` velho (>1h) não sobrepõe silêncio; strip "Último dado do aparelho (nuvem)" + "Fonte da rede" (nuvem vs USB do Mac).

**v30:** mapa explica por que está vazio (401 = falta API Key da equipe / nenhum fix na nuvem); trilha busca os pontos mais recentes primeiro; Netlify lê `NRF_TEAM_READ_TOKEN` (ou `NRF_TEAM_WRITE_TOKEN`) para mensagens/localização quando o navegador não envia `X-Nrf-Team-Key` (`/health` → `readTokenConfigured`).

**v27:** playback da trilha, sparklines, `NRF_TEAM_WRITE_TOKEN` no Netlify, API `/alerts`. Detalhes em `docs/v27-playback-sparklines-infra.md`.

Dashboard estático em:

**https://guilhermeromio-netto-prog.github.io/thingy91x-dashboard/**

- **Nuvem (Memfault / nRF Cloud):** funciona no github.io — configure a API key na engrenagem ⚙️. As chamadas vão para a function Netlify (`thingy91x-x-dashboard.netlify.app`).
- **Serial / USB / cell·Wi‑Fi resolve local:** só via localhost (`Thingy91X-Dashboard.command` / `npm run serve`). No Pages o bridge UART não existe (404 silencioso).


## Rodar local (macOS)

### Opção A — launcher (recomendado)

1. Duplo-clique em `Thingy91X-Dashboard.command` (cópia no Desktop ou nesta pasta).
2. Deixe o Terminal aberto. Abra **http://localhost:3001/?v=32**
3. O launcher sobe `serial_telemetry.py` + `node proxy.js` (porta **3001**).

### Opção B — manual

```bash
cd ~/Documents/Default\ Project/thingy91x-dashboard
npm install
python3 serial_telemetry.py &   # opcional: UART → serial-telemetry.json
npm run serve                   # proxy estático + /api em :3001
```

Health: `http://localhost:3001/health`

---

## Configurar (engrenagem ⚙️)

| Campo | Uso |
|-------|-----|
| **E-mail** | Login Memfault / nRF Cloud (para User API Key → Basic) |
| **User API Key / OAT** | User API Key do perfil **ou** Organization Auth Token (Bearer) |
| **API Key da equipe (Simple Token)** | Opcional mas **necessário** para ListMessages, GPS cloud, **shadow PATCH** e c2d |
| **Organization / Project** | Padrão `telekom` / `nrf-project` |
| **Device ID** | UUID / CoAP client ID do Thingy |

Auth headers:
- Memfault: `Authorization: Basic email:user_api_key` ou `Bearer <OAT>`
- nRF writes/msgs: `X-Nrf-Team-Key: <Simple Token>` → `Bearer` em `api.nrfcloud.com`

Docs: [tokens & keys](https://docs.memfault.com/docs/legacy-nrfcloud/tokens-and-keys) · [UpdateDeviceState](https://api.nrfcloud.com/#tag/IP-Devices/operation/UpdateDeviceState)

---

## O que funciona

| Feature | Fonte | Auth |
|---------|-------|------|
| Frota / device + Memfault identity | `api.memfault.com` | User API Key / OAT |
| Telemetria serial (temp, hum, press hPa, bat, RSRP) | `serial_telemetry.py` → JSON | local |
| Posição via SCELL (cell resolve) | nRF Location Services | OAT / User key |
| Shadow desired (LED / intervalo / JSON → `config`) | `PATCH /v1/devices/{id}/state` | **Simple Token** (write) |
| Ping c2d | `POST /v1/devices/{id}/messages` | **Simple Token** |
| PWA cache | `service-worker.js` → `thingy91x-v32` | — |

UI mapeia `gpsInterval` → `desired.config.sample_interval` (Asset Tracker Template / ATT). JSON custom é mergeado.

---

## Limitações (honestas)

- **ListMessages / trilha GNSS cloud / FetchDevice state completo** sem Simple Token (na engrenagem **ou** `NRF_TEAM_READ_TOKEN` no Netlify) → **401**. Serial + SCELL (só no Mac) cobrem telemetria/posição.
- **Mensagens do Asset Tracker Template 1.5 (CoAP):** o firmware publica `BATTERY` (% número), `TEMP` (°C), `HUMID` (%), `AIR_PRESS` (kPa) e posição (GNSS PVT / ground-fix via location history). `DEVICE`/`SCELL`/`RSRP` **não** são publicados por padrão — rede vem do shadow `networkInfo` (`CONFIG_NRF_CLOUD_SEND_DEVICE_STATUS_NETWORK`), se o firmware enviar.
- **FOTA legado** ainda **501** neste proxy.
- Sem Simple Token, **Enviar desired** / **Ping** devolvem JSON claro `401/403` (não 501 silencioso) pedindo a team key.
- Não afirmamos GNSS/ListMessages “ok” sem team key.

---

## Arquivos principais

```
index.html, styles.css, app.js, icon.svg, manifest.json
service-worker.js          # cache thingy91x-v33
presence-core.js           # presença única (front + functions + proxy)
route-core.js              # trilha: limpeza, paradas, map matching (Valhalla/OSRM), filtros
tests/                     # presence/route/functions .test.mjs, route.live.mjs (manual), e2e_presence.py, e2e_route.py (playwright)
proxy.js                   # :3001 static + /api
serial_telemetry.py        # UART bridge
Thingy91X-Dashboard.command
thingy.sh                  # CLI helpers
netlify/functions/nrfcloud.js
```

---

## English (short)

Local: run `Thingy91X-Dashboard.command` or `npm run serve` on port **3001**, open `/?v=32`.  
Auth: Memfault User API Key/OAT for fleet; optional **team Simple Token** (`X-Nrf-Team-Key`) for cloud messages, shadow **PATCH**, and c2d.  
ATT-friendly desired wraps flat `gpsInterval`/`led`/`buzzer` into `desired.config`.  
Without Simple Token, writes return explicit 401/403 JSON — GNSS/ListMessages are **not** claimed to work.
