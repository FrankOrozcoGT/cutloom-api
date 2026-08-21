#!/bin/bash
set -euo pipefail

cd /srv/cutloom-api

docker compose pull api
docker compose up -d api
docker compose exec -T api bun run db:migrate
docker image prune -f
