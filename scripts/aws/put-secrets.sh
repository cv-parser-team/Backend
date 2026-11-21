#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <region> <production-env-file> <github-deploy-private-key> [profile]" >&2
  exit 2
}

[[ $# -ge 3 && $# -le 4 ]] || usage

region=$1
env_file=$2
deploy_key_file=$3
profile=${4:-}

[[ -f "$env_file" ]] || { echo "Environment file not found: $env_file" >&2; exit 1; }
[[ -f "$deploy_key_file" ]] || { echo "Deploy key not found: $deploy_key_file" >&2; exit 1; }

if grep -Eq 'change-me|example\.com' "$env_file"; then
  echo "Refusing to upload an environment file that still contains example values." >&2
  exit 1
fi

aws_args=(--region "$region")
if [[ -n "$profile" ]]; then
  aws_args+=(--profile "$profile")
fi

aws "${aws_args[@]}" ssm put-parameter \
  --name /luminacv/production/env \
  --description "LuminaCV production Compose environment" \
  --type SecureString \
  --overwrite \
  --value "file://$env_file" >/dev/null

aws "${aws_args[@]}" ssm put-parameter \
  --name /luminacv/production/github-deploy-key \
  --description "Read-only GitHub deploy key for LuminaCV backend" \
  --type SecureString \
  --overwrite \
  --value "file://$deploy_key_file" >/dev/null

echo "Uploaded both SecureString parameters in $region."
