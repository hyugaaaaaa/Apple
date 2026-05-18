#!/usr/bin/env bash
set -euo pipefail

PLIST_SRC="/Users/hyuga/iphone-mac-left-controller/launchd/com.hyuga.leftcontroller.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.hyuga.leftcontroller.plist"
LABEL="com.hyuga.leftcontroller"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "/Users/hyuga/iphone-mac-left-controller/logs"
cp "$PLIST_SRC" "$PLIST_DST"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed and started: $LABEL"
launchctl print "gui/$(id -u)/$LABEL" | sed -n '1,60p'
