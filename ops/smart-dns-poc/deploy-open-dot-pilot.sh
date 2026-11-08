#!/usr/bin/env bash
# Install a reversible single-process MNEBYDNS DoT pilot, TCP 853 ONLY.
# This file runs on the selected foreign VPS; SSH and credentials live elsewhere.
set -Eeuo pipefail
(( EUID == 0 )) || { echo "root required for systemd unit installation"; exit 2; }
[[ $# == 1 ]] || { echo "usage: deploy-open-dot-pilot.sh STAGING_DIRECTORY"; exit 2; }
source_dir="$(realpath -e -- "$1")"
[[ "$source_dir" =~ ^/tmp/mnebydns-ci-[0-9]+$ ]] || exit 2
conf="$source_dir/Corefile.open-pilot"
binary="$source_dir/coredns"
unit="$source_dir/mnebydns-dot.service"
destination=/opt/mnebydns-dot
installed_unit=/etc/systemd/system/mnebydns-dot.service
cert=/etc/letsencrypt/live/dns.mnebyvpn.site
test -f "$conf" && test -x "$binary" && test -f "$unit"
test ! -e "$destination" && test ! -e "$installed_unit"
test -z "$(ss -H -lnt 'sport = :853')"
test -s "$cert/fullchain.pem" && test -s "$cert/privkey.pem"
openssl x509 -in "$cert/cert.pem" -noout -checkhost dns.mnebyvpn.site | grep -Fq 'does match certificate'
openssl x509 -in "$cert/cert.pem" -checkend 604800 -noout >/dev/null
test "$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)" -ge 700
test "$(df -Pk /opt | awk 'NR==2{print int($4/1024)}')" -ge 1500
test "$(systemctl is-active nginx)" = active
nginx -t >/dev/null 2>&1
# A service unit must reference the expected binary, certificate credentials and caps.
grep -Fq 'ExecStart=/opt/mnebydns-dot/coredns -conf /opt/mnebydns-dot/Corefile' "$unit"
grep -Fq 'DynamicUser=yes' "$unit"
grep -Fq 'MemoryMax=160M' "$unit"
grep -Fq 'CPUQuota=20%' "$unit"
grep -Fq 'max_concurrent 16' "$conf"
grep -Fq 'tls_servername dns.quad9.net' "$conf"
grep -Fq 'bind 89.125.90.101' "$conf"
installed=false
cleanup() {
  local status=$?
  trap - ERR EXIT
  if [[ "$installed" == true && "$status" != 0 ]]; then
    systemctl stop mnebydns-dot.service >/dev/null 2>&1 || true
    systemctl disable mnebydns-dot.service >/dev/null 2>&1 || true
    rm -f -- "$installed_unit"
    rm -rf -- "$destination"
    systemctl daemon-reload
    echo "failed_deploy_rollback_attempted=yes"
  fi
  exit "$status"
}
trap cleanup EXIT
install -d -m 755 -o root -g root "$destination"
installed=true
install -m 755 -o root -g root "$binary" "$destination/coredns"
install -m 644 -o root -g root "$conf" "$destination/Corefile"
install -m 644 -o root -g root "$unit" "$installed_unit"
systemd-analyze verify "$installed_unit"
systemctl daemon-reload
systemctl start mnebydns-dot.service
sleep 1
test "$(systemctl is-active mnebydns-dot.service)" = active
bound="$(ss -H -lnt 'sport = :853' | awk '{print $4}')"
[[ "$bound" == "89.125.90.101:853" ]] || { echo "unexpected_listener=$bound"; exit 1; }
echo "public_dns_process_started=yes"
echo "source_ip_allowlist=disabled_by_owner"
echo "systemd_resource_caps=enabled"
echo "public_dns_production_ready=no"
installed=false
