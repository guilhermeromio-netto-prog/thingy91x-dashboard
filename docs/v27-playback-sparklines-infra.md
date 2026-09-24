# v27 — Playback + sparklines + infra (write token + alertas)

**Data:** 2026-09-24 · **UI:** `?v=27` · **SW:** `thingy91x-v27`

## O que entrou

### A) Playback da trilha
- Barra sob o mapa: ▶/⏸, velocidade **1× / 5×**, scrubber.
- Marcador **fantasma** (roxo) percorre só pontos reais de `lastTrail` (nuvem + local).
- Chip com horário + bateria/RSRP do ponto (quando existir no snapshot).
- Marcador live permanece distinto. Trilha vazia → “Sem pontos na trilha” (sem inventar coords).

### B) Sparklines
- SVG inline (sem lib) para **bateria %** e **RSRP** a partir da trilha.
- Locais: Situação, card Bateria, item RSRP.
- &lt; 3 amostras com valor → “histórico insuficiente”.

### C) Token de escrita no Netlify
Function `nrfcloud`:
- Em `nrf-state` / `nrf-c2d` (writes), preferir `process.env.NRF_TEAM_WRITE_TOKEN` (Bearer).
- Fallback: header cliente `X-Nrf-Team-Key` (localhost / engrenagem).
- `GET /.netlify/functions/nrfcloud/health` → `{ writeTokenConfigured: true|false }` (**nunca** o segredo).
- `proxy.js` local: mesma env `NRF_TEAM_WRITE_TOKEN` + `/health.writeTokenConfigured`.

**Como configurar (Guilherme):**
1. Netlify → site `thingy91x-x-dashboard` → **Site configuration → Environment variables**.
2. Add variable: **`NRF_TEAM_WRITE_TOKEN`** = Simple Token da equipe (escopo escrita shadow/c2d).
3. Trigger deploy (ou redeploy).
4. Teste: `https://thingy91x-x-dashboard.netlify.app/.netlify/functions/nrfcloud/health` → `writeTokenConfigured: true`.
5. No github.io **sem** Simple Token na engrenagem: enviar Desired/Ping; se 401, ainda cole a chave (fallback).

> Nunca commit o token. Só Netlify env / `.env` local (gitignored).

### D) Worker / API de alertas
- `GET /.netlify/functions/alerts?deviceId=UUID` — avaliação on-demand.
- Regras (honestas, documentadas): offline longo, bateria baixa/crítica, RSRP fraco, dados stale.
- **Geofence não** no worker (só no cliente — sem store server-side nesta geração).
- Auth: mesmos headers do dashboard **ou** env de schedule (`MEMFAULT_OAT` / `MEMFAULT_USER_API_KEY` + `MEMFAULT_EMAIL` opcional, `NRF_TEAM_WRITE_TOKEN` ou `NRF_TEAM_READ_TOKEN`, `ALERT_DEFAULT_DEVICE_ID`).
- Schedule opcional: function `alerts-schedule` em `netlify.toml` (`*/15 * * * *`) — precisa plano/schedule habilitado; sem isso o on-demand basta.
- Front (Pages/Netlify): faz merge dos alertas server com os client na faixa Alertas; localhost permanece só client.

Redirect: `/api/alerts` → `/.netlify/functions/alerts`.

## Variáveis de ambiente (Netlify)

| Nome | Obrigatório | Uso |
|------|-------------|-----|
| `NRF_TEAM_WRITE_TOKEN` | p/ escrita remota sem chave no browser | shadow PATCH + c2d |
| `NRF_TEAM_READ_TOKEN` | opcional | leitura nRF no worker se write token não servir p/ GET |
| `MEMFAULT_OAT` ou `MEMFAULT_USER_API_KEY` | p/ schedule | auth Memfault no cron |
| `MEMFAULT_EMAIL` | se User API Key | Basic email:key |
| `MEMFAULT_ORG` / `MEMFAULT_PROJECT` | opcional | default `telekom` / `nrf-project` |
| `ALERT_DEFAULT_DEVICE_ID` | p/ schedule | device aquecido pelo cron |
| `ALERT_OFFLINE_MS` etc. | opcional | thresholds do worker |

## Teste rápido (PT-BR)

1. Abrir `https://guilhermeromio-netto-prog.github.io/thingy91x-dashboard/?v=27` (hard refresh / limpar SW se UI antiga).
2. Com trilha carregada: scrubber move o fantasma; ▶ em 5× percorre pontos; chip mostra hora/bat/RSRP se houver.
3. Sparklines: se ≥3 amostras de bat/RSRP na trilha, linhas SVG; senão “histórico insuficiente”.
4. Health write token: URL Netlify `/nrfcloud/health` → `writeTokenConfigured`.
5. Desired sem Simple Token no celular (com env set): deve passar; 401 → mensagem aponta Netlify env ou engrenagem.
6. Alertas: faixa Alertas pode misturar regras locais + `/.netlify/functions/alerts?deviceId=…`.

## Localhost

```bash
# opcional, paridade com Netlify:
export NRF_TEAM_WRITE_TOKEN='…'   # nunca commit
npm run serve
# http://localhost:3001/?v=27
# /health → writeTokenConfigured
```

## v28 note (2026-09-24)

GitHub Pages was on v27 while **Netlify stayed on ~v11** (no auto-deploy). Symptom: Pages UI new, but `/.netlify/functions/nrfcloud/health` → Unmapped, `alerts` → 404. Fix: Trigger Deploy on Netlify for `main`, then verify health returns `{ok:true}`.
