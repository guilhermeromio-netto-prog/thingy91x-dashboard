# v34 — nRF9151 NTN Lab (/ntn/)

- Página: `/ntn/` (Pages e Netlify). Status atual (Cat-M / NTN buscando / NTN registrado / desligado), etapas do teste NTN,
  linha do tempo traduzindo AT para PT-BR, mapa (Cat-M azul, NTN roxo), dispositivo (ICCID/IMSI mascarados), histórico de sessões.
- Dados: `~/Documents/nrf9151-ntn/publish_logs.py` no Mac lê só os arquivos `logs/ntn-*.txt` e `logs/catm-*.txt`
  (nunca abre a serial), sanitiza (ICCID/IMSI mascarados, IP parcial, posição arredondada a 3 casas) e faz POST a cada 30 s em
  `/.netlify/functions/ntn-lab` (Netlify Blobs, store `ntn-lab`). Escrita exige `Authorization: Bearer $NTN_LAB_WRITE_TOKEN`
  (env secreto no Netlify; cópia só em `~/Documents/nrf9151-ntn/.ntn_lab_token`, chmod 600). GET é público e só devolve o resumo.
- Sem dados ao vivo, a página usa `ntn/demo.json` (último snapshot sanitizado).
- Uploader roda como LaunchAgent `com.guilherme.ntnlab.uploader` (~/Library/LaunchAgents, log em ~/Library/Logs/ntnlab-uploader.log).
  Parar: `launchctl bootout gui/$(id -u)/com.guilherme.ntnlab.uploader`. Religar: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.guilherme.ntnlab.uploader.plist`.
  Remover de vez: parar e apagar o .plist.
