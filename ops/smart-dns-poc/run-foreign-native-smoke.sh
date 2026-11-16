#!/usr/bin/env bash
# Short-lived host-loopback DoT smoke on foreign VPS without Docker/daemon edits.
# Invoked only in an isolated /tmp/mnebydns-ci-<runid> directory.
set -euo pipefail
work="$(pwd -P)"
[[ "$work" =~ ^/tmp/mnebydns-ci-[0-9]+$ ]] ||
  { echo "unexpected test path; refusing"; exit 2; }
(( EUID == 0 )) || { echo "test setup must run as root"; exit 2; }
for command in coredns openssl python3 setpriv timeout ss awk; do
  if [[ "$command" != "coredns" ]]; then
    command -v "$command" >/dev/null || { echo "required tool missing: $command"; exit 2; }
  fi
done
test -x ./coredns && test -f Corefile.foreign && test -f probe-dot.py
test -f make-local-cert.sh
test ! -e certs/dns.test.invalid.key || { echo "existing test key; abort"; exit 2; }
test -z "$(ss -H -lnt 'sport = :1853')" || { echo "port_1853_busy; abort"; exit 2; }
mem_avail="$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)"
disk_avail="$(df -Pk "$work" | awk 'NR==2 {print int($4/1024)}')"
echo "host=foreign_dns_poc"
echo "mem_available_before_mib=$mem_avail"
echo "disk_available_before_mib=$disk_avail"
(( mem_avail >= 700 && disk_avail >= 1600 )) ||
  { echo "insufficient_headroom; abort"; exit 2; }
pid=""
cleanup() {
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -f -- certs/dns.test.invalid.key certs/dns.test.invalid.crt
  rmdir -- certs 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Host filesystem is unchanged except for this ephemeral work dir.
bash make-local-cert.sh
sed 's@/certs/@certs/@g' Corefile.foreign > Corefile.native
chmod 644 Corefile.native
chmod 711 "$work"
timeout --signal=TERM --kill-after=3s 85s \
  setpriv --reuid 65532 --regid 65532 --clear-groups --no-new-privs \
  env GOMAXPROCS=1 GOMEMLIMIT=96MiB ./coredns -conf Corefile.native >coredns.log 2>&1 &
pid="$!"
bound=""
for attempt in {1..40}; do
  bound="$(ss -H -lnt 'sport = :1853' | awk '{print $4}')"
  [[ -n "$bound" ]] && break
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "coredns_process_exited_early"
    tail -n 10 coredns.log || true
    exit 1
  fi
  sleep 0.2
done
if [[ "$bound" != "127.0.0.1:1853" ]]; then
  echo "unexpected_DNS_listener=$bound"
  exit 1
fi
echo "dns_listener=host_loopback_only"
python3 probe-dot.py
child="$(pgrep -P "$pid" | head -1 || true)"
if [[ "$child" =~ ^[0-9]+$ ]]; then
  rss="$(ps -o rss= -p "$child" | tr -d ' ')"
  echo "dns_resident_kib=${rss:-unknown}"
fi
cleanup
trap - EXIT INT TERM
pid=""
if [[ -n "$(ss -H -lnt 'sport = :1853')" ]]; then
  echo "cleanup_failure_listener_remains=yes"
  exit 1
fi
echo "cleanup_dns_listener=confirmed_absent"
echo "foreign_native_dot_smoke=passed"
