#!/usr/bin/env bash
# Restore exact pre-change DNS and Nginx state for one Gemini RPC canary.
set -Eeuo pipefail
(( EUID == 0 )) || exit 2
[[ $# == 1 && "$1" =~ ^/opt/mnebydns-voice-backups/[0-9]+$ ]] || exit 2
base="$1"
conf=/etc/nginx/nginx.conf
dns=/opt/mnebydns-dot/Corefile
for file in nginx.before nginx.pilot dns.before dns.pilot; do
  test -s "$base/$file" || { echo "missing_backup_file=$file"; exit 2; }
done
test -f "$conf" && test -f "$dns"
exec 9>/run/lock/mnebyvpn-public-route.lock
flock -w 10 9 || { echo "rollback_lock_unavailable"; exit 2; }
# Stop rather than overwrite someone else's later production changes.
if ! cmp -s "$base/nginx.pilot" "$conf" && ! cmp -s "$base/nginx.before" "$conf"; then
  echo "nginx_config_not_owned_by_this_canary"; exit 2
fi
if ! cmp -s "$base/dns.pilot" "$dns" && ! cmp -s "$base/dns.before" "$dns"; then
  echo "dns_config_not_owned_by_this_canary"; exit 2
fi
cp -p -- "$base/nginx.before" "$conf"
cp -p -- "$base/dns.before" "$dns"
nginx -t >/dev/null 2>&1
systemctl reload nginx
systemctl restart mnebydns-dot.service
systemctl is-active --quiet nginx
systemctl is-active --quiet mnebydns-dot.service
test "$(ss -H -lnt 'sport = :853' | awk '{print $4}')" = 89.125.90.101:853
echo "gemini_rpc_aux_nginx_and_dot_reverted=true"
echo "original_gemini_root_and_vpn_routes_preserved=true"
