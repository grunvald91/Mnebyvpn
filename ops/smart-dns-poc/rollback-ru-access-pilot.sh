#!/usr/bin/env bash
# Restore only the exact MNEBYDNS Discord pilot; no unrelated services.
set -Eeuo pipefail
(( EUID == 0 )) || exit 2
[[ $# -eq 1 && "$1" =~ ^/opt/mnebydns-ru-access-backups/[0-9]+$ ]] || exit 2
base="$1"
map=/etc/nginx/nginx.conf
dns=/opt/mnebydns-dot/Corefile
for suffix in nginx.before nginx.pilot dns.before dns.pilot; do
  test -s "$base/$suffix" || { echo "missing_rollback_snapshot"; exit 2; }
done
exec 9>/run/lock/mnebyvpn-public-route.lock
flock -w 12 9 || { echo "rollback_lock_unavailable"; exit 2; }
[[ -f "$map" && -f "$dns" && ! -L "$map" && ! -L "$dns" ]]
if ! cmp -s "$map" "$base/nginx.pilot" && ! cmp -s "$map" "$base/nginx.before"; then
  echo "refuse_to_overwrite_newer_nginx_revision"; exit 2
fi
if ! cmp -s "$dns" "$base/dns.pilot" && ! cmp -s "$dns" "$base/dns.before"; then
  echo "refuse_to_overwrite_newer_dns_revision"; exit 2
fi

# Preserve the old working Gemini/legacy rules even if deployment failed halfway.
cp -p -- "$base/nginx.before" "$map"
cp -p -- "$base/dns.before" "$dns"
nginx -t >/dev/null 2>&1
systemctl reload nginx
systemctl restart mnebydns-dot.service
systemctl is-active --quiet nginx
systemctl is-active --quiet mnebydns-dot.service
grep -Fq 'gemini.google.com 127.0.0.1:15443;' "$map"
grep -Fq 'template IN A gemini.google.com {' "$dns"

unit=/etc/systemd/system/mnebydns-ru-access.service
confdir=/etc/mnebydns-ru-access
if [[ -f "$unit" ]]; then
  grep -Fq 'Description=MNEBYDNS exact-host Russia access TLS passthrough pilot' "$unit" ||
    { echo "unit_ownership_changed"; exit 2; }
  systemctl disable --now mnebydns-ru-access.service >/dev/null 2>&1 || true
  rm -f -- "$unit"
  systemctl daemon-reload
fi
if [[ -d "$confdir" ]]; then
  grep -Fq '# MNEBYDNS exact-host RU access TLS passthrough' "$confdir/nginx.conf" ||
    { echo "config_ownership_changed"; exit 2; }
  rm -f -- "$confdir/nginx.conf"
  rmdir -- "$confdir"
fi
echo "mnebydns_ru_access_exact_config_restored=yes"
echo "mnebydns_ru_access_sidecar_removed=yes"
echo "base_gemini_and_legacy_vpn_routes_preserved=yes"
