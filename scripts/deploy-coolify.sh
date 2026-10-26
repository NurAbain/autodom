#!/usr/bin/env bash
# Deploy a Coolify application from a branch that has no GitHub webhook.
#
# The production host runs Coolify on a private network, so GitHub cannot reach
# its webhook endpoint and a push never triggers a deployment. The application
# therefore keeps the commit of its last deployment, and a release has to pin
# the new commit before the deployment starts.
#
# Usage:
#   scripts/deploy-coolify.sh <application-uuid> [branch]
#
# The token comes from COOLIFY_API_TOKEN or `pass show coolify/api-token-prod`.
# The API host comes from COOLIFY_API_URL or http://192.168.0.2:8000.
set -euo pipefail

application=${1:?usage: deploy-coolify.sh <application-uuid> [branch]}
branch=${2:-}
repository=${COOLIFY_REPOSITORY:-$(cd "$(dirname "$0")/.." && pwd)}
api_url=${COOLIFY_API_URL:-http://192.168.0.2:8000}

token=${COOLIFY_API_TOKEN:-}
if [ -z "$token" ] && command -v pass >/dev/null 2>&1; then
  token=$(pass show coolify/api-token-prod | head -1)
fi
if [ -z "$token" ]; then
  echo "Coolify API token missing: set COOLIFY_API_TOKEN" >&2
  exit 1
fi

if [ -n "$branch" ]; then
  commit=$(git -C "$repository" rev-parse "origin/$branch")
else
  commit=$(git -C "$repository" rev-parse HEAD)
fi

echo "pinning $commit"
curl -fsS -o /dev/null -X PATCH \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  -d "{\"git_commit_sha\":\"$commit\"}" \
  "$api_url/api/v1/applications/$application"

echo "starting deployment"
curl -fsS -X POST \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$api_url/api/v1/applications/$application/start"
echo
