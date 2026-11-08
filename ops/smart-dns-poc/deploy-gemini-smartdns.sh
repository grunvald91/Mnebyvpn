#!/usr/bin/env bash
# Transactional single-domain Gemini SmartDNS pilot. Existing VPN routes untouched.
set -Eeuo pipefail
(( EUID == 0 )) || exit 2
[[ $# -eq 1 && "$1" =~ ^/tmp/mnebydns-ci-[0-9]+$ ]] || exit 2
work="$1"
runid="$(basename "$work" | cut -d- -f3)"
[[ "$runid" =~ ^[0-9]+$ ]] || exit 2
base="/opt/mnebydns-gemini-backups/$runid"
dns=/opt/mnebydns-dot/Corefile
test -f "$dns" && test -s "$work/Corefile.gemini-canary"
test -f "$work/patch-gemini-sni.py"
test -f "$work/probe-gemini-canary.py"
test -f "$work/rollback-gemini-smartdns.sh"
test ! -e "$base"
test "$(systemctl is-active nginx)" = active
test "$(systemctl is-active mnebydns-dot.service)" = active
test "$(systemctl is-active mnebydns-gemini.service)" = active
[[ "$(ss -H -lnt 'sport = :15443' | awk '{print $4}')" = 127.0.0.1:15443 ]]
[[ "$(ss -H -lnt 'sport = :853' | awk '{print $4}')" = 89.125.90.101:853 ]]
test "$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)" -ge 700
nginx -t >/dev/null 2>&1

exec 9>/run/lock/mnebyvpn-public-route.lock
flock -n 9 || { echo 'shared_route_change_locked'; exit 2; }
map="$(python3 - <<'PY'
import pathlib,re
p=pathlib.Path('/etc/nginx/nginx.conf')
pattern=re.compile(r'map\s+\$ssl_preread_server_name\s+\$direct_mtproxy_backend\s*\{')
if p.is_symlink() or not p.is_file() or len(pattern.findall(p.read_text()))!=1:
    raise SystemExit('Expected unique shared map in actual nginx.conf')
print(str(p))
PY
)"
[[ "$map" == /etc/nginx/nginx.conf ]] || exit 2
nginx -T 2>/dev/null | grep -F 'proxy_pass $direct_mtproxy_backend;' >/dev/null || exit 2
mkdir -p /opt/mnebydns-gemini-backups
install -d -m 700 -o root -g root "$base"
cp -p -- "$map" "$base/stream.before"
cp -p -- "$dns" "$base/dns.before"
printf '%s\n' "$map" > "$base/map.path"
install -m 700 "$work/rollback-gemini-smartdns.sh" "$base/rollback.sh"
python3 "$work/patch-gemini-sni.py" "$map" "$work/staged-stream.conf"
chown --reference="$map" "$work/staged-stream.conf"
chmod --reference="$map" "$work/staged-stream.conf"
cp -p -- "$work/staged-stream.conf" "$base/stream.pilot"
cp -p -- "$work/Corefile.gemini-canary" "$base/dns.pilot"
rollback_error() {
  result="$?"
  trap - ERR
  flock -u 9 || true
  bash "$base/rollback.sh" "$base" || echo 'IMMEDIATE_ROLLBACK_UNCONFIRMED=yes'
  exit "$result"
}
trap rollback_error ERR

# Independent 240-second systemd timer restores original files if caller disappears.
watchdog="mnebydns-gemini-watchdog-$runid"
systemd-run --unit="$watchdog" --on-active=240s --collect \
  /bin/bash "$base/rollback.sh" "$base" >/dev/null
echo "rollback_watchdog_armed=yes"
mv -- "$work/staged-stream.conf" "$map"
nginx -t >/dev/null 2>&1
systemctl reload nginx
test "$(systemctl is-active nginx)" = active
code="$(curl --noproxy '*' -4 -sS -o /dev/null \
  --connect-timeout 4 --max-time 15 --resolve gemini.google.com:443:89.125.90.101 \
  -w '%{http_code}' https://gemini.google.com/)"
[[ "$code" = 200 || "$code" = 302 ]] || { echo 'gemini_public_https_canary_failed'; exit 1; }
echo "gemini_public_443_origin_tls=pass"

install -m 644 -o root -g root "$work/Corefile.gemini-canary" "$dns"
systemctl restart mnebydns-dot.service
for i in $(seq 1 30); do
  if [[ "$(ss -H -lnt 'sport = :853' | awk '{print $4}')" = 89.125.90.101:853 ]]; then break; fi
  sleep 0.2
done
test "$(systemctl is-active mnebydns-dot.service)" = active
python3 "$work/probe-gemini-canary.py" --ip 89.125.90.101 \
  --port 853 --hostname dns.mnebyvpn.site
echo "gemini_live_DoT_records=pass"
echo "shared_route_existing_entries=preserved"
echo "stage_pending_external_confirmation=yes"
trap - ERR
flock -u 9
