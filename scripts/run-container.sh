#!/usr/bin/env bash
# FNXC:DockerRun 2026-08-23-02:20:
# Launch the Fusion container with a complete, correct argument list.
#
# It exists because the correct `docker run` is long and every piece of it is load-bearing in a way
# that fails confusingly when omitted: the OAuth callback ports are fixed by the providers' registered
# redirect URIs and unreachable without `PI_OAUTH_CALLBACK_HOST=0.0.0.0`; `/home/node` must be a
# volume or the Tailscale login and embedded Postgres are lost on every recreate; and `--tailscale`
# is an entrypoint flag that must precede the CLI arguments. Reconstructing that by hand each time is
# how a container ends up subtly wrong.
#
# Safety: an existing container is NEVER replaced without `--recreate`. Volumes are never touched, so
# a recreate keeps the database, settings, and tailnet identity.
set -euo pipefail

IMAGE="${FUSION_IMAGE:-fusion:latest}"
NAME="${FUSION_CONTAINER_NAME:-fusion}"
HOST_PORT="${FUSION_HOST_PORT:-4040}"
CONTAINER_PORT="${FUSION_CONTAINER_PORT:-4040}"
# Volume at /home/node covers BOTH /home/node/.fusion (embedded Postgres, settings) and
# /home/node/.tailscale (node login), so one mount survives a recreate intact.
HOME_VOLUME="${FUSION_HOME_VOLUME:-fusion-home}"
WORKSPACE_VOLUME="${FUSION_WORKSPACE_VOLUME:-fusion-workspace}"
# Optional SEPARATE volume nested at /home/node/.fusion, for setups that mounted global state before
# the /home/node mount existed. Leave it unset and .fusion simply lives inside the /home/node volume.
# Getting this wrong is not destructive but is confusing: the dashboard silently reads a DIFFERENT
# database than the one the old container used, so the board comes up empty.
STATE_VOLUME="${FUSION_STATE_VOLUME:-}"
RESTART_POLICY="${FUSION_RESTART_POLICY:-unless-stopped}"
TAILSCALE="${FUSION_TAILSCALE:-0}"
# FNXC:DockerRun 2026-09-01-01:38: --from-source makes the container serve the git checkout on the
# /home/node volume instead of the image-baked /app, which is what enables Command Center's
# "Update from source" control (it refuses to act on a checkout the running process was not
# launched from). Off by default: the image build is the reproducible artifact, and a source
# checkout can be stale or mid-edit.
FROM_SOURCE="${FUSION_FROM_SOURCE:-0}"

build=0
recreate=0
dry_run=0
env_file=""

usage() {
  cat <<'USAGE'
Usage: scripts/run-container.sh [options]

Options:
  --build              Rebuild the image from the repo before starting
  --tailscale          Start tailscaled in the container (userspace mode)
  --no-tailscale       Force the daemon off, overriding an env file
  --from-source        Serve the /home/node/fusion checkout instead of the baked image
  --no-from-source     Force image-baked mode, overriding an env file
  --recreate           Replace an existing container of the same name
  --env-file <path>    Source shell variable assignments before running
  --dry-run            Print the docker command without running it
  -h, --help           Show this help

Configuration (env vars, or set them in --env-file):
  FUSION_IMAGE               image tag              (default fusion:latest)
  FUSION_CONTAINER_NAME      container name         (default fusion)
  FUSION_HOST_PORT           host port              (default 4040)
  FUSION_CONTAINER_PORT      in-container port      (default 4040)
  FUSION_HOME_VOLUME         volume for /home/node  (default fusion-home)
  FUSION_STATE_VOLUME        optional separate volume for /home/node/.fusion
  FUSION_WORKSPACE_VOLUME    volume or host path for /workspace
  FUSION_DASHBOARD_TOKEN     dashboard auth token   (optional)
  FUSION_RESTART_POLICY      docker restart policy  (default unless-stopped)
  FUSION_TAILSCALE           1 to start tailscaled  (default 0)
  FUSION_FROM_SOURCE         1 to serve the source checkout (default 0)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --build) build=1 ;;
    --tailscale) TAILSCALE=1 ;;
    --no-tailscale) TAILSCALE=0 ;;
    --from-source) FROM_SOURCE=1 ;;
    --no-from-source) FROM_SOURCE=0 ;;
    --recreate) recreate=1 ;;
    --dry-run) dry_run=1 ;;
    --env-file) env_file="${2:-}"; [ -n "$env_file" ] || { echo "--env-file needs a path" >&2; exit 2; }; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# The env file is sourced AFTER flag parsing but its values must not silently beat an explicit flag,
# so the two flags that can appear in both places are re-applied below.
if [ -n "$env_file" ]; then
  [ -f "$env_file" ] || { echo "env file not found: $env_file" >&2; exit 1; }
  # shellcheck disable=SC1090
  . "$env_file"
  IMAGE="${FUSION_IMAGE:-$IMAGE}"
  NAME="${FUSION_CONTAINER_NAME:-$NAME}"
  HOST_PORT="${FUSION_HOST_PORT:-$HOST_PORT}"
  CONTAINER_PORT="${FUSION_CONTAINER_PORT:-$CONTAINER_PORT}"
  HOME_VOLUME="${FUSION_HOME_VOLUME:-$HOME_VOLUME}"
  STATE_VOLUME="${FUSION_STATE_VOLUME:-$STATE_VOLUME}"
  WORKSPACE_VOLUME="${FUSION_WORKSPACE_VOLUME:-$WORKSPACE_VOLUME}"
  RESTART_POLICY="${FUSION_RESTART_POLICY:-$RESTART_POLICY}"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$build" = "1" ]; then
  echo "==> Building $IMAGE"
  docker build -t "$IMAGE" "$repo_root"
fi

# --dry-run is inspection, not a launch, so it must print the command even when the container
# already exists — the existence guard below would otherwise make it useless in the exact case where
# you most want to preview what a recreate would run.
if [ "$dry_run" != "1" ] && docker container inspect "$NAME" >/dev/null 2>&1; then
  if [ "$recreate" != "1" ]; then
    echo "Container '$NAME' already exists. Re-run with --recreate to replace it." >&2
    echo "(Volumes are preserved, so its database and Tailscale login survive.)" >&2
    exit 1
  fi
  echo "==> Removing existing container $NAME"
  docker rm -f "$NAME" >/dev/null
fi

args=(
  run -d
  --name "$NAME"
  --restart "$RESTART_POLICY"
  -p "${HOST_PORT}:${CONTAINER_PORT}"
  # Fixed by the providers' registered OAuth redirect URIs: 53692 Anthropic, 1455 OpenAI Codex.
  # They cannot be remapped to other host ports, and the in-container listener binds 127.0.0.1
  # unless PI_OAUTH_CALLBACK_HOST opens it, so publishing alone is not enough.
  -p 53692:53692
  -p 1455:1455
  -e PI_OAUTH_CALLBACK_HOST=0.0.0.0
  -e NODE_ENV=production
  -e "PORT=${CONTAINER_PORT}"
  -v "${HOME_VOLUME}:/home/node"
  -v "${WORKSPACE_VOLUME}:/workspace"
)

if [ -n "$STATE_VOLUME" ]; then
  args+=(-v "${STATE_VOLUME}:/home/node/.fusion")
fi

if [ -n "${FUSION_DASHBOARD_TOKEN:-}" ]; then
  args+=(-e "FUSION_DASHBOARD_TOKEN=${FUSION_DASHBOARD_TOKEN}")
fi

args+=("$IMAGE")

# --tailscale is an ENTRYPOINT flag: it is consumed and stripped by docker-entrypoint.sh, so it must
# come before the Fusion CLI arguments, not after.
if [ "$TAILSCALE" = "1" ]; then
  args+=(--tailscale)
fi

if [ "$FROM_SOURCE" = "1" ]; then
  args+=(--from-source)
fi

args+=(dashboard --host 0.0.0.0 --port "$CONTAINER_PORT")

if [ "$dry_run" = "1" ]; then
  printf 'docker'; printf ' %q' "${args[@]}"; printf '\n'
  exit 0
fi

echo "==> Starting $NAME from $IMAGE"
docker "${args[@]}" >/dev/null

echo "==> Waiting for the dashboard to answer"
deadline=$(( $(date +%s) + 300 ))
until curl -sf -o /dev/null "http://localhost:${HOST_PORT}/api/health"; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Dashboard did not become healthy within 5 minutes. Recent logs:" >&2
    docker logs --tail 40 "$NAME" >&2
    exit 1
  fi
  sleep 3
done

echo "==> Ready: http://localhost:${HOST_PORT}"

if [ "$TAILSCALE" = "1" ]; then
  if docker exec "$NAME" tailscale status >/dev/null 2>&1; then
    echo "==> Tailscale: logged in as $(docker exec "$NAME" tailscale status --json | sed -n 's/.*"DNSName": "\([^"]*\)\..*/\1/p' | head -1)"
  else
    echo "==> Tailscale: daemon running but LOGGED OUT."
    echo "    Authenticate once with: docker exec -it $NAME tailscale up"
  fi
fi
