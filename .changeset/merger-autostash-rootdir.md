---
"@runfusion/fusion": patch
---

Stop the merger from wiping concurrent dev edits in `rootDir`.

`aiMergeTask` issues several `git reset --hard` / `git reset --merge` / forced-checkout calls against `rootDir` during merge attempts. When `rootDir` is the developer's primary checkout (the common case for solo / single-host setups), those resets silently discard any unrelated unstaged or untracked changes in the working tree. We've burned developer work this way (FN-3329 retro: dashboard-tui edits were wiped mid-flight by an unrelated merge run).

`aiMergeTask` now snapshots dirty paths at entry and, if any are present, stashes them under a labeled autostash (`fusion-merger-autostash:<taskId>:<ts>`, includes untracked files via `git stash push -u`). A try/finally around the merge body restores the stash on every exit path — success, error, or abort. If the pop conflicts (e.g. the merge committed an overlapping change), the stash is left intact and the operator gets a recovery hint in the merger log; we never silently `git stash drop`.

Best-effort throughout: a stash failure logs and proceeds with the old behavior rather than blocking the merge — strictly worse regressions are off the table.
