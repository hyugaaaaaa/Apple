#!/usr/bin/env bash
set -euo pipefail

LABEL="com.hyuga.leftcontroller"
launchctl print "gui/$(id -u)/$LABEL" | sed -n '1,80p'
echo
echo "-- listeners --"
lsof -nP -iTCP:8080 -sTCP:LISTEN || true
echo
echo "-- health --"
curl -s "http://192.168.3.4:8080/api/health" || true
echo
