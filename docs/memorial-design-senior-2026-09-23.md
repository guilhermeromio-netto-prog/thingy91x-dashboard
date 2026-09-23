# Memorial de design sênior — Thingy:91X Dashboard

**Data:** 2026-09-23 · **Autor da avaliação:** (usuário / design review) · **Repo:** thingy91x-dashboard

Documento condensado PT-BR das secções 1–11 da avaliação sênior + backlog P0–P3.
Aceite operacional de P0: `docs/memorial-P0-aceite.md`.

---

## 1. Contexto e objetivo
Dashboard web para Asset Tracker (Thingy:91X / nRF Cloud + Memfault + overlay serial USB).
Público: operação IoT (Telekom), acompanhamento de frota, posição, vitais e cerca.

## 2. O que funciona bem
- Poll multi-fonte (shadow, messages, location history, serial)
- Trilha com snapshots e popup por ponto
- Proxy dual Memfault/nRF + GitHub Pages
- Geofence básico (círculo Leaflet + haversine)

## 3. Problemas de honestidade de UI (críticos)
- Cards críticos com `—` sem explicação (Rede, Movimento)
- Bateria misturando SoC% com rótulo “V”
- Nome do device = UUID/técnico; falta **nome operacional**
- Geofence muitas vezes fica `—` mesmo com cerca + fix
- Idade do dado invisível → operador não sabe se o valor é fresco

## 4. Modelo mental do operador
1. Qual asset? (nome)  2. Está vivo?  3. Onde?  4. Bateria/rede OK?
5. Entrou/saiu da cerca?  6. O dado é de agora?

## 5. Princípios
- Empty state honesto > dash mudo
- Unidade correta ou “n/d” — nunca mentir a unidade
- Alias humano + UUID técnico copiável
- Idade do dado em todo vital P0
- Geofence binário DENTRO/FORA sempre que houver geo+posição

## 6. P0 — Correções imediatas (esta entrega, v19)
1. Nome operacional + UUID copiável  
2. Empty states Rede / Movimento  
3. Idade do dado (Ambiente, Bateria, Posição, Rede)  
4. Geofence real (DENTRO/FORA / aguardando / sem cerca)  
5. Bateria SoC% vs volts  
6. Situação one-liner + bump `?v=19` / SW `thingy91x-v19`

## 7. P1 — Motor de alertas / situação
- Regras: offline, bateria baixa, fora da cerca, dado atrasado
- Banner / histórico de eventos
- Notificações já parcialmente usadas no geofence

## 8. P2 — Rede & movimento ricos
- Timeline de handovers / bandas
- Motion real se firmware publicar ACCEL/STEPS
- Distinguir Wi‑Fi scan vs rádio celular no card

## 9. P3 — Frota & ops
- Alias/tags por frota, filtros, export enriquecido
- FOTA UX, comandos com feedback de ACK
- Multi-mapa / clustering

## 10. Riscos
- Cache Safari / SW → sempre bump `?v=` + CACHE name
- Simple Token ausente → msgs/trilha 401 (já logado)
- ATT sem motion → empty state esperado, não bug

## 11. Critério de pronto P0
Ver checklist em `memorial-P0-aceite.md`. `node --check app.js` + push `main` Pages.

---

## Backlog resumido
| Prioridade | Tema |
|---|---|
| **P0** | Alias, empty states, data-age, geofence UI, bateria unidade, situação stub, v19 |
| **P1** | Alert engine / situação completa |
| **P2** | Rede/movimento aprofundados |
| **P3** | Frota ops / FOTA / clustering |
