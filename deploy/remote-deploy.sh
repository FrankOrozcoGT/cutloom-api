#!/bin/bash
set -euo pipefail

cd /srv/cutloom-api

# If invoked with stdin piped in (the GitHub Actions deploy step does this),
# treat it as the new .env.production content and write it before deploying.
# This is the only way secrets reach the server: this script is the sole
# command the deploy-cutloom SSH key is allowed to run (forced via
# authorized_keys), so there's no way to pass it a different command instead.
if [ ! -t 0 ]; then
  cat > .env.production.new
  mv .env.production.new .env.production
  chmod 600 .env.production
fi

docker compose pull api
docker compose up -d --force-recreate api
docker compose exec -T api bun run db:migrate
docker image prune -f
