#!/usr/bin/env bash
# thingy.sh — CLI Thingy:91 X via terminal (macOS)
# Uso:
#   export NRF_USER_EMAIL=voce@empresa.com
#   export NRF_API_KEY=...   # User API Key (perfil) OU Organization Auth Token
#   ./thingy.sh help
set -euo pipefail

PORT_APP="${THINGY_PORT:-/dev/tty.usbmodem1102}"
ORG="${MEMFAULT_ORG:-telekom}"
PROJECT="${MEMFAULT_PROJECT:-nrf-project}"
API="https://api.memfault.com/api/v0/organizations/${ORG}/projects/${PROJECT}"
DEVICE_DEFAULT="50423451-3737-4337-80fc-110bddf418ff"
DEVICE="${NRF_DEVICE_ID:-$DEVICE_DEFAULT}"

cmd_help() {
  cat <<EOF
Thingy:91 X — terminal (Memfault / nRF Cloud)

  ./thingy.sh ports                 lista portas seriais
  ./thingy.sh log [seg]             captura log da app (padrão 15s)
  ./thingy.sh shell                 shell interativo (screen, sair: Ctrl-A K)
  ./thingy.sh at 'AT+CGSN=1'        envia AT command
  ./thingy.sh imei                  IMEI + device UUID
  ./thingy.sh provision             att_cloud provision
  ./thingy.sh publish APPID DATA    att_cloud publish

Nuvem Memfault (User API Key + e-mail, ou OAT Bearer):
  export NRF_USER_EMAIL=voce@empresa.com
  export NRF_API_KEY=sua_user_api_key
  # ou só OAT: export NRF_API_KEY=org_auth_token  (sem e-mail → Bearer)
  ./thingy.sh cloud-devices         GET .../devices
  ./thingy.sh cloud-device [id]     GET .../devices/{id}
  ./thingy.sh cloud-msgs [n]        (não disponível — aviso)
  ./thingy.sh cloud-location [h]    (não disponível 1:1 — aviso)
  ./thingy.sh watch [seg]           poll device a cada N seg

Vars: THINGY_PORT MEMFAULT_ORG=$ORG MEMFAULT_PROJECT=$PROJECT
      NRF_DEVICE_ID=$DEVICE NRF_USER_EMAIL NRF_API_KEY
EOF
}

cmd_ports() { ls /dev/cu.usbmodem* /dev/tty.usbmodem* 2>/dev/null; nrfutil device list 2>&1 | head -n 10; }

cmd_log() {
  local secs="${1:-15}"
  python3 - "$PORT_APP" "$secs" <<'PY2'
import serial, sys, time, re
port, secs = sys.argv[1], float(sys.argv[2])
s = serial.Serial(port, 115200, timeout=0.5)
s.reset_input_buffer()
t0 = time.time()
while time.time() - t0 < secs:
    d = s.read(1024)
    if d:
        txt = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', d.decode(errors='replace'))
        print(txt, end='', flush=True)
s.close()
PY2
}

cmd_shell() { echo "Abrindo $PORT_APP (sair: Ctrl-A depois K)..."; screen "$PORT_APP" 115200; }

py_shell_cmd() {
  python3 - "$PORT_APP" "$1" "${2:-3}" <<'PY2'
import serial, sys, time, re
port, cmd, wait = sys.argv[1], sys.argv[2], float(sys.argv[3])
s = serial.Serial(port, 115200, timeout=1)
time.sleep(0.2); s.reset_input_buffer()
s.write((cmd + '\n').encode())
t0 = time.time(); out = b''
while time.time() - t0 < wait:
    d = s.read(2048)
    if d: out += d
print(re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', out.decode(errors='replace')))
s.close()
PY2
}

cmd_at() { [ $# -eq 0 ] && { echo "Uso: $0 at 'AT+...'"; exit 1; }; py_shell_cmd "at $*"; }
cmd_imei() { py_shell_cmd "at AT+CGSN=1"; echo "Device UUID padrão: $DEVICE_DEFAULT"; }
cmd_provision() { py_shell_cmd "att_cloud provision" 15; }
cmd_publish() { [ $# -lt 2 ] && { echo "Uso: $0 publish APPID DATA"; exit 1; }; local app="$1"; shift; py_shell_cmd "att_cloud publish $app $*" 5; }

need_key() {
  if [ -z "${NRF_API_KEY:-}" ] || [ "$NRF_API_KEY" = "sua_key" ]; then
    echo "ERRO: NRF_API_KEY inválida."
    echo "  User API Key: export NRF_USER_EMAIL=... ; export NRF_API_KEY=...  # perfil Memfault"
    echo "  OAT:          export NRF_API_KEY=organization_auth_token"
    exit 1
  fi
}

api() {
  need_key
  local out code curl_args
  if [ -n "${NRF_USER_EMAIL:-}" ]; then
    out=$(curl -s -w "\n%{http_code}" -u "${NRF_USER_EMAIL}:${NRF_API_KEY}" -H "Accept: application/json" "$@")
  else
    out=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer ${NRF_API_KEY}" -H "Accept: application/json" "$@")
  fi
  code=$(echo "$out" | tail -n 1); out=$(echo "$out" | sed '$d')
  if [ "$code" != "200" ]; then
    echo "HTTP $code: $out" >&2
    echo "Dica: 401 = e-mail/User API Key errados, ou Project Key (não use). Host: api.memfault.com" >&2
    echo "__HTTP_ERROR_${code}__"
    return 1
  fi
  echo "$out"
}

cmd_cloud_devices() { api "$API/devices" | python3 -m json.tool | head -n 120; }
cmd_cloud_device() {
  local id="${1:-$DEVICE}"
  api "$API/devices/$id" | python3 -c '
import json,sys
d=json.load(sys.stdin)
x=d.get("data", d)
print("device_serial:", x.get("device_serial") or x.get("id"))
print("hardware:", x.get("hardware_version"))
print("last_seen:", x.get("last_seen"))
rel=x.get("last_seen_release") or {}
print("release:", rel.get("version") if isinstance(rel, dict) else rel)
co=x.get("cohort")
print("cohort:", co.get("slug") if isinstance(co, dict) else co)
'
}
cmd_cloud_msgs() {
  echo "Mensagens (GET /messages) não têm equivalente 1:1 na User API Memfault deste CLI." >&2
  return 1
}
cmd_cloud_location() {
  echo "Location history legado não está mapeado aqui (precisa OAT + Location Services)." >&2
  return 1
}
cmd_watch() {
  local seg="${1:-10}"
  echo "Poll $DEVICE ($ORG/$PROJECT) a cada ${seg}s (Ctrl-C sai)..."
  while true; do echo "=== $(date "+%H:%M:%S") ==="; cmd_cloud_device "$DEVICE" 2>&1 | head -n 10; sleep "$seg"; done
}

case "${1:-help}" in
  help|--help|-h) cmd_help ;;
  ports) cmd_ports ;;
  log) cmd_log "${2:-15}" ;;
  shell) cmd_shell ;;
  at) shift; cmd_at "$@" ;;
  imei) cmd_imei ;;
  provision) cmd_provision ;;
  publish) shift; cmd_publish "$@" ;;
  cloud-devices) cmd_cloud_devices ;;
  cloud-device) cmd_cloud_device "${2:-}" ;;
  cloud-msgs) cmd_cloud_msgs ;;
  cloud-location) cmd_cloud_location ;;
  watch) cmd_watch "${2:-10}" ;;
  *) echo "desconhecido: $1"; cmd_help; exit 1 ;;
esac
