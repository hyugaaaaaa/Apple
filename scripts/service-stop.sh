#!/usr/bin/env bash
set -euo pipefail

LABEL="com.hyuga.leftcontroller"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
pkill -f "/Users/hyuga/iphone-mac-left-controller/server.js" >/dev/null 2>&1 || true
echo "Stopped: $LABEL"
