#!/usr/bin/env bash
# Isolated, short-lived DNS-over-TLS test on explicitly selected foreign VPS.
# No firewall, host DNS, nginx, 443/853, or production VPN changes.
set -euo pipefail
cd -- "$(dirname -- "$0")"
project="${MNEBYDNS_PROJECT:-}"
[[ "$project" =~ ^mnebydns-ci-[0-9]+$ ]] || { echo "invalid isolated project name"; exit 2; }

command -v docker >/dev/null 2>&1 || { echo "docker missing"; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker engine unavailable"; exit 2; }
docker compose version >/dev/null 2>&1 || { echo "docker compose missing"; exit 2; }
command -v openssl >/dev/null 2>&1 || { echo "openssl missing"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 missing"; exit 2; }
command -v ss >/dev/null 2>&1 || { echo "ss missing"; exit 2; }
test -f compose.foreign.yaml && test -f Corefile.foreign && test -f probe-dot.py
test ! -e certs/dns.test.invalid.key || { echo "existing test key; refusing"; exit 2; }

echo "location=foreign_vps"
echo "scope=loopback_only_do_not_expose"
if [[ $(ss -H -lnt 'sport = :1853' | wc -l) -ne 0 ]]; then
  echo "host_port_1853_busy; aborting without change"
  exit 2
fi
mem_avail="$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)"
disk_root="$(docker info --format '{{.DockerRootDir}}')"
disk_avail="$(df -Pk "$disk_root" | awk 'NR==2{print int($4/1024)}')"
echo "mem_available_before_mib=$mem_avail"
echo "docker_disk_available_before_mib=$disk_avail"
if (( mem_avail < 700 || disk_avail < 1600 )); then
  echo "insufficient_memory_or_disk_for_safe_poc"
  exit 2
fi
if docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' | grep -q .; then
  echo "test_project_already_exists; aborting"
  exit 2
fi
cleanup() {
  docker compose -p "$project" -f compose.foreign.yaml down --timeout 10 >/dev/null 2>&1 || true
  # The host profile holds an ephemeral certificate; remove only its exact files.
  rm -f -- certs/dns.test.invalid.key certs/dns.test.invalid.crt
  rmdir -- certs 2>/dev/null || true
}
trap cleanup EXIT INT TERM
bash make-local-cert.sh
docker compose -p "$project" -f compose.foreign.yaml config -q
echo "config_valid=yes"
timeout 100 docker compose -p "$project" -f compose.foreign.yaml up -d --pull missing
container="$(docker compose -p "$project" -f compose.foreign.yaml ps -q resolver)"
test -n "$container"
mode="$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")"
[[ "$mode" == "host" ]] || { echo "unexpected container network mode"; exit 1; }
bound="$(ss -H -lnt 'sport = :1853' | awk '{print $4}')"
if [[ "$bound" != "127.0.0.1:1853" ]]; then
  echo "UNSAFE: unexpected published address"
  exit 1
fi
echo "listener_binding=coreDNS_host_loopback_only"
python3 probe-dot.py
docker stats --no-stream --format 'poc_mem={{.MemUsage}} poc_cpu={{.CPUPerc}}' "$container"
echo "runtime_test=passed"
