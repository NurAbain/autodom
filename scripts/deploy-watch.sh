#!/usr/bin/env bash
# Deploy an application when its release branch moves.
#
# GitHub cannot reach the production Coolify instance, so pushes never start a
# deployment. This watcher polls the branch heads instead: when a branch differs
# from the commit the application is pinned to, it pins the new commit and
# starts the deployment. Production tracks `main`, the staging environment
# tracks `staging`.
#
# Deployments run one at a time: a run starts an application, waits for the
# Coolify deployment to finish, and only then touches the next application.
# This keeps a slow build host from running several full dependency installs at
# once. A failed deployment is retried after DEPLOY_RETRY_COOLDOWN seconds
# instead of staying pinned to a failed commit forever.
#
# Configuration:
#   /etc/autodom/deploy.env     COOLIFY_API_TOKEN (and optional COOLIFY_API_URL)
#   /etc/autodom/deploy-apps    one "<application-uuid> <branch>" pair per line
#
# Optional environment:
#   DEPLOY_POLL_INTERVAL        seconds between deployment status polls (30)
#   DEPLOY_WAIT_TIMEOUT         max seconds to wait for one deployment (7200)
#   DEPLOY_RETRY_COOLDOWN       seconds before retrying a failed deployment (3600)
#   DEPLOY_LOCK_FILE            lock file (/var/lock/autodom-deploy-watch.lock)
#   DEPLOY_STATE_FILE           retry state (/var/lib/autodom/deploy-watch.state)
set -euo pipefail

config=${DEPLOY_CONFIG:-/etc/autodom/deploy.env}
apps=${1:-${DEPLOY_APPS:-/etc/autodom/deploy-apps}}
repository=${DEPLOY_REPOSITORY:-https://github.com/NurAbain/autodom}
poll_interval=${DEPLOY_POLL_INTERVAL:-30}
wait_timeout=${DEPLOY_WAIT_TIMEOUT:-7200}
retry_cooldown=${DEPLOY_RETRY_COOLDOWN:-3600}
lock_file=${DEPLOY_LOCK_FILE:-/var/lock/autodom-deploy-watch.lock}
state_file=${DEPLOY_STATE_FILE:-/var/lib/autodom/deploy-watch.state}

if [ -r "$config" ]; then
  # shellcheck disable=SC1090
  . "$config"
fi
: "${COOLIFY_API_TOKEN:?COOLIFY_API_TOKEN is required}"
# Coolify refuses API calls that arrive on its loopback address.
api_url=${COOLIFY_API_URL:-http://192.168.0.2:8000}

[ -r "$apps" ] || { echo "no application list at $apps" >&2; exit 0; }

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }

# A deployment can outlive the two-minute timer interval; one run at a time.
mkdir -p "$(dirname "$lock_file")"
exec 9>"$lock_file"
if ! flock -n 9; then
  log "another deploy-watch run is active; exiting"
  exit 0
fi

api() {
  curl -fsS --connect-timeout 10 --max-time 120 \
    -H "Authorization: Bearer $COOLIFY_API_TOKEN" "$@"
}

application_state() {
  local application=$1
  api "$api_url/api/v1/applications/$application" |
    python3 -c '
import json, sys
d = json.load(sys.stdin)
a = d.get("data") or d
print("%s\t%s" % (a.get("git_commit_sha") or "", a.get("name") or ""))
'
}

# Latest deployment for an application. Returns:
#   status<TAB>commit<TAB>updated_epoch<TAB>deployment_uuid
# Empty fields mean the application has no deployments yet.
latest_deployment() {
  local application=$1
  api "$api_url/api/v1/deployments/applications/$application?skip=0&take=1" |
    python3 -c '
import datetime, json, sys
d = json.load(sys.stdin)
items = d.get("deployments") or []
if not items:
    print("\t\t\t")
    sys.exit(0)
dep = items[0]
updated = dep.get("updated_at") or dep.get("created_at") or ""
epoch = 0
if updated:
    try:
        epoch = int(datetime.datetime.fromisoformat(updated.replace("Z", "+00:00")).timestamp())
    except ValueError:
        epoch = 0
print("%s\t%s\t%s\t%s" % (
    dep.get("status") or "",
    dep.get("commit") or "",
    epoch,
    dep.get("deployment_uuid") or "",
))
'
}

# Status of a running deployment. The running list is small; the per-deployment
# endpoint embeds the full build log, so it is only used once the deployment
# leaves the running list.
deployment_status() {
  local deployment=$1 response
  response=$(api "$api_url/api/v1/deployments") || return 1
  printf '%s' "$response" |
    python3 -c '
import json, sys
target = sys.argv[1]
for dep in json.load(sys.stdin):
    if dep.get("deployment_uuid") == target:
        print(dep.get("status") or "")
        break
' "$deployment"
}

single_deployment_status() {
  local deployment=$1
  api "$api_url/api/v1/deployments/$deployment" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("status") or "")'
}

start_deployment() {
  local application=$1 response deployment
  if ! response=$(api -X POST -H 'Content-Type: application/json' -d '{}' \
    "$api_url/api/v1/applications/$application/start"); then
    log "$application: deployment request failed"
    return 1
  fi
  deployment=$(printf '%s' "$response" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("deployment_uuid") or "")')
  if [ -z "$deployment" ]; then
    log "$application: deployment response has no deployment_uuid"
    return 1
  fi
  printf '%s\n' "$deployment"
}

pin_application() {
  local application=$1 branch=$2 commit=$3
  api -X PATCH \
    -H 'Content-Type: application/json' \
    -d "{\"git_branch\":\"$branch\",\"git_commit_sha\":\"$commit\"}" \
    "$api_url/api/v1/applications/$application" >/dev/null
}

declare -A state_commit=() state_status=() state_epoch=() state_uuid=()
if [ -r "$state_file" ]; then
  while IFS=$'\t' read -r app commit status epoch uuid; do
    [ -n "${app:-}" ] || continue
    state_commit[$app]=$commit
    state_status[$app]=$status
    state_epoch[$app]=$epoch
    state_uuid[$app]=$uuid
  done <"$state_file"
fi

save_state() {
  local app tmp="${state_file}.tmp.$$"
  mkdir -p "$(dirname "$state_file")"
  : >"$tmp"
  for app in "${!state_commit[@]}"; do
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$app" "${state_commit[$app]}" "${state_status[$app]}" \
      "${state_epoch[$app]}" "${state_uuid[$app]}" >>"$tmp"
  done
  mv "$tmp" "$state_file"
}

set_state() {
  local app=$1 commit=$2 status=$3 uuid=${4:-}
  state_commit[$app]=$commit
  state_status[$app]=$status
  state_epoch[$app]=$(date +%s)
  state_uuid[$app]=$uuid
  save_state
}

wait_for_deployment() {
  local application=$1 deployment=$2 commit=$3
  local deadline=$((SECONDS + wait_timeout))
  local status
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! status=$(deployment_status "$deployment"); then
      log "$application: cannot read running deployments; retrying"
      sleep "$poll_interval"
      continue
    fi
    if [ -z "$status" ]; then
      if ! status=$(single_deployment_status "$deployment"); then
        log "$application: deployment $deployment disappeared without a status"
        set_state "$application" "$commit" failed "$deployment"
        return 1
      fi
    fi
    case "$status" in
      finished)
        log "$application: deployment $deployment finished"
        set_state "$application" "$commit" finished "$deployment"
        return 0
        ;;
      failed|cancelled)
        log "$application: deployment $deployment $status"
        set_state "$application" "$commit" failed "$deployment"
        return 1
        ;;
      queued|in_progress)
        ;;
      *)
        log "$application: deployment $deployment status '$status'"
        ;;
    esac
    sleep "$poll_interval"
  done
  log "$application: deployment $deployment did not finish within ${wait_timeout}s"
  set_state "$application" "$commit" failed "$deployment"
  wait_timed_out=1
  return 1
}

declare -A branch_heads=()
run_failed=0
wait_timed_out=0

# Do not start a new deployment while one is already running outside this
# watcher. The timer can fire while an operator is deploying manually, and a
# second concurrent build is exactly what this script exists to prevent.
tracked_uuids=""
for app in "${!state_uuid[@]}"; do
  if [ "${state_status[$app]}" = "in_progress" ] && [ -n "${state_uuid[$app]}" ]; then
    tracked_uuids+="${tracked_uuids:+ }${state_uuid[$app]}"
  fi
done
if ! running=$(api "$api_url/api/v1/deployments"); then
  log "cannot read running deployments; exiting"
  exit 0
fi
untracked=$(printf '%s' "$running" |
  python3 -c '
import json, sys
tracked = set(sys.argv[1].split())
for dep in json.load(sys.stdin):
    if dep.get("status") in ("queued", "in_progress"):
        uuid = dep.get("deployment_uuid") or ""
        if uuid not in tracked:
            print(uuid or dep.get("application_name") or "unknown")
' "$tracked_uuids")
if [ -n "$untracked" ]; then
  log "untracked deployment(s) already running: $untracked; exiting"
  exit 0
fi
running_names=$(printf '%s' "$running" |
  python3 -c '
import json, sys
print(" ".join(
    d.get("application_name") or ""
    for d in json.load(sys.stdin)
    if d.get("status") in ("queued", "in_progress")
))
')

while read -r application branch; do
  [ -n "${application:-}" ] || continue
  case "$application" in \#*) continue ;; esac

  head=${branch_heads[$branch]:-}
  if [ -z "$head" ]; then
    head=$(timeout 60 git ls-remote "$repository" "refs/heads/$branch" 2>/dev/null | cut -f1)
    if [ -z "$head" ]; then
      log "$application: no head for $branch"
      continue
    fi
    branch_heads[$branch]=$head
  fi

  if ! app_info=$(application_state "$application"); then
    log "$application: cannot read application state"
    continue
  fi
  pinned=${app_info%%$'\t'*}
  app_name=${app_info#*$'\t'}

  state_commit_value=${state_commit[$application]:-}
  state_status_value=${state_status[$application]:-}
  state_epoch_value=${state_epoch[$application]:-0}
  state_uuid_value=${state_uuid[$application]:-}

  if [ "$state_status_value" = "in_progress" ] && [ -n "$state_uuid_value" ]; then
    log "$application: waiting for deployment $state_uuid_value already in progress"
    wait_timed_out=0
    wait_for_deployment "$application" "$state_uuid_value" "$state_commit_value" || run_failed=1
    if [ "$wait_timed_out" -eq 1 ]; then
      log "$application: stopping this run; deployment is still running"
      break
    fi
    continue
  fi

  if [ -n "$app_name" ] && case " $running_names " in *" $app_name "*) true ;; *) false ;; esac; then
    log "$application: deployment is already running outside this watcher; skipping"
    continue
  fi

  # Reconcile a missing/stale state file with Coolify once. This is the only
  # case that reads deployment history (which includes build logs).
  if [ "$pinned" = "$head" ] && [ "$state_commit_value" != "$pinned" ]; then
    if ! latest=$(latest_deployment "$application"); then
      log "$application: cannot read deployment history"
      continue
    fi
    latest_status=${latest%%$'\t'*}
    rest=${latest#*$'\t'}
    latest_commit=${rest%%$'\t'*}
    rest=${rest#*$'\t'}
    latest_epoch=${rest%%$'\t'*}
    latest_uuid=${rest#*$'\t'}
    if [ -n "$latest_status" ]; then
      state_commit[$application]=$latest_commit
      state_status[$application]=$latest_status
      state_epoch[$application]=${latest_epoch:-0}
      state_uuid[$application]=$latest_uuid
      save_state
      state_commit_value=$latest_commit
      state_status_value=$latest_status
      state_epoch_value=${latest_epoch:-0}
      state_uuid_value=$latest_uuid
    fi
  fi

  if { [ "$state_status_value" = "in_progress" ] || [ "$state_status_value" = "queued" ]; } &&
     [ -n "$state_uuid_value" ]; then
    log "$application: waiting for deployment $state_uuid_value already in progress"
    wait_timed_out=0
    wait_for_deployment "$application" "$state_uuid_value" "$state_commit_value" || run_failed=1
    if [ "$wait_timed_out" -eq 1 ]; then
      log "$application: stopping this run; deployment is still running"
      break
    fi
    continue
  fi

  if [ "$pinned" = "$head" ]; then
    case "$state_status_value" in
      failed|cancelled)
        if [ "$state_commit_value" = "$head" ]; then
          age=$(($(date +%s) - state_epoch_value))
          if [ "$age" -lt "$retry_cooldown" ]; then
            log "$application: last deployment failed ${age}s ago; retry in $((retry_cooldown - age))s"
            continue
          fi
          log "$application: retrying failed deployment of $head (last attempt ${age}s ago)"
        else
          log "$application: pinned $head but last deployment is ${state_commit_value:-unknown}; deploying"
        fi
        ;;
      finished)
        if [ "$state_commit_value" = "$head" ]; then
          log "$application: $head already deployed"
          continue
        fi
        log "$application: pinned $head but last successful deployment is ${state_commit_value:-unknown}; deploying"
        ;;
      *)
        log "$application: no deployment state for pinned $head; deploying"
        ;;
    esac
  else
    log "$application: $branch moved ${pinned:-none} -> $head, deploying"
  fi

  if [ "$pinned" != "$head" ]; then
    if ! pin_application "$application" "$branch" "$head"; then
      log "$application: failed to pin $head"
      run_failed=1
      continue
    fi
  fi

  if ! deployment=$(start_deployment "$application"); then
    set_state "$application" "$head" failed
    run_failed=1
    continue
  fi
  set_state "$application" "$head" in_progress "$deployment"
  log "$application: deployment $deployment started for $head"
  wait_timed_out=0
  wait_for_deployment "$application" "$deployment" "$head" || run_failed=1
  if [ "$wait_timed_out" -eq 1 ]; then
    log "$application: stopping this run; deployment is still running"
    break
  fi
done <"$apps"

exit "$run_failed"
