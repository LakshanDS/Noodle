#!/usr/bin/env bash
# Noodle deploy: pull latest image, recreate the container, clean up.
#
# Run from the same directory as docker-compose.yml:
#   ./deploy.sh
#
# The CI workflow scp's a fresh docker-compose.yml into this directory before
# running this script, so the compose file on the host tracks the repo without
# the VPS needing a full checkout. Assumes `docker login ghcr.io` was done once
# on this host (GHCR auth is persistent).
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Pulling latest image..."
docker compose pull

echo "==> Recreating container..."
# --force-recreate swaps the container for the freshly pulled image even when
# the compose file itself hasn't changed. -d detaches.
docker compose up -d --force-recreate

echo "==> Pruning dangling images..."
docker image prune -f

echo "==> Done. Recent logs (Ctrl-C to detach):"
docker compose logs --tail=30 noodle
