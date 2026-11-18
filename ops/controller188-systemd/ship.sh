#!/usr/bin/env bash
# Transfer ONLY reviewed public source artifacts to existing RU188. The
# private controller signer stays on RU188 and is never read by this script.
set -Eeuo pipefail
umask 077
: "${SOURCE_SHA:?immutable tested source commit required}"
: "${RU_PASSWORD:?existing RU188 SSH secret required}"
: "${PINNED_KNOWN_HOSTS:?approved SSH host pin required}"
[[ "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ $# == 2 && -f "$1" && -f "$2" ]] || exit 2
test -s "$PINNED_KNOWN_HOSTS"
grep -q '^188\.120\.254\.223 ssh-ed25519 ' "$PINNED_KNOWN_HOSTS"
artifact="$1"
installer="$2"
bundle="/run/mnebyvpn-controller-release-${SOURCE_SHA}.tar.gz"
remote_script="/run/mnebyvpn-controller-installer-${SOURCE_SHA}.py"
digest="$(sha256sum "$artifact" | awk '{print $1}')"
export SSHPASS="$RU_PASSWORD"
opts=(-T -F /dev/null -o ConnectTimeout=12 -o BatchMode=no
  -o PasswordAuthentication=yes -o PubkeyAuthentication=no
  -o KbdInteractiveAuthentication=no -o StrictHostKeyChecking=yes
  -o HostKeyAlgorithms=ssh-ed25519
  -o "UserKnownHostsFile=$PINNED_KNOWN_HOSTS"
  -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no
  -o ForwardAgent=no -o ClearAllForwardings=yes -o LogLevel=ERROR)
remote() { sshpass -e ssh "${opts[@]}" root@188.120.254.223 "$1"; }
cleanup() { remote "rm -f '$bundle' '$remote_script'" >/dev/null 2>&1 || :; }
trap cleanup EXIT
remote "umask 077; test ! -e '$bundle'; cat > '$bundle'" < "$artifact"
remote "umask 077; test ! -e '$remote_script'; cat > '$remote_script'" < "$installer"
remote "python3 '$remote_script' --bundle '$bundle' --sha256 '$digest' --commit '$SOURCE_SHA'"
remote 'set -eu
  test "$(docker inspect --format "{{.State.Running}}" mnebyvpn-public-web)" = true
  test "$(docker inspect --format "{{.State.Running}}" mnebyvpn-stage-postgres)" = true
  test "$(docker inspect --format "{{.State.Running}}" mnebyvpn-vpn-worker)" = true
  ! systemctl is-active --quiet mnebyvpn-fi-enrollment.service
  ! systemctl is-active --quiet mnebyvpn-awg-delivery.service
  echo "controller188_existing_web_db_vpn_running=true"
  echo "fi_enrollment_unit_active=false"
  echo "awg_delivery_unit_active=false"'
