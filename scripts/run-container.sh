#!/usr/bin/env bash
# Only run on a disposable GitHub-hosted Linux VM. No host network/PID namespace or Docker socket is exposed.
set -euo pipefail
: "${SCENARIO:?}" "${CONTAINER_DISTRO:?}" "${RUNNER_TEMP:?}"
[[ "$RUNNER_ENVIRONMENT" == github-hosted && "$RUNNER_OS" == Linux ]]
case "$SCENARIO" in linux-*-rpm-*|linux-*-pacman-*) ;; *) exit 2 ;; esac
out="reports/scenarios/$SCENARIO"
mkdir -p "$out/artifacts"
name="ente-validator-$SCENARIO"
cleanup() {
  code=$?
  trap - EXIT
  docker rm -f "$name" >/dev/null 2>&1 || true
  sudo chown -R "$(id -u):$(id -g)" "$out"
  if [[ ! -f "$out/report.json" ]]; then
    node src/cli.js run --plan reports/plan/plan.json --scenario "$SCENARIO" --out "$out" --disposable \
      --unavailable 'Container setup or execution stopped before a report was produced; see artifacts/container.log'
  fi
  exit "$code"
}
trap cleanup EXIT
exec > >(tee "$out/artifacts/container.log") 2>&1
context=$(mktemp -d "$RUNNER_TEMP/ente-container.XXXXXX")
cp containers/{Dockerfile,bootstrap.sh} "$context/"
cp -a "$(dirname "$(dirname "$(command -v node)")")" "$context/node"
if [[ "$CONTAINER_DISTRO" == archarm ]]; then
  # The project's os.archlinuxarm.org endpoint lacks a matching TLS certificate; use its HTTPS mirror.
  source_url=https://de3.mirror.archlinuxarm.org/os/ArchLinuxARM-aarch64-latest.tar.gz
  curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 "$source_url" -o "$context/rootfs.tar.gz"
  sha256sum "$context/rootfs.tar.gz" > "$out/artifacts/rootfs.sha256"
  printf '%s\n' "$source_url" > "$out/artifacts/rootfs-source.txt"
  docker import "$context/rootfs.tar.gz" ente-validator-archarm-base
  rm "$context/rootfs.tar.gz"
  base=ente-validator-archarm-base
elif [[ "$CONTAINER_DISTRO" == arch ]]; then
  base=archlinux:base
  docker pull "$base"
elif [[ "$CONTAINER_DISTRO" == fedora ]]; then
  base=quay.io/fedora/fedora:44
  docker pull "$base"
else
  exit 2
fi
docker image inspect "$base" > "$out/artifacts/base-image.json"
docker build --build-arg "BASE_IMAGE=$base" -t ente-validator-container "$context"
docker image inspect ente-validator-container > "$out/artifacts/container-image.json"
# Allow nftables in the private network namespace and Chromium's normal namespace sandbox.
# DNS uses a literal external server: Docker's loopback DNS proxy must not bypass offline rules.
docker run --name "$name" --init --network bridge --dns 1.1.1.1 \
  --cap-add NET_ADMIN --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  --shm-size 1g --volume "$PWD:/workspace" \
  --env GH_TOKEN --env BASELINE_READ_TOKEN --env SCENARIO \
  --env ENTE_VALIDATOR_CONTAINER=1 --env GITHUB_ACTIONS=true \
  --env RUNNER_ENVIRONMENT=github-hosted \
  ente-validator-container bash -euc '
    chown -R validator:validator /workspace/reports
    git config --system --add safe.directory /workspace
    if command -v rpm >/dev/null; then rpm -qa | sort; else pacman -Q; fi > "reports/scenarios/$SCENARIO/artifacts/container-packages.txt"
    exec sudo --preserve-env=GH_TOKEN,BASELINE_READ_TOKEN,SCENARIO,ENTE_VALIDATOR_CONTAINER,GITHUB_ACTIONS,RUNNER_ENVIRONMENT \
      -u validator dbus-run-session -- xvfb-run -a node src/cli.js run \
      --plan reports/plan/plan.json --scenario "$SCENARIO" --out "reports/scenarios/$SCENARIO" --disposable
  '
