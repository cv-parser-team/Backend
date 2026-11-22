#!/usr/bin/env bash
# Prepares one Ubuntu server to run LuminaCV (frontend and backend) and starts
# it. Run once as root: sudo bash setup.sh
# It asks for the domain, an email for HTTPS certificates, the Gemini API key,
# and a GitHub token when the repositories are private. Later deployments use
# update.sh.
set -euo pipefail

[[ $(id -u) -eq 0 ]] || { echo "Run as root: sudo bash $0" >&2; exit 1; }

root=/srv/luminacv
shared="$root/shared"
env_file="$shared/app.env"
settings_file="$shared/deploy.conf"

backend_repo_default=https://github.com/cv-parser-team/Backend.git
frontend_repo_default=https://github.com/cv-parser-team/Frontend.git
branch_default=Main

# 1. Swap: a small server runs PostgreSQL, RabbitMQ, the API and the worker.
if ! swapon --show | grep -q .; then
  echo "Adding 2 GB of swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 2. Docker and Git.
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker"
  apt-get update -y
  apt-get install -y ca-certificates curl git openssl
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null 2>&1 || apt-get install -y git

install -d -m 0700 "$shared"

# 3. Settings, kept for update.sh.
if [[ ! -f "$settings_file" ]]; then
  read -rp "Backend repository [$backend_repo_default]: " backend_repo
  read -rp "Frontend repository [$frontend_repo_default]: " frontend_repo
  read -rp "Branch [$branch_default]: " branch
  read -rsp "GitHub token (leave empty for public repositories): " github_token
  echo
  (umask 077
  cat > "$settings_file" <<EOF
BACKEND_REPO=${backend_repo:-$backend_repo_default}
FRONTEND_REPO=${frontend_repo:-$frontend_repo_default}
BRANCH=${branch:-$branch_default}
GITHUB_TOKEN=${github_token}
EOF
  )
fi

# 4. Application settings. Passwords are generated once and kept, because the
# database is created with them.
if [[ ! -f "$env_file" ]]; then
  read -rp "Domain (for example luminacv.duckdns.org): " domain
  read -rp "Email for HTTPS certificate notices: " email
  read -rsp "Gemini API key: " llm_api_key
  echo
  [[ -n "$domain" && -n "$email" && -n "$llm_api_key" ]] || {
    echo "Domain, email and Gemini API key are required" >&2
    exit 1
  }

  postgres_password=$(openssl rand -hex 24)
  rabbitmq_password=$(openssl rand -hex 24)
  jwt_secret=$(openssl rand -hex 48)

  (umask 077
  cat > "$env_file" <<EOF
APP_DOMAIN=$domain
API_DOMAIN=$domain
ACME_EMAIL=$email
PUBLIC_API_URL=https://$domain

POSTGRES_DB=luminacv
POSTGRES_USER=luminacv
POSTGRES_PASSWORD=$postgres_password
DATABASE_URL=postgresql://luminacv:$postgres_password@postgres:5432/luminacv

RABBITMQ_DEFAULT_USER=luminacv
RABBITMQ_DEFAULT_PASS=$rabbitmq_password
RABBITMQ_URL=amqp://luminacv:$rabbitmq_password@rabbitmq:5672

LLM_PROVIDER=gemini
LLM_MODEL=gemini-3.5-flash-lite
LLM_API_KEY=$llm_api_key
LLM_TIMEOUT_MS=30000
LLM_MAX_INPUT_CHARS=100000
NORMALIZATION_AI_ENABLED=true
NORMALIZATION_AI_POLL_INTERVAL_MS=5000
NORMALIZATION_AI_BATCH_SIZE=10

PORT=4000
HOST=0.0.0.0
NODE_ENV=production
JWT_SECRET=$jwt_secret
JWT_ISSUER=luminacv
JWT_AUDIENCE=luminacv-api
DOCUMENT_STORAGE_ROOT=/app/.data/documents
DOCUMENT_MAX_UPLOAD_BYTES=10485760
DOCUMENT_MAX_UPLOAD_FILES=5
DOCUMENT_STAGING_MAX_AGE_SECONDS=86400
DOCUMENT_ORPHAN_GRACE_PERIOD_SECONDS=86400
EOF
  )
  echo "Saved settings to $env_file"
fi

# 5. Download, build and start.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ -f "$script_dir/update.sh" ]]; then
  bash "$script_dir/update.sh"
else
  # Run from a pasted copy: fetch update.sh from the backend repository.
  # shellcheck disable=SC1090
  source "$settings_file"
  auth=()
  if [[ -n "$GITHUB_TOKEN" ]]; then
    basic=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)
    auth=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $basic")
  fi
  if [[ ! -d "$root/backend/.git" ]]; then
    git "${auth[@]}" clone --branch "$BRANCH" "$BACKEND_REPO" "$root/backend"
  fi
  bash "$root/backend/scripts/deploy/single-host/update.sh"
fi
