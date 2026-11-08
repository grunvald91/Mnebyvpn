#!/usr/bin/env bash
# Strict transactional public MNEBYDNS Gemini RPC extension.
# Two exact hostnames, no wildcard, no modification to other active SNI entries.
set -Eeuo pipefail
(( EUID == 0 )) || exit 2
[[ $# == 1 && "$1" =~ ^/tmp/mnebydns-ci-[0-9]+$ ]] || exit 2
work="$1"
runid="$(basename "$work" | cut -d- -f3)"
[[ "$runid" =~ ^[0-9]+$ ]] || exit 2
base="/opt/mnebydns-voice-backups/$runid"
nginx=/etc/nginx/nginx.conf
dns=/opt/mnebydns-dot/Corefile
test ! -e "$base" || exit 2
for filename in extend-gemini-voice-rr.py probe-gemini-voice.py probe-gemini-canary.py rollback-gemini-voice.sh; do
  test -s "$work/$filename" || { echo "missing_deployment_file"; exit 2; }
done
test "$(systemctl is-active nginx)" = active
test "$(systemctl is-active mnebydns-dot.service)" = active
test "$(systemctl is-active mnebydns-gemini.service)" = active
test "$(systemctl is-active mnebydns-gemini-aux.service)" = active
[[ "$(ss -H -lnt 'sport = :15444' | awk '{print $4}')" == "127.0.0.1:15444" ]]
[[ "$(ss -H -lnt 'sport = :853' | awk '{print $4}')" == "89.125.90.101:853" ]]
test "$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)" -ge 550
nginx -t >/dev/null 2>&1
exec 9>/run/lock/mnebyvpn-public-route.lock
flock -n 9 || { echo 'existing_public_route_change_in_progress'; exit 2; }
if [[ -L "$nginx" || -L "$dns" || ! -f "$nginx" || ! -f "$dns" ]]; then
  echo "refuse_symlink_or_missing_config"; exit 2
fi
mkdir -p /opt/mnebydns-voice-backups
install -d -m 700 -o root -g root "$base"
cp -p -- "$nginx" "$base/nginx.before"
cp -p -- "$dns" "$base/dns.before"
install -m 700 "$work/rollback-gemini-voice.sh" "$base/rollback.sh"
python3 "$work/extend-gemini-voice-rr.py" "$nginx" "$dns" \
  "$work/nginx.voice-pilot" "$work/dns.voice-pilot"
chown --reference="$nginx" "$work/nginx.voice-pilot"
chmod --reference="$nginx" "$work/nginx.voice-pilot"
chown --reference="$dns" "$work/dns.voice-pilot"
chmod --reference="$dns" "$work/dns.voice-pilot"
cp -p -- "$work/nginx.voice-pilot" "$base/nginx.pilot"
cp -p -- "$work/dns.voice-pilot" "$base/dns.pilot"

on_error() {
  result="$?"
  trap - ERR
  flock -u 9 || true
  bash "$base/rollback.sh" "$base" || echo "immediate_voice_rollback_unconfirmed=yes"
  exit "$result"
}
trap on_error ERR

# Independent rollback even if GitHub job loses its network session.
watchdog="mnebydns-voice-watchdog-$runid"
systemd-run --unit="$watchdog" --on-active=240s --collect \
  /bin/bash "$base/rollback.sh" "$base" >/dev/null
echo "gemini_voice_rollback_watchdog_armed=true"
mv -- "$work/nginx.voice-pilot" "$nginx"
nginx -t >/dev/null 2>&1
systemctl reload nginx

for domain in jnn-pa.googleapis.com waa-pa.clients6.google.com; do
  status="000"
  for i in $(seq 1 15); do
    status="$(curl -4 --noproxy '*' -sS -o /dev/null \
      --connect-timeout 3 --max-time 6 \
      --resolve "$domain:443:89.125.90.101" \
      -w '%{http_code}' "https://$domain/" 2>/dev/null || true)"
    if [[ "$status" != "000" && -n "$status" ]]; then break; fi
    sleep 0.5
  done
  [[ "$status" != "000" && -n "$status" ]] ||
    { echo "new_aux_public_tls_failed=$domain"; exit 1; }
  echo "new_aux_443_original_tls_pass=$domain"
done
status="$(curl -4 --noproxy '*' -sS -o /dev/null --connect-timeout 4 --max-time 12 \
  --resolve gemini.google.com:443:89.125.90.101 -w '%{http_code}' \
  https://gemini.google.com/)"
[[ "$status" == 200 || "$status" == 302 ]] ||
  { echo "original_Gemini_TLS_regressed"; exit 1; }

# No DNS cutover until all three Google TCP/TLS paths have passed.
install -m 644 -o root -g root "$base/dns.pilot" "$dns"
systemctl restart mnebydns-dot.service
for i in $(seq 1 40); do
  [[ "$(ss -H -lnt 'sport = :853' | awk '{print $4}')" == "89.125.90.101:853" ]] && break
  sleep 0.2
done
test "$(systemctl is-active mnebydns-dot.service)" = active
python3 "$work/probe-gemini-voice.py" --ip 89.125.90.101 \
  --port 853 --hostname dns.mnebyvpn.site
echo "gemini_aux_live_DoT=pass"
echo "original_Gemini_and_legacy_Nginx_routes_preserved=true"
echo "external_russian_TLS_validation_pending=true"
trap - ERR
flock -u 9
