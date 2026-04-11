#!/usr/bin/env bash
set -euo pipefail

# Mission init script — idempotent environment setup
# Runs at the start of each worker session

MISSION_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$0")/../..")"

echo "[init] Mission: Enhance Mission Execution Loop"
echo "[init] Root: $MISSION_ROOT"

# Ensure dependencies are installed
if [ ! -d "$MISSION_ROOT/node_modules" ]; then
  echo "[init] Installing dependencies..."
  cd "$MISSION_ROOT" && pnpm install --frozen-lockfile
else
  echo "[init] Dependencies already installed."
fi

echo "[init] Environment ready."
