#!/usr/bin/env bash
# RU188: one-shot, build-and-probe ONLY. No signing keys, DB or network to the
# running canary. Does not start the FI registrar/AWG delivery service.
set -Eeuo pipefail
umask 077

[[ $# == 2 ]] || { echo 'usage: stage.sh /private/reviewed/source SHA' >&2; exit 2; }
source_dir="$1"
source_sha="$2"
[[ "$source_sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'invalid reviewed commit' >&2; exit 2; }
[[ "$source_dir" == /run/mnebyvpn-controller-build.* ]] ||
  { echo 'source must be isolated /run staging' >&2; exit 2; }
[[ "$EUID" == 0 ]] || { echo 'only root on central RU188' >&2; exit 2; }
test -d /opt/mnebyvpn
test -f /root/mnebyvpn-controller/bootstrap-manifest.json
test -f "$source_dir/ops/controller188-runtime/Dockerfile"
test -f "$source_dir/ops/controller188-runtime/probe.mjs"
test -f "$source_dir/apps/service/src/fi-enrollment-controller.ts"
test -f "$source_dir/apps/service/src/awg-controller-delivery-worker.ts"
test -d "$source_dir/packages/provisioning/src"
test "$(stat -c %u "$source_dir")" = 0
test "$(stat -c %a "$source_dir")" = 700

# Explicit Docker image ID, never a mutable tag. The source image must be
# the exact currently installed, running MNEBYVPN web image on RU188.
test "$(docker inspect --format '{{.State.Running}}' mnebyvpn-public-web)" = true
test "$(docker inspect --format '{{.State.Running}}' mnebyvpn-stage-postgres)" = true
base="$(docker inspect --format '{{.Image}}' mnebyvpn-public-web)"
[[ "$base" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'invalid pinned baseline image' >&2; exit 3; }
docker image inspect "$base" >/dev/null
image="mnebyvpn-controller188-canary:$source_sha"
if docker image inspect "$image" >/dev/null 2>&1; then
  echo 'controller188_canary_image_already_exists=true'
  exit 3
fi

# Docker BuildKit resolves FROM sha256:<local IMAGE ID> as a registry image,
# not a local ID. Assign a unique temporary tag to the ALREADY PINNED local
# image, reject collisions and verify it before and after the build. Never
# pull that tag or overwrite any existing/production image tag.
base_tag="mnebyvpn-controller188-build-base:$source_sha"
if docker image inspect "$base_tag" >/dev/null 2>&1; then
  echo 'controller188_temporary_base_tag_collision=true'
  exit 3
fi
docker tag "$base" "$base_tag"
cleanup_base_tag() {
  docker image rm "$base_tag" >/dev/null 2>&1 || true
}
trap cleanup_base_tag EXIT
test "$(docker image inspect --format '{{.Id}}' "$base_tag")" = "$base"

# Building a NEW image does not modify any existing container. No signing
# keys, host .env files, volumes, DB or Docker socket are given to the image.
docker build --pull=false --network=default --no-cache \
  --build-arg "BASE_IMAGE=$base_tag" \
  --file "$source_dir/ops/controller188-runtime/Dockerfile" \
  --tag "$image" "$source_dir" >/dev/null
test "$(docker image inspect --format '{{.Id}}' "$base_tag")" = "$base"

# Strict no-network, no-private-bind-mount, no-restart one-off smoke canary.
# No Docker socket inside the container and no container privilege elevation.
docker run --rm --pull=never \
  --network none --user 0:0 --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 64 --memory 256m --cpus 0.25 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=8m \
  "$image"
echo "controller188_canary_image_created=true"
echo "controller188_canary_no_signing_keys_or_network=true"
echo "controller188_original_postgres_still_running=$(docker inspect --format '{{.State.Running}}' mnebyvpn-stage-postgres)"
echo "controller188_original_web_still_running=$(docker inspect --format '{{.State.Running}}' mnebyvpn-public-web)"
echo "controller188_production_worker_started=false"
echo "controller188_fi_enrollment_performed=false"
