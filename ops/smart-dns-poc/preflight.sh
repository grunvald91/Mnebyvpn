#!/usr/bin/env bash
# Read-only, redacted capacity/port checks. Does not change VPS configuration.
set -euo pipefail
echo "smart_dns_poc_preflight=read_only"
echo "cpu_available_count=$(nproc 2>/dev/null || echo unknown)"
if [[ -r /proc/meminfo ]]; then
  awk '/^MemTotal:/ { total=int($2/1024) } /^MemAvailable:/ { avail=int($2/1024) } END { printf "mem_total_mib=%d\nmem_available_mib=%d\n",total,avail }' /proc/meminfo
fi
if command -v df >/dev/null 2>&1; then
  df -Pk /opt 2>/dev/null | awk 'NR==2 { printf "opt_disk_available_mib=%d\n",int($4/1024) }' || true
fi
if command -v ss >/dev/null 2>&1; then
  # Count only; never print sensitive process, IP, or socket inventories.
  for port in 53 443 853 1853; do
    count="$(ss -H -lnt "sport = :$port" 2>/dev/null | wc -l | tr -d ' ')"
    printf 'tcp_%s_listeners=%s\n' "$port" "$count"
  done
else
  echo "port_check=unavailable_ss_missing"
fi
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    echo "docker_daemon=available"
    if docker compose version >/dev/null 2>&1; then
      echo "docker_compose=available"
    else
      echo "docker_compose=missing"
    fi
  else
    echo "docker_daemon=not_accessible"
  fi
else
  echo "docker_cli=missing"
fi
echo "capacity_decision=requires_baseline_and_headroom_review"
