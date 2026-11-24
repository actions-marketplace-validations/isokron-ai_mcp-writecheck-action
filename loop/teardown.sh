#!/usr/bin/env bash
# Ends the sandbox before any result is sealed or uploaded (tool-qa worker-kit/README.md, "Running untrusted
# servers": upload only in steps that start after every untrusted process has ended and the sandbox is gone).
# Removes every container, stops the Docker daemon and containerd, and fails unless no gVisor process is left.
# A failure here means nothing is uploaded.
set -euo pipefail
ids=$(docker ps -aq 2>/dev/null || true)
if [ -n "$ids" ]; then
  # shellcheck disable=SC2086
  docker rm -f -v $ids >/dev/null 2>&1 || true
fi
sudo systemctl stop docker.socket docker.service containerd.service
for _ in $(seq 1 20); do
  pgrep -f 'runsc-sandbox|runsc-gofer|containerd-shim-runsc' >/dev/null || { echo "the sandbox is gone: no container, no Docker daemon, no gVisor process"; exit 0; }
  sleep 0.5
done
echo "::error::a gVisor process outlived the Docker daemon; nothing is uploaded"
sudo pkill -9 -f 'runsc-sandbox|runsc-gofer|containerd-shim-runsc' || true
exit 1
