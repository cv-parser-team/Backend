#!/usr/bin/env bash
# Deploys the latest frontend and backend on a server prepared by setup.sh.
# Run as root after every change: sudo bash /srv/luminacv/backend/scripts/deploy/single-host/update.sh
set -euo pipefail

[[ $(id -u) -eq 0 ]] || { echo "Run as root: sudo bash $0" >&2; exit 1; }

root=/srv/luminacv
shared="$root/shared"
env_file="$shared/app.env"
settings_file="$shared/deploy.conf"
frontend_dist="$root/frontend-dist"

[[ -f "$settings_file" && -f "$env_file" ]] || {
  echo "Run setup.sh first" >&2
  exit 1
}

exec 9>/run/luminacv-update.lock
flock -n 9 || { echo "Another deployment is already running" >&2; exit 1; }

# shellcheck disable=SC1090
source "$settings_file"
domain=$(grep '^APP_DOMAIN=' "$env_file" | cut -d= -f2-)

auth=()
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  basic=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)
  auth=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $basic")
fi

# The checkouts only mirror the branch; local changes are discarded.
checkout() {
  local repository=$1 directory=$2
  if [[ ! -d "$directory/.git" ]]; then
    git "${auth[@]}" clone --branch "$BRANCH" "$repository" "$directory"
  fi
  git "${auth[@]}" -C "$directory" fetch origin "$BRANCH"
  git -C "$directory" reset --hard "origin/$BRANCH"
  git -C "$directory" clean -fdx -e node_modules
}

echo "== Downloading the latest code ($BRANCH)"
checkout "$BACKEND_REPO" "$root/backend"
checkout "$FRONTEND_REPO" "$root/frontend"

echo "== Building the frontend for https://$domain"
docker run --rm \
  -v "$root/frontend:/app" -w /app \
  -e VITE_API_BASE_URL="https://$domain" \
  node:24-bookworm-slim \
  sh -c 'npm ci --no-audit --no-fund && npm run build'
rm -rf "$frontend_dist.new"
cp -r "$root/frontend/dist" "$frontend_dist.new"
rm -rf "$frontend_dist"
mv "$frontend_dist.new" "$frontend_dist"

echo "== Building and starting the backend"
export APP_ENV_FILE="$env_file"
export FRONTEND_DIST="$frontend_dist"
export IMAGE_TAG
IMAGE_TAG=$(git -C "$root/backend" rev-parse --short HEAD)
compose=(docker compose
  --env-file "$env_file"
  --project-directory "$root/backend/deploy"
  -f "$root/backend/deploy/compose.production.yml"
  -f "$root/backend/deploy/compose.single-host.yml")

"${compose[@]}" build api worker migrate
"${compose[@]}" up -d --wait --wait-timeout 180 postgres rabbitmq
"${compose[@]}" run --rm migrate
"${compose[@]}" up -d --remove-orphans --wait --wait-timeout 300
docker image prune -f --filter "until=168h" >/dev/null

echo
echo "LuminaCV is running at https://$domain"
