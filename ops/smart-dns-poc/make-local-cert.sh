#!/usr/bin/env bash
# Ephemeral self-signed test certificate. Never use this certificate on Android.
# Must run with root to securely hand ownership to CoreDNS distroless uid 65532.
set -euo pipefail
cd -- "$(dirname -- "$0")"
if (( EUID != 0 )); then
  echo "Run this TEST-only certificate generator with sudo/root." >&2
  exit 2
fi
umask 077
if [[ -e certs/dns.test.invalid.key || -e certs/dns.test.invalid.crt ]]; then
  echo "Test key/certificate already exists; refusing to replace it." >&2
  exit 2
fi
mkdir -p certs
chmod 700 certs
openssl req -x509 -nodes -newkey rsa:2048 -days 2 \
  -keyout certs/dns.test.invalid.key \
  -out certs/dns.test.invalid.crt \
  -subj "/CN=dns.test.invalid" \
  -addext "subjectAltName=DNS:dns.test.invalid" >/dev/null 2>&1
chown -R 65532:65532 certs
chmod 711 certs
chmod 600 certs/dns.test.invalid.key
chmod 644 certs/dns.test.invalid.crt
echo "Local-only certificate provisioned to restricted nonroot CoreDNS uid 65532."
