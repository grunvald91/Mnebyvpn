#!/usr/bin/env bash
# Atomic unprivileged MNEBYVPN release. Pinned SSH host key required.
# Never edits Nginx, Xray, DNS, OS packages, firewall or other projects.
set -euo pipefail
umask 077

: "${DEPLOY_SHA:?Expected immutable main commit}"
: "${BOT_PORT:=8793}"
[[ "$DEPLOY_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid release SHA" >&2; exit 2; }
[[ "$BOT_PORT" =~ ^[0-9]{1,5}$ ]] && (( BOT_PORT>0 && BOT_PORT<65536 )) || {
  echo "Invalid BOT_PORT" >&2; exit 2;
}

root="$HOME/mnebyvpn"
archive="$root/inbox/$DEPLOY_SHA.tgz"
release="$root/releases/$DEPLOY_SHA"
current="$root/current"
test -d "$root/releases" || { echo "Dedicated release directory not provisioned" >&2; exit 3; }
for config in runtime-bot.env runtime-vpn.env; do
  test -f "$root/$config" || { echo "Dedicated runtime config not provisioned" >&2; exit 3; }
done
test -f "$archive" || { echo "Expected deployment artifact missing" >&2; exit 3; }
if [[ -e "$current" && ! -L "$current" ]]; then
  echo "Refusing to replace non-symlink current" >&2
  exit 3
fi
command -v node >/dev/null
command -v systemctl >/dev/null
command -v curl >/dev/null
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<16))process.exit(1)' || {
  echo "Node >= 22.16.0 required" >&2; exit 3;
}
# Admin must first isolate/configure systemd user units; no root actions here.
systemctl --user cat mnebyvpn-telegram.service >/dev/null
systemctl --user cat mnebyvpn-vpn-worker.service >/dev/null

mkdir -p "$release"
tar -xzf "$archive" -C "$release" --no-same-owner
(
  cd "$release"
  test -f package.json
  test -f apps/service/src/telegram-cabinet-server.ts
  test -f apps/service/src/vpn-provisioning-worker.ts
  test -f node_modules/pg/package.json
  # The contents were built and tested in the corresponding green main run.
  # Never resolve/install a different dependency set on the production VPS.
  node -e "require('pg')"
)
old=""
if [[ -L "$current" ]]; then
  old="$(readlink -f "$current")"
fi
switched=0
rollback() {
  local result=$?
  trap - EXIT
  if (( result != 0 )) && (( switched == 1 )); then
    echo "Release validation failed; restoring previous app" >&2
    if [[ -n "$old" && -d "$old" ]]; then
      ln -s "$old" "$root/.rollback.$DEPLOY_SHA"
      mv -Tf "$root/.rollback.$DEPLOY_SHA" "$current"
      systemctl --user restart mnebyvpn-telegram.service || true
      systemctl --user restart mnebyvpn-vpn-worker.service || true
    else
      rm -f "$current"
      systemctl --user stop mnebyvpn-vpn-worker.service || true
      systemctl --user stop mnebyvpn-telegram.service || true
    fi
  fi
  exit "$result"
}
trap rollback EXIT
ln -s "$release" "$root/.next.$DEPLOY_SHA"
mv -Tf "$root/.next.$DEPLOY_SHA" "$current"
switched=1

systemctl --user restart mnebyvpn-telegram.service
systemctl --user restart mnebyvpn-vpn-worker.service
ready=0
for (( i=0; i<12; i++ )); do
  if systemctl --user is-active --quiet mnebyvpn-telegram.service &&
     systemctl --user is-active --quiet mnebyvpn-vpn-worker.service &&
     curl --noproxy '*' --fail --silent --max-time 3 \
       "http://127.0.0.1:$BOT_PORT/readyz" >/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
[[ "$ready" == "1" ]] || { echo "Release did not pass private readiness" >&2; exit 4; }
echo "mnebyvpn deployment verified at commit $DEPLOY_SHA (local readiness only)"
rm -f "$archive"
