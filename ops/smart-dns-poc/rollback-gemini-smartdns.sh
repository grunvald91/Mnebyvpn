#!/usr/bin/env bash
# Restore only MNEBYDNS Gemini DNS and one SNI entry.
set -Eeuo pipefail
(( EUID == 0 )) || exit 2
[[ $# == 1 && "$1" =~ ^/opt/mnebydns-gemini-backups/[0-9]+$ ]] || exit 2
base="$1"
test -s "$base/map.path" && test -f "$base/stream.before" && test -f "$base/dns.before"
map="$(cat "$base/map.path")"
[[ "$map" =~ ^/etc/nginx/streams.d/[A-Za-z0-9_.-]+[.]conf$ ]] || exit 2
test -f "$map" && test -f /opt/mnebydns-dot/Corefile
exec 9>/run/lock/mnebyvpn-public-route.lock
flock -w 8 9 || exit 2
# Never overwrite a new unrelated SNI change that happened after our deployment.
if ! cmp -s "$base/stream.before" "$map" &&
   ! grep -Fq 'gemini.google.com 127.0.0.1:15443;' "$map"; then
  echo 'gemini_shared_map_no_longer_owned_by_this_stage'
  exit 2
fi
if ! cmp -s "$base/dns.before" /opt/mnebydns-dot/Corefile &&
   ! grep -Fq '# MNEBYDNS Gemini-only canary.' /opt/mnebydns-dot/Corefile; then
  echo 'gemini_dns_corefile_no_longer_owned_by_this_stage'
  exit 2
fi
cp -p -- "$base/stream.before" "$map"
cp -p -- "$base/dns.before" /opt/mnebydns-dot/Corefile
nginx -t >/dev/null 2>&1
systemctl reload nginx
systemctl restart mnebydns-dot.service
systemctl is-active --quiet nginx
systemctl is-active --quiet mnebydns-dot.service
echo 'gemini_shared_sni_reverted=yes'
echo 'gemini_smartdns_corefile_reverted=yes'
echo 'mnebydns_dot_still_running=yes'
echo 'vpn_other_routes_preserved_by_exact_backup=yes'
