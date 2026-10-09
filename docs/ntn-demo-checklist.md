# Checklist — demonstração nRF9151 NTN Pro para a Skylo

Painel: https://guilhermeromio-netto-prog.github.io/thingy91x-dashboard/ntn/?v=36
(replay direto: `?replay=1` · modo apresentação: `?present=1` ou botão **⛶ Apresentação**)

## 1. Preparação (D-2 a D-0)
- [ ] **Teste NTN a céu aberto ANTES do dia** (obrigatório): `python3 stress.py --sends 5 --restarts 1 --ntn-cycles 2` no local da reunião ou num local equivalente. Meta: registrar em até 15 min.
- [ ] **Local:** céu aberto, sem telhado/marquise/árvore, vista livre para o **norte**, baixo no horizonte (satélite geoestacionário). Vidro bloqueia.
- [ ] **Antenas:** LTE/NTN bem rosqueada no conector certo; antena GNSS conectada. Levar antena reserva.
- [ ] **Energia:** notebook 100 % + carregador; DK pelo USB do Mac (5,2 V ok). Powerbank e cabo USB reserva.
- [ ] **Notebook:** `serial_logger` e `uploader` rodando (`launchctl list | grep ntnlab`); painel aberto e com Cmd+Shift+R; replay testado.
- [ ] **Internet do notebook:** hotspot do celular (o painel e a nuvem precisam de internet; a placa usa o próprio SIM).
- [ ] **SIM:** Telekom Global com perfil NTN ativo (ICCID …5275). Confirmar com a DT/Skylo que o perfil continua habilitado.
- [ ] **Posição salva:** fazer um fix GNSS no local antes (botão 1 já faz; o app guarda a última posição para injetar no NTN).
- [ ] **Plano B pronto:** aba com `?replay=1` aberta.

## 2. Roteiro da demo (~20 min)
| Min | O que fazer | O que mostrar |
|---|---|---|
| 0–2 | Abrir o painel em **Apresentação**. | Status ao vivo: Cat-M, sinal, última mensagem na nuvem. |
| 2–4 | Explicar a arquitetura: nRF9151 + mfw NTN 1.0.1 + SIM DT, mesma placa em LTE-M e NB-IoT NTN. | Mapa com a trilha colorida por rede; KPIs. |
| 4–5 | Apertar **Botão 1** (Cat-M → satélite). | LED3 = GNSS; depois LED2 piscando rápido (buscando). Linha do tempo: "Cat-M → Satélite". |
| 5–8 | Enquanto busca, mostrar o **Replay** da sessão real de 09/10 (registro em 12 min 28 s, ping ~23 s). | Rótulo REPLAY; comutação; KPIs por rede. |
| 8–15 | Voltar ao **Ao vivo**. Ao registrar (LED2 piscando devagar): apertar **Botão 3**. | Ponto roxo no mapa, latência satélite, bytes ≤ 256 B. |
| 15–17 | Apertar **Botão 1** (volta ao Cat-M). Mostrar mensagens **atrasadas** (fila store-and-forward). | Tempo até registrar Cat-M (~3 s). |
| 17–20 | Exportar relatório (CSV/imprimível); discutir roadmap. | Relatório. |
Opcional: **modo automático** (Botão 4) ou **demo de comutação** (`python3 app_cmd.py 5`: 3 ciclos Cat-M 120 s → NTN 120 s, espera máx. 15 min por registro).

## 3. Plano B
- Satélite não registra em 15 min → mostrar o **Replay** (dados reais de 09/10) + o envio do dia anterior a céu aberto (exportado).
- Sem internet no notebook → hotspot; sem nada → relatório impresso/CSV exportado antes.
- Placa travada → `nrfutil device reset --serial-number 1052080474` (≈10 s, volta em Cat-M com telemetria).
- Firmware com problema → rollback (abaixo) para o v1.0 dos botões.

## 4. Riscos e mitigações
| Risco | Mitigação |
|---|---|
| Céu obstruído / sala fechada | Teste prévio no local; janela/varanda com vista norte; replay. |
| Registro NTN demorado (até 15 min) | Ligar o NTN no começo da reunião; explicar enquanto busca. |
| HTTPS pelo satélite (TLS pesado) | Conexão reaproveitada + cache de sessão TLS + 1 retry; fila guarda e reenvia. Roadmap: UDP/CoAP+DTLS-CID. |
| Primeiro envio após conectar dá timeout | Retry automático em Cat-M (já observado e tratado). |
| Limites Skylo (≤256 B, ≥30 s, evitar attach/detach) | Payload ~120–200 B; app impõe ≥30 s em NTN; telemetria NTN a cada 300 s. |
| Bateria / energia | USB do notebook; powerbank. |
| Dados públicos | Posição pública arredondada (~100 m), ICCID/IMSI mascarados; token só na placa e no Netlify. |

## 5. Roadmap para virar produto
- **Hardware:** placa própria com nRF9151 (ou módulo), antena combinada LTE/NTN+GNSS com ganho adequado para GEO, caixa IP67, bateria + gestão de energia, sensores do caso de uso.
- **Certificação:** Anatel (e CE/FCC se exportar), certificação/homologação de dispositivo na Skylo e nas operadoras (DT/roaming Vivo/Claro), PTCRB/GCF conforme mercado.
- **Custo de dados:** plano NTN por mensagem/byte; hoje ~120–200 B de payload + overhead HTTP/TLS (centenas de bytes a alguns KB por mensagem). Migrar para CoAP/UDP binário (CBOR) para ficar em dezenas de bytes.
- **Transporte/backend:** coletor UDP/CoAP com DTLS Connection ID (ou nRF Cloud CoAP), banco temporal, multi-dispositivo, alertas, API para clientes; Netlify Blobs é só para piloto.
- **Segurança:** credencial única por dispositivo (certificado no modem, não token compartilhado), rotação, TLS/DTLS ponta a ponta, logs sem PII, LGPD.
- **OTA:** FOTA do app (MCUboot) e do modem pelo Cat-M (nunca pelo satélite), com rollback.
- **Operação:** monitor de frota, KPIs por rede, fallback automático com histerese (já no app v2.0), testes de campo e de longa duração.
