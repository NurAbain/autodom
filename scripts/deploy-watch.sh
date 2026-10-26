#!/usr/bin/env bash
# Deploy an application when its release branch moves.
#
# GitHub cannot reach the production Coolify instance, so pushes never start a
# deployment. This watcher polls the branch heads instead: when a branch differs
# from the commit the application is pinned to, it pins the new commit and
# starts the deployment. Production tracks `main`, the staging environment
# tracks `staging`.
#
# Configuration:
#   /etc/autodom/deploy.env     COOLIFY_API_TOKEN (and optional COOLIFY_API_URL)
#   /etc/autodom/deploy-apps    one "<application-uuid> <branch>" pair per line
set -euo pipefail

config=${DEPLOY_CONFIG:-/etc/autodom/deploy.env}
apps=${DEPLOY_APPS:-/etc/autodom/deploy-apps}
repository=${DEPLOY_REPOSITORY:-https://github.com/NurAbain/autodom}

if [ -r "$config" ]; then
  # shellcheck disable=SC1090
  . "$config"
fi
: "${COOLIFY_API_TOKEN:?COOLIFY_API_TOKEN is required}"
# Coolify refuses API calls that arrive on its loopback address.
api_url=${COOLIFY_API_URL:-http://192.168.0.2:8000}

[ -r "$apps" ] || { echo "no application list at $apps" >&2; exit 0; }

while read -r application branch; do
  [ -n "${application:-}" ] || continue
  case "$application" in \#*) continue ;; esac
  head=$(git ls-remote "$repository" "refs/heads/$branch" 2>/dev/null | cut -f1)
  if [ -z "$head" ]; then
    echo "$application: no head for $branch" >&2
    continue
  fi
  pinned=$(curl -fsS -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
    "$api_url/api/v1/applications/$application" |
    python3 -c 'import json,sys; d=json.load(sys.stdin); a=d.get("data") or d; print(a.get("git_commit_sha") or "")' 2>/dev/null || true)
  if [ "$pinned" = "$head" ]; then
    continue
  fi
  echo "$application: $branch moved ${pinned:-none} -> $head, deploying"
  curl -fsS -o /dev/null -X PATCH \
    -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"git_branch\":\"$branch\",\"git_commit_sha\":\"$head\"}" \
    "$api_url/api/v1/applications/$application"
  curl -fsS -o /dev/null -X POST \
    -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}' \
    "$api_url/api/v1/applications/$application/start"
done <"$apps"
