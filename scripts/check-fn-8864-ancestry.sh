#!/usr/bin/env bash
set -euo pipefail

# FNXC:AgentActivityStream 2026-08-09-22:35:
# FN-8915 and dependent FN-8866 must fail closed until the durable activity stream is on their
# base. This gate proves the landed ancestry and required implementation surfaces before callers
# derive or consume the inspectable API contract.

required_commit="6bd178bdcf"

if ! git merge-base --is-ancestor "$required_commit" HEAD; then
  echo "FN-8864 ($required_commit) is not on HEAD. Rebase onto origin/main before continuing." >&2
  exit 1
fi

if [[ "$(git grep -l "AgentActivityEvent\|agent_activity_events" -- packages | wc -l | tr -d ' ')" == "0" ]]; then
  echo "FN-8864 activity stream symbols are absent from packages/. Rebase onto origin/main." >&2
  exit 1
fi

for required_path in \
  packages/core/src/task-store/async/async-agent-activity.ts \
  packages/core/src/postgres/migrations/0049_fn_8864_agent_activity_events.sql; do
  if [[ ! -f "$required_path" ]]; then
    echo "Required FN-8864 file is missing: $required_path" >&2
    exit 1
  fi
done

if ! grep -q "agent-activity" packages/dashboard/src/routes/register-setup-activity-routes.ts; then
  echo "The FN-8864 agent-activity route is absent. Rebase onto origin/main." >&2
  exit 1
fi

git log -1 --format='%h %s' "$required_commit"
