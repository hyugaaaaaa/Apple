#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UID_NUM="$(id -u)"

echo "=== LaunchAgent status ==="
for label in com.hyuga.leftcontroller com.hyuga.leftcontroller.cloudflared; do
  printf "\n[%s]\n" "$label"
  if launchctl print "gui/$UID_NUM/$label" >/tmp/leftcontroller-status.txt 2>/dev/null; then
    if command -v rg >/dev/null 2>&1; then
      rg "state =|last exit code =|path =" /tmp/leftcontroller-status.txt || true
    else
      grep -E "state =|last exit code =|path =" /tmp/leftcontroller-status.txt || true
    fi
  else
    echo "not loaded"
  fi
done

printf "\n=== HTTP health ===\n"
if curl -sS --max-time 2 http://localhost:8080/api/runtime >/tmp/leftcontroller-runtime.json 2>/dev/null; then
  cat /tmp/leftcontroller-runtime.json
  echo
else
  echo "http://localhost:8080 is not reachable"
fi

printf "\n=== Recent logs ===\n"
echo "[server.log]"
tail -n 20 "$PROJECT_DIR/logs/server.log" 2>/dev/null || echo "no server.log"
printf "\n[cloudflared.log]\n"
tail -n 20 "$PROJECT_DIR/logs/cloudflared.log" 2>/dev/null || echo "no cloudflared.log"
