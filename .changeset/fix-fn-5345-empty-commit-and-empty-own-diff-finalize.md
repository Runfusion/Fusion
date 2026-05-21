---
"@runfusion/fusion": patch
---

Engine reliability: prevent the FN-5345 in-review wedge class.

- Fusion task worktrees now install a `prepare-commit-msg` empty-commit guard that refuses `git commit --allow-empty` and other zero-staged-diff commits, while still allowing legitimate amend / merge / squash / cherry-pick / revert / rebase paths. Amend detection scans `ps -o args=` (with `/proc/$PPID/cmdline` fallback for Alpine/busybox) tokenized, stopping at the first message-supplying flag (`-m`, `-F`, `--message`, `--file`) so a commit message containing the substring `--amend` cannot bypass the guard.
- Merger gains an early empty-own-diff fast-path in `reuse-task-worktree` integration mode: branches with own commits but zero net tree change vs merge-base now auto-finalize as no-op BEFORE any reuse-handoff acquisition runs, preventing `registered-branch-mismatch` + `merge-deadlock-detected: verified content not on main` wedges. The fast-path best-effort cleans up the stranded worktree and `fusion/<id>` branch so empty-own-diff residuals do not accumulate.
- `classifyOwnedLandedEvidence` also detects the empty-own-diff case and returns `proven-no-op` so downstream self-healing and post-handoff finalize paths benefit too.
- Merger's reuse-fallback path now consults `git worktree list --porcelain` before creating a new worktree, reusing extant usable registrations of `fusion/<id>` and pruning stale ones, eliminating FN-5083-class branch-registration double-registration. The direct-reuse shortcut is guarded by FN-4811 (refuses paths owned by a different task in `activeSessionRegistry`) and FN-4954 (skipped when `recycleWorktrees=true` with a pool attached, so `WorktreePool.acquire` lease bookkeeping stays consistent). Two new audit subtypes (`merge:reuse-fallback-pruned-stale-registration`, `merge:reuse-fallback-reused-existing-registration`) replace the prior overloading of `merge:reuse-fallback-new-worktree` for these cases.
