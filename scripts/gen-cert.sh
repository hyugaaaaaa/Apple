#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$ROOT_DIR/certs"
KEY_PATH="$CERT_DIR/server.key"
CRT_PATH="$CERT_DIR/server.crt"
CNF_PATH="$CERT_DIR/openssl.cnf"

mkdir -p "$CERT_DIR"

IPS=$(ifconfig | awk '/inet /{print $2}' | grep -E '^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|169\.254\.|127\.)' | sort -u)

ALT_NAMES="DNS.1 = localhost\nIP.1 = 127.0.0.1"
I=2
while IFS= read -r ip; do
  [ -z "$ip" ] && continue
  ALT_NAMES+="\nIP.$I = $ip"
  I=$((I+1))
done <<< "$IPS"

cat > "$CNF_PATH" <<CFG
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = req_distinguished_name
x509_extensions = v3_req

[req_distinguished_name]
CN = localhost

[v3_req]
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
$ALT_NAMES
CFG

openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
  -keyout "$KEY_PATH" \
  -out "$CRT_PATH" \
  -subj "/CN=localhost" \
  -config "$CNF_PATH" \
  -extensions v3_req

chmod 600 "$KEY_PATH"

echo "Generated:"
echo "- $KEY_PATH"
echo "- $CRT_PATH"
