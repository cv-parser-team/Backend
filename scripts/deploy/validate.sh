#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
sample_env="$repository_root/deploy/env.production.example"
temporary_env=$(mktemp)
trap 'rm -f "$temporary_env"' EXIT

sed \
  -e 's/api\.example\.com/api.test.example/' \
  -e 's/ops@example\.com/ops@test.example/' \
  -e 's/change-me-use-a-long-url-safe-password/TestPassword-2026-safe/g' \
  -e 's/change-me-use-at-least-32-random-characters/Test-JWT-secret-2026-at-least-32-characters/' \
  -e 's/LLM_API_KEY=change-me/LLM_API_KEY=test-key/' \
  "$sample_env" > "$temporary_env"

export APP_ENV_FILE="$temporary_env"
export IMAGE_TAG=validation

docker compose \
  --env-file "$temporary_env" \
  --project-directory "$repository_root/deploy" \
  -f "$repository_root/deploy/compose.production.yml" \
  config --quiet

bash -n "$repository_root/scripts/aws/put-secrets.sh"
bash -n "$repository_root/infra/terraform/user-data.sh.tftpl"

if command -v terraform >/dev/null 2>&1; then
  terraform -chdir="$repository_root/infra/terraform" fmt -check -recursive
else
  echo "terraform is not installed; skipped terraform fmt validation" >&2
fi

echo "Deployment configuration is valid."
