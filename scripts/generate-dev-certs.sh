#!/usr/bin/env bash
# Generate a self-signed certificate for lab use. Not for production.
# Usage: sudo scripts/generate-dev-certs.sh [common-name] [output-dir]
set -euo pipefail

CN="${1:-watchsoc.local}"
OUT="${2:-/etc/nginx/certs}"
DAYS="${CERT_DAYS:-365}"

command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

mkdir -p "$OUT"
umask 077

if [[ -f "$OUT/watchsoc.key" && -f "$OUT/watchsoc.crt" && "${FORCE:-0}" != "1" ]]; then
    echo "Certificate already exists in $OUT. Set FORCE=1 to replace it."
    exit 0
fi

openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days "$DAYS" \
    -keyout "$OUT/watchsoc.key" -out "$OUT/watchsoc.crt" \
    -subj "/CN=${CN}" \
    -addext "subjectAltName=DNS:${CN},DNS:localhost,IP:127.0.0.1"

chmod 600 "$OUT/watchsoc.key"
chmod 644 "$OUT/watchsoc.crt"
echo "Wrote $OUT/watchsoc.crt and $OUT/watchsoc.key (CN=${CN}, ${DAYS} days)"
