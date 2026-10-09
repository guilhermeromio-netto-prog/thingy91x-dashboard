# v34 — nRF9151 NTN Lab (/ntn/)

- Página: `/ntn/` (Pages e Netlify). Status atual (Cat-M / NTN buscando / NTN registrado / desligado), etapas do teste NTN,
  linha do tempo traduzindo AT para PT-BR, mapa (Cat-M azul, NTN roxo), dispositivo (ICCID/IMSI mascarados), histórico de sessões.
- Dados: `~/Documents/nrf9151-ntn/publish_logs.py` no Mac lê só os arquivos `logs/ntn-*.txt` e `logs/catm-*.txt`
  (nunca abre a serial), sanitiza (ICCID/IMSI mascarados, IP parcial, posição arredondada a 3 casas) e faz POST a cada 30 s em
  `/.netlify/functions/ntn-lab` (Netlify Blobs, store `ntn-lab`). Escrita exige `Authorization: Bearer $NTN_LAB_WRITE_TOKEN`
  (env secreto no Netlify; cópia só em `~/Documents/nrf9151-ntn/.ntn_lab_token`, chmod 600). GET é público e só devolve o resumo.
- Sem dados ao vivo, a página usa `ntn/demo.json` (último snapshot sanitizado).
- Parar o uploader: `kill $(cat ~/Documents/nrf9151-ntn/publish_logs.pid)`. Iniciar: `cd ~/Documents/nrf9151-ntn && nohup python3 publish_logs.py > publish_logs.log 2>&1 &`
