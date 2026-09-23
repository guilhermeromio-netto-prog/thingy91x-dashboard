#!/bin/bash
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH
DASH="/Users/Guilherme.Romio-Netto/Documents/Default Project/thingy91x-dashboard"
cd "$DASH" || exit 1
echo "Thingy:91X Dashboard — http://localhost:3001"
echo "Deixe esta janela aberta. Ctrl+C para parar."
echo

# free port if stale
for p in $(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null); do kill "$p" 2>/dev/null; done
sleep 0.4

# stop previous serial poller (PID file only)
PIDF="$DASH/serial_telemetry.pid"
if [ -f "$PIDF" ]; then
  old=$(cat "$PIDF" 2>/dev/null)
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    if ps -p "$old" -o command= 2>/dev/null | grep -q "serial_telemetry.py"; then
      kill "$old" 2>/dev/null
      sleep 0.3
    fi
  fi
  rm -f "$PIDF"
fi

PYTHON=$(command -v python3 || true)
if [ -z "$PYTHON" ]; then
  echo "AVISO: python3 nao encontrado — telemetria serial desligada"
else
  nohup "$PYTHON" "$DASH/serial_telemetry.py" >> /tmp/thingy-serial-telemetry.log 2>&1 &
  echo $! > "$PIDF"
  echo "serial_telemetry.py PID $(cat "$PIDF") → serial-telemetry.json"
fi

echo "proxy.js…"
exec node proxy.js
