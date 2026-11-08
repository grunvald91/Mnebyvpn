#!/usr/bin/env bash
# Remove ONLY the tagged MNEBYDNS public DoT pilot service.
set -Eeuo pipefail
(( EUID == 0 )) || exit 2
unit=/etc/systemd/system/mnebydns-dot.service
work=/opt/mnebydns-dot
if [[ -f "$unit" ]]; then
  grep -Fq 'Description=MNEBYDNS public DoT pilot - limited resources' "$unit" || exit 2
  grep -Fq 'ExecStart=/opt/mnebydns-dot/coredns -conf /opt/mnebydns-dot/Corefile' "$unit" || exit 2
  systemctl disable --now mnebydns-dot.service || true
  rm -f -- "$unit"
  systemctl daemon-reload
fi
if [[ -d "$work" ]]; then
  test -f "$work/Corefile" || exit 2
  grep -Fq '# Temporary/public DNS-over-TLS pilot' "$work/Corefile" || exit 2
  rm -f -- "$work/Corefile" "$work/coredns"
  rmdir "$work"
fi
if [[ -n "$(ss -H -lnt 'sport = :853')" ]]; then
  echo "WARNING: TCP853 listener still present; identify independently" >&2
  exit 1
fi
echo "mnebydns_pilot_removed=yes"
