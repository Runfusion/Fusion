---
"@fusion/dashboard": patch
---

fix(dashboard): close 8 review findings on extended Git Manager status + Integration branch setting

**Settings persistence (data-loss)** — the project-settings patch builder now applies null-as-delete to all non-model keys, matching the global-settings branch. Previously, clearing the Integration branch field (picking `(auto-detect)` or clicking `Use dropdown`) set `integrationBranch: undefined`, which `JSON.stringify` silently dropped — the server retained the stale explicit value and the operator could not un-pin the branch from the UI.

**`isIndexStale` was wrong both directions** — the heuristic (`diff --cached --name-only` non-empty AND `diff --name-only` empty) fired false-positive on benign `git add` and false-negative whenever the worktree had any unrelated edit. Replaced with a reflog-anchored check: stale iff `refs/heads/<integrationBranch>@{1}` exists, HEAD is a descendant of it, and `git diff-index --cached <prevTip>` is empty (i.e. the index exactly matches the pre-advance state).

**Auto-sync attribution** — two fixes to `collectRecentMergeAdvances` in `register-git-github.ts`:
  - Auto-sync events are now matched by `(taskId, newSha)` instead of `taskId`-only. A task that produced multiple advances over time no longer has all its older entries mislabeled with the most-recent outcome.
  - `worktreePath` comparison now runs both sides through `fs.realpathSync` first. On macOS the merger emits canonicalized paths (via `canonicalizePath` in `worktree-pool.ts`) while the route was called with the store's raw `rootDir`; symlinked project paths caused every advance to be marked `needsAction: true` indefinitely.

**Extended path no longer 500s on git failure** — the `?extended=1` branch wraps `computeExtendedGitStatus` in its own try/catch and falls back to the basic status shape on any unhandled failure. Previously an unguarded `git branch --show-current` throw escaped to the route's outer catch and returned HTTP 500, while the basic path returned 200 with the swallowed-failure shape — surface parity matters because the dashboard always passes `extended=1` and would otherwise render an error toast where it should render the degraded panel. Also wrapped the same call inside `computeExtendedGitStatus` so detached-HEAD / non-git states return an empty `currentBranch` instead of throwing.

**Integration branch falls back to `refs/remotes/origin/<branch>`** — when the configured branch exists only as a remote-tracking ref (e.g. operator set `integrationBranch: "release/v2"` without ever `git switch`-ing it locally), `integrationTipSha` now resolves to the origin tip instead of being null. A new `integrationTipSource: "local" | "remote-only" | "missing"` field tells the UI which side won; the Git Manager surfaces this with a `(remote-only — run git switch <branch> to track locally)` sub-text and a `no ref found` error state when both refs are missing.

**Copy commit hash shows two buttons** — the Copy button now copies `status.commit` (the short SHA actually displayed in the `<code>` element). A second Copy-full button surfaces `status.headSha` for git operations that need the 40-char SHA. Previously the single button silently copied the full SHA when extended was on, so what the user saw on screen was no longer what they pasted.

**Detached HEAD no longer shows misleading "(not on main)"** — `git branch --show-current` returns empty on detached HEAD; the route now leaves `isOnIntegrationBranch` as `undefined` (not `false`) in that case, and the UI's "(not on <branch>)" sub-text only renders when we know we're on a different branch — not when we're on no branch at all.
