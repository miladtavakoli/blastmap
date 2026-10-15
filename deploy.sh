#!/usr/bin/env bash
# Pull the latest code, rebuild the image and restart the container.
set -euo pipefail
cd "$(dirname "$0")"

git pull --ff-only
# --wait blocks until the healthcheck passes, so a broken build fails this script
docker compose up -d --build --wait
