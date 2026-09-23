# Thingy:91X Dashboard

Dashboard rastreador **Nordic Thingy:91X** (Deutsche Telekom style) via **Memfault + nRF Cloud**.

PT-BR abaixo · English short section at the end.

---


## URL pública (GitHub Pages)

Dashboard estático em:

**https://guilhermeromio-netto-prog.github.io/thingy91x-dashboard/**

- **Nuvem (Memfault / nRF Cloud):** funciona no github.io — configure a API key na engrenagem ⚙️. As chamadas vão para a function Netlify (`thingy91x-x-dashboard.netlify.app`).
- **Serial / USB / cell·Wi‑Fi resolve local:** só via localhost (`Thingy91X-Dashboard.command` / `npm run serve`). No Pages o bridge UART não existe (404 silencioso).


## Rodar local (macOS)

### Opção A — launcher (recomendado)

1. Duplo-clique em `Thingy91X-Dashboard.command` (cópia no Desktop ou nesta pasta).
2. Deixe o Terminal aberto. Abra **http://localhost:3001/?v=15**
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
| PWA cache | `service-worker.js` → `thingy91x-v15` | — |

UI mapeia `gpsInterval` → `desired.config.sample_interval` (Asset Tracker Template / ATT). JSON custom é mergeado.

---

## Limitações (honestas)

- **ListMessages / trilha GNSS cloud / FetchDevice state completo** sem Simple Token → costuma **401**. Serial + SCELL cobrem telemetria/posição offline-friendly.
- **FOTA legado** ainda **501** neste proxy.
- Sem Simple Token, **Enviar desired** / **Ping** devolvem JSON claro `401/403` (não 501 silencioso) pedindo a team key.
- Não afirmamos GNSS/ListMessages “ok” sem team key.

---

## Arquivos principais

```
index.html, styles.css, app.js, icon.svg, manifest.json
service-worker.js          # cache thingy91x-v15
proxy.js                   # :3001 static + /api
serial_telemetry.py        # UART bridge
Thingy91X-Dashboard.command
thingy.sh                  # CLI helpers
netlify/functions/nrfcloud.js
```

---

## English (short)

Local: run `Thingy91X-Dashboard.command` or `npm run serve` on port **3001**, open `/?v=15`.  
Auth: Memfault User API Key/OAT for fleet; optional **team Simple Token** (`X-Nrf-Team-Key`) for cloud messages, shadow **PATCH**, and c2d.  
ATT-friendly desired wraps flat `gpsInterval`/`led`/`buzzer` into `desired.config`.  
Without Simple Token, writes return explicit 401/403 JSON — GNSS/ListMessages are **not** claimed to work.
