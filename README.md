# Thingy:91X Dashboard

Dashboard standalone (HTML/CSS/JS) para visualizar dados do **Nordic Thingy:91X** via **nRF Cloud API**.

## Como usar

1. **Extraia o ZIP** em qualquer pasta
2. **Abra `index.html`** no navegador (duplo-clique funciona)
3. **Configure sua API Key** do nRF Cloud:
   - Acesse [nrfcloud.com](https://nrfcloud.com) → Settings → API Keys
   - Crie uma key com permissão `device:read`
   - Cole no modal que aparece

## Requisitos do dispositivo

- Thingy:91X com firmware **nRF Asset Tracker v2**
- Dispositivo registrado e online no nRF Cloud
- Enviando dados (GPS, sensores, bateria, rede)

## Dados exibidos

| Seção | Dados |
|-------|-------|
| 📱 Dispositivo | ID, nome, firmware, último visto |
| 📍 GPS | Lat/Lon, precisão, satélites, altitude, velocidade |
| 🌡️ Ambiente | Temperatura, umidade, pressão |
| 🏃 Movimento | Acelerômetro (X/Y/Z), passos |
| 🔋 Bateria | Nível (barra visual), voltagem, carregando |
| 📶 Rede | RSRP, RSRQ, operadora |
| 🗺️ Mapa | Localização atual + trilha 24h (OpenStreetMap) |

## Atualização

- Polling automático a cada **10 segundos**
- Botão "Centralizar" foca no dispositivo
- Botão "Trilha" liga/desliga histórico de 24h

## Arquivos

```
thingy91x-dashboard/
├── index.html   # Estrutura
├── styles.css   # Visual (responsivo, mobile-first)
└── app.js       # Lógica nRF Cloud API + Leaflet map
```

## Sem backend necessário

- Roda 100% no navegador
- Consome direto da API `api.nrfcloud.com/v1`
- Mapas via OpenStreetMap (sem chave AWS)

## Segurança

- API Key salva no `localStorage` do navegador
- Nunca enviada a terceiros
- Use HTTPS em produção (GitHub Pages, Netlify, Vercel, etc.)