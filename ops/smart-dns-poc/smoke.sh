#!/usr/bin/env bash
# Manual real-network DoT test after the local Compose service was started.
set -euo pipefail
cd -- "$(dirname -- "$0")"
command -v kdig >/dev/null 2>&1 || {
  echo "kdig is required (on Debian/Ubuntu: knot-dnsutils)." >&2; exit 2;
}
[[ -s certs/dns.test.invalid.crt ]] || { echo "Missing test cert." >&2; exit 2; }
output="$(kdig @127.0.0.1 -p 1853 +tls-ca=certs/dns.test.invalid.crt \
  +tls-hostname=dns.test.invalid example.org. A)"
printf '%s\n' "$output"
grep -q 'status: NOERROR' <<<"$output" || {
  echo "DoT upstream query did not return NOERROR." >&2; exit 1;
}
echo "DoT over localhost:1853 responded with a validated test certificate."
echo "This is NOT an Android test, SNI routing test, or public-access certification."
