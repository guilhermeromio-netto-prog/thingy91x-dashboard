# Inteligência remota — v25

Camada “inteligente” no dashboard (PT-BR) que responde em um olhar:
**online? onde? risco? ação?** — sem firmware novo e **sem USB obrigatório** no github.io.

## O que roda remoto (github.io / Netlify)

Tudo abaixo usa só dados já disponíveis via poll da nuvem (shadow, ListMessages, location history) + snapshots locais no `localStorage` do navegador:

| Bloco | Fonte | Comportamento |
|---|---|---|
| **Faixa Situação** | `connected`, auth, lastSeen, fix, geofence, alertas | Estado / Onde / Risco / Ação |
| **Alertas** | poll + trilha + bateria + idades + geofence | Lista curta (máx. 5); “Nenhum alerta” se vazio |
| **Autonomia de bateria** | pontos da trilha com `%` ao longo do tempo | `%/h` e `~Xh restantes` só com amostras reais |
| **Resumo da trilha** | pontos filtrados “hoje” | km + duração + em movimento/parado + paradas |

Constantes (editáveis em `INTEL` no `app.js`): offline ~20 min, dado velho ~30 min, bateria baixa &lt;20% / crítica &lt;10%, RSRP fraco &lt; −110 dBm, mínimo de amostras/intervalo para autonomia.

### Regras de honestidade
- **Nunca inventa** autonomia: exige ≥4 amostras e ≥2 h de intervalo com queda de SoC (ignora trechos em carga).
- Alertas só a partir de dados reais; sem chave API → Estado “Sem chave” + alerta correspondente.
- Geofence DENTRO/FORA só aparece com cerca definida **e** fix válido.

## O que ainda é USB-only (Mac / proxy local)

- Overlay **serial USB** (Rede celular rica quando a nuvem não publica `networkInfo` — típico ATT 1.5).
- Bridge `serial_telemetry.py` / poll mais rápido em localhost.

No github.io o dashboard continua útil: Situação, Alertas, mapa/trilha e autonomia usam a nuvem.

## Fora de escopo (v25) — sem flash agora

- **Bluetooth / BLE pairing** com o Thingy
- **OBD de carro** / telemetria veicular
- Novo firmware Asset Tracker

Esses itens pedem trabalho futuro de FW/app; esta entrega não grava nem pede flash.

## Como testar

1. **Remoto:** abrir `https://guilhermeromio-netto-prog.github.io/thingy91x-dashboard/?v=25` com a chave já salva (ou engrenagem).
2. Conferir faixa Situação (Estado/Onde/Risco/Ação) e lista Alertas.
3. Card Bateria → linha “Autonomia estimada”.
4. Controles da trilha → chip “Resumo da trilha”.
5. **Localhost:** `npm start` no Mac (proxy) e abrir a mesma UI; serial preenche Rede se o USB estiver ligado — Situação continua igual.

Cache: SW `thingy91x-v25` + `?v=25`. Se a UI não mudar, hard-refresh ou limpar SW do site.
