#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$HOME/Library/LaunchAgents"
SERVER_SRC="$PROJECT_DIR/launchd/com.hyuga.leftcontroller.plist"
CLOUDFLARED_SRC="$PROJECT_DIR/launchd/com.hyuga.leftcontroller.cloudflared.plist"
SERVER_LABEL="com.hyuga.leftcontroller"
CLOUDFLARED_LABEL="com.hyuga.leftcontroller.cloudflared"

mkdir -p "$AGENT_DIR" "$PROJECT_DIR/logs"

if [[ ! -f "$SERVER_SRC" ]]; then
  echo "Missing file: $SERVER_SRC" >&2
  exit 1
fi

if [[ ! -f "$CLOUDFLARED_SRC" ]]; then
  echo "Missing file: $CLOUDFLARED_SRC" >&2
  echo "Run: bash deploy/setup-cloudflare.sh ..." >&2
  exit 1
fi

cp "$SERVER_SRC" "$AGENT_DIR/$SERVER_LABEL.plist"
cp "$CLOUDFLARED_SRC" "$AGENT_DIR/$CLOUDFLARED_LABEL.plist"

launchctl bootout "gui/$(id -u)/$SERVER_LABEL" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)/$CLOUDFLARED_LABEL" >/dev/null 2>&1 || true

launchctl bootstrap "gui/$(id -u)" "$AGENT_DIR/$SERVER_LABEL.plist"
launchctl bootstrap "gui/$(id -u)" "$AGENT_DIR/$CLOUDFLARED_LABEL.plist"

launchctl kickstart -k "gui/$(id -u)/$SERVER_LABEL"
launchctl kickstart -k "gui/$(id -u)/$CLOUDFLARED_LABEL"

echo "Installed and started launch agents:"
echo "  - $SERVER_LABEL"
echo "  - $CLOUDFLARED_LABEL"
echo
echo "Check status: bash deploy/status.sh"
