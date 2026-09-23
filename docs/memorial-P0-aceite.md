# P0 — Checklist de aceite (Thingy:91X Dashboard)

Data: 2026-09-23 · Versão UI: `?v=19` / SW `thingy91x-v19`

## Itens P0

### 1. Nome operacional + UUID copiável
- [ ] Headline do hero mostra **nome operacional** editável (contenteditable)
- [ ] Persistido em `localStorage` chave `thingy_device_alias_${deviceId}`
- [ ] Default: `Asset Tracker` (ou nickname Memfault/cloud se disponível)
- [ ] UUID secundário em monoespaçado com botão **Copiar**
- [ ] Alias aparece no card da frota

### 2. Empty states honestos
- [ ] **Rede:** online sem campos celulares + posição Wi‑Fi → nota “Rádio celular não telemetrado…”
- [ ] **Rede:** offline / sem networkInfo → “Sem dados de rede — dispositivo offline ou sem shadow…”
- [ ] **Rede:** nunca só `—` silenciosos em OPERADORA…CELL ID (`#netEmptyHint`)
- [ ] **Movimento:** sem accel/passos → “Acelerômetro/passos não publicados…” (`#motionEmptyHint`)
- [ ] Se houver velocidade GNSS, mostra proxy “Deslocamento via GNSS: X km/h”

### 3. Idade do dado nos vitais
- [ ] Ambiente, Bateria, Posição e Rede mostram `há Xs` / `há N min` (classe `.data-age`)
- [ ] `> 5 min` marca `.atrasado`
- [ ] Sem timestamp: texto explicativo (não só `—` mudo)

### 4. Geofence real
- [ ] Cerca desenhada no mapa quando definida
- [ ] Com geo + posição: `geoState` = `DENTRO`/`FORA` + distância (nunca `—`)
- [ ] Com geo sem posição: “Cerca ativa — aguardando fix.”
- [ ] Sem geo: “Sem cerca definida.”

### 5. Bateria — unidade
- [ ] `batteryValue` = SoC % apenas quando o campo é percent (0–100)
- [ ] `batteryVoltage` = volts apenas quando o valor parece tensão (≈3–5 V / mV→V)
- [ ] Nunca rotular percent como `V` (ex.: “100%” + “100.00 V”)
- [ ] Idade do dado de bateria presente

### 6. Polish P0
- [ ] Linha “Situação” sob o header: `{alias} · ONLINE/OFFLINE · bateria N% · trilha N pts`
- [ ] `node --check app.js` OK
- [ ] Commit + push `main` · GitHub Pages com `?v=19`

## Notas
- Memorial completo (secções 1–11 / backlog P0–P3): ver `docs/memorial-design-senior-2026-09-23.md` se o parent o gravar.
- Este ficheiro é o **aceite P0** mínimo para merge.
