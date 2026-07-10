#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "Pulling latest image..."
docker compose pull

echo "Restarting containers..."
docker compose up -d --force-recreate

echo "Cleaning up old images..."
docker image prune -f

echo "Done. Running:"
docker compose ps
