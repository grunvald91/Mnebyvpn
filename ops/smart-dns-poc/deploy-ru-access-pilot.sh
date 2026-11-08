#!/usr/bin/env bash
# Transactional three-exact-host Discord Smart DNS rollout; run on the foreign VPS.
set -Eeuo pipefail
(( EUID == 0 )) || exit 2
[[ $# == 1 && "$1" =~ ^/tmp/mnebydns-ci-[0-9]+$ ]] || exit 2
work="$1"
runid="$(basename "$work" | cut -d- -f3)"
[[ "$runid" =~ ^[0-9]+$ ]] || exit 2
base="/opt/mnebydns-ru-access-backups/$runid"
nginx=/etc/nginx/nginx.conf
dns=/opt/mnebydns-dot/Corefile
unit=/etc/systemd/system/mnebydns-ru-access.service
configdir=/etc/mnebydns-ru-access
test ! -e "$base" && test ! -e "$unit" && test ! -e "$configdir"
for f in ru-access-first-pilot.json stage-ru-access-pilot.py \
         mnebydns-ru-access.service probe-ru-access.py probe-gemini-canary.py \
         rollback-ru-access-pilot.sh; do
  test -s "$work/$f" || { echo "missing_signed_stage_file=$f"; exit 2; }
done
for svc in nginx mnebydns-dot.service mnebydns-gemini.service xray.service; do
  systemctl is-active --quiet "$svc" || { echo "required_service_unavailable=$svc"; exit 2; }
done
nginx -t >/dev/null 2>&1
[[ -f "$nginx" && -f "$dns" && ! -L "$nginx" && ! -L "$dns" ]]
[[ "$(ss -H -lnt 'sport = :853' | awk '{print $4}')" = 89.125.90.101:853 ]]
test -z "$(ss -H -lnt 'sport = :15446')"
test "$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)" -ge 700

exec 9>/run/lock/mnebyvpn-public-route.lock
flock -n 9 || { echo "shared_SNI_modification_busy"; exit 2; }
install -d -m 700 -o root -g root "$(dirname "$base")"
install -d -m 700 -o root -g root "$base"
cp -p -- "$nginx" "$base/nginx.before"
cp -p -- "$dns" "$base/dns.before"
install -m 700 "$work/rollback-ru-access-pilot.sh" "$base/rollback.sh"
python3 "$work/stage-ru-access-pilot.py" \
  "$work/ru-access-first-pilot.json" "$nginx" "$dns" "$work/rendered"
cp -p -- "$work/rendered/nginx.pilot" "$base/nginx.pilot"
cp -p -- "$work/rendered/dns.pilot" "$base/dns.pilot"
# Validate exact additive source transformations before any service modification.
python3 - "$base" <<'PY'
import pathlib,sys
b=pathlib.Path(sys.argv[1])
n=b.joinpath('nginx.pilot').read_text()
d=b.joinpath('dns.pilot').read_text()
assert n.count('gemini.google.com 127.0.0.1:15443;')==1
assert d.count('template IN A gemini.google.com {')==1
for name in ('discord.com','gateway.discord.gg','cdn.discordapp.com'):
    assert n.count(name+' 127.0.0.1:15446;')==1
    assert d.count('template IN A '+name+' {')==1
print('live_pilot_additions=exactly_three_verified')
PY
# Start watchdog FIRST. If workflow is interrupted it restores both originals.
watchdog="mnebydns-ru-access-watchdog-$runid"
systemd-run --unit="$watchdog" --on-active=240s --collect \
  /bin/bash "$base/rollback.sh" "$base" >/dev/null
echo "rollback_watchdog_armed=yes"
rollback_error(){
  result="$?"
  trap - ERR
  flock -u 9 || true
  bash "$base/rollback.sh" "$base" || echo "immediate_rollback_unconfirmed=yes"
  exit "$result"
}
trap rollback_error ERR

# Start limited, deny-by-default loopback sidecar independently of nginx:443.
install -d -m 755 -o root -g root "$configdir"
install -m 644 -o root -g root "$work/rendered/relay.conf" "$configdir/nginx.conf"
install -m 644 -o root -g root "$work/mnebydns-ru-access.service" "$unit"
# nginx -t needs a temporary pid path; do not create another public 443 binding.
sed "s@/run/mnebydns-ru-access/nginx.pid@$work/ru-access-nginx.pid@" \
  "$configdir/nginx.conf" > "$work/relay-syntax.conf"
nginx -t -c "$work/relay-syntax.conf" >/dev/null 2>&1
systemd-analyze verify "$unit"
systemctl daemon-reload
systemctl start mnebydns-ru-access.service
for attempt in $(seq 1 40); do
  [[ "$(ss -H -lnt 'sport = :15446' | awk '{print $4}')" = 127.0.0.1:15446 ]] && break
  sleep 0.2
done
[[ "$(ss -H -lnt 'sport = :15446' | awk '{print $4}')" = 127.0.0.1:15446 ]]
for domain in discord.com gateway.discord.gg cdn.discordapp.com; do
  code="$(curl -4 --noproxy '*' --connect-timeout 5 --max-time 14 \
    -sS -o /dev/null -w '%{http_code}' \
    --connect-to "$domain:443:127.0.0.1:15446" "https://$domain/")"
  [[ -n "$code" && "$code" != 000 ]] || { echo "relay_TLS_failed=$domain"; exit 1; }
  echo "foreign_loopback_original_TLS=$domain"
done
if curl -4 --noproxy '*' -sS -o /dev/null --max-time 5 \
  --connect-to "example.org:443:127.0.0.1:15446" https://example.org/ >/dev/null 2>&1; then
  echo "unknown_SNI_accepted"; exit 1
fi
echo "unknown_TLS_SNI_denied=yes"

# Atomically replace ONLY the verified original Nginx config, then reload.
test ! -e /etc/nginx/.mnebydns-ru-access-new.conf
cp -p -- "$base/nginx.pilot" /etc/nginx/.mnebydns-ru-access-new.conf
mv -- /etc/nginx/.mnebydns-ru-access-new.conf "$nginx"
nginx -t >/dev/null 2>&1
systemctl reload nginx
for domain in discord.com gateway.discord.gg cdn.discordapp.com; do
  code=000
  for attempt in $(seq 1 16); do
    code="$(curl -4 --noproxy '*' -s -o /dev/null \
      --connect-timeout 3 --max-time 6 \
      --resolve "$domain:443:89.125.90.101" \
      -w '%{http_code}' "https://$domain/" || true)"
    [[ -n "$code" && "$code" != 000 ]] && break
    sleep 0.5
  done
  [[ -n "$code" && "$code" != 000 ]] || { echo "public_443_TLS_failed=$domain"; exit 1; }
  echo "foreign_public_443_original_TLS=$domain"
done
# Only after HTTPS pass, modify DNS.
test ! -e /opt/mnebydns-dot/.Corefile.ru-access-new
cp -p -- "$base/dns.pilot" /opt/mnebydns-dot/.Corefile.ru-access-new
mv -- /opt/mnebydns-dot/.Corefile.ru-access-new "$dns"
systemctl restart mnebydns-dot.service
for attempt in $(seq 1 40); do
  [[ "$(ss -H -lnt 'sport = :853' | awk '{print $4}')" = 89.125.90.101:853 ]] && break
  sleep 0.2
done
systemctl is-active --quiet mnebydns-dot.service
python3 "$work/probe-ru-access.py" --ip 89.125.90.101 \
  --port 853 --hostname dns.mnebyvpn.site
systemctl enable mnebydns-ru-access.service >/dev/null
echo "three_discord_domains_live_locally=yes"
echo "awaiting_external_Russian_path_validation=yes"
trap - ERR
flock -u 9
