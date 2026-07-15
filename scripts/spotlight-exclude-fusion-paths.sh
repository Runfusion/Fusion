#!/usr/bin/env bash
# Re-apply Spotlight skip markers for Fusion-heavy directories.
# Uses .metadata_never_index (Spotlight does not index dirs containing this file).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKER=".metadata_never_index"
PATHS=(
  "$ROOT/.worktrees"
  "$ROOT/.worktrees/.ai-merge"
  "$ROOT/node_modules"
  "$ROOT/.fusion"
  "$ROOT/packages/desktop/deploy"
  "$ROOT/packages/desktop/dist"
  "$HOME/.fusion"
  "$HOME/.fusion/embedded-postgres"
  "$HOME/orca/workspaces"
  "$HOME/.herdr/worktrees/kb"
  "$HOME/.paseo/worktrees"
)
for p in "${PATHS[@]}"; do
  [ -d "$p" ] || continue
  f="$p/$MARKER"
  [ -f "$f" ] || touch "$f"
  chflags hidden "$f" 2>/dev/null || true
done
if [ -d "$ROOT/.worktrees" ]; then
  for wt in "$ROOT/.worktrees"/*/; do
    [ -d "$wt" ] || continue
    f="${wt}${MARKER}"
    [ -f "$f" ] || touch "$f"
    chflags hidden "$f" 2>/dev/null || true
    if [ -d "${wt}node_modules" ]; then
      nf="${wt}node_modules/${MARKER}"
      [ -f "$nf" ] || touch "$nf"
      chflags hidden "$nf" 2>/dev/null || true
    fi
  done
fi
echo "Spotlight skip markers applied under $ROOT and related agent worktree roots."
