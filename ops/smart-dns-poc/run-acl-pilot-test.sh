#!/usr/bin/env bash
# Run only in ephemeral GitHub Actions or a private test host. Never publish 853.
set -euo pipefail
cd -- "$(dirname -- "$0")"
(( EUID == 0 )) || { echo "local ACL smoke requires root for test cert ownership"; exit 2; }
test -x ./coredns && test -f Corefile.acl-test && test -f probe-acl.py
test -z "$(ss -H -lnt 'sport = :1853')" || { echo "port 1853 is occupied"; exit 2; }
test ! -e certs/dns.test.invalid.crt || { echo "test certificate already exists"; exit 2; }
pid=""
cleanup() {
  [[ -z "$pid" ]] || { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; }
  rm -f -- certs/dns.test.invalid.crt certs/dns.test.invalid.key
  rmdir certs 2>/dev/null || true
}
trap cleanup EXIT INT TERM
bash make-local-cert.sh
chmod 711 .
timeout --signal=TERM --kill-after=2s 35s \
  setpriv --reuid 65532 --regid 65532 --clear-groups --no-new-privs \
  env GOMAXPROCS=1 GOMEMLIMIT=96MiB ./coredns -conf Corefile.acl-test >coredns-acl.log 2>&1 &
pid="$!"
for i in {1..40}; do
  if [[ -n "$(ss -H -lnt 'sport = :1853')" ]]; then break; fi
  if ! kill -0 "$pid" 2>/dev/null; then
    tail -n 25 coredns-acl.log >&2
    exit 1
  fi
  sleep 0.2
done
test "$(ss -H -lnt 'sport = :1853' | awk '{print $4}')" = "127.0.0.1:1853"
python3 probe-acl.py
cleanup
trap - EXIT INT TERM
pid=""
test -z "$(ss -H -lnt 'sport = :1853')"
echo "acl_test_cleanup=pass"
