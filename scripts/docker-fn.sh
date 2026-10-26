#!/bin/sh
# FNXC:DockerCli 2026-10-26-02:09:
# `fn` on PATH inside the image, so an operator can drive a running deployment from inside the
# container (`docker exec -it <container> fn task list`) instead of only through the dashboard.
#
# WHY A WRAPPER AND NOT A SYMLINK TO dist/bin.js. The CLI has to resolve the SAME build the container
# is actually serving, so this resolves the same two roots the entrypoint resolves and honors the same
# env contract: `FUSION_APP_ROOT` (default /app) and, under `FUSION_FROM_SOURCE=1`,
# `FUSION_SOURCE_ROOT` (default /home/node/fusion). A plain symlink would pin /app and then a
# source-updated container would answer CLI questions from the image-baked build while serving the
# updated source — two Fusion versions on one PostgreSQL registry, which is the failure this image has
# already been bitten by (the bundled-plugin reload and the in-container source update both exist
# because the container had to know which build it was running).
#
# A missing source build FAILS LOUDLY with no fallback, for the same reason the entrypoint refuses one:
# silently answering from the other tree is indistinguishable from success.
#
# This wrapper is the CLI, not the supervisor: it never restarts anything and never sets
# FUSION_RESTART_SUPERVISED, so `fn` exits with the CLI's real status and cannot be mistaken for the
# supervised dashboard process. Running `fn dashboard` here starts a SECOND engine against the same
# registry; docs/docker.md states that explicitly because it is a real hazard, not a theoretical one.
set -e

app_root="${FUSION_APP_ROOT:-/app}"
source_root="${FUSION_SOURCE_ROOT:-/home/node/fusion}"

if [ "${FUSION_FROM_SOURCE:-0}" = "1" ]; then
  entry="$source_root/packages/cli/dist/bin.js"
  if [ ! -f "$entry" ]; then
    echo "fn: FUSION_FROM_SOURCE=1 but no built CLI exists at $entry" >&2
    echo "fn: build it there ('pnpm install && pnpm build'), or unset FUSION_FROM_SOURCE to use $app_root." >&2
    exit 1
  fi
else
  entry="$app_root/packages/cli/dist/bin.js"
fi

exec node "$entry" "$@"
