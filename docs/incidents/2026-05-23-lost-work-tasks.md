# Lost-work tasks discovered 2026-05-23

While investigating why FN-5475 was stuck in preflight, a board audit found
14 tasks marked Done but missing from `main`:

- **2 recovered** to main by cherry-pick or supersession
  - FN-5233 → cherry-picked as `2d2e5b809` (stranded squash on `fusion/fn-5339`)
  - FN-5530 → already on main via FN-5482's `b22112af8`
- **3 legitimate verification-only no-ops** (kept as Done)
  - FN-5472, FN-5484 — branch existed but had zero commits ahead of base
  - FN-5515 — auto-finalized as no-op (also see "incomplete-step finalize" below)
- **9 lost-work tasks** — need re-execution (catalog below)

Three engine bugs produced these outcomes; all three are fixed in this
sweep so the same patterns can't reproduce going forward:

1. **`resolveTaskMergeTarget` returned a sibling `fusion/fn-*` branch as the
   merge target** when `task.baseBranch` was inherited from a
   sibling-dispatched parent. The squash landed on the sibling branch and
   `advanceIntegrationBranchRef` advanced that ref instead of `main`. Fixed
   in `packages/core/src/task-merge.ts` — sibling branches now rejected with
   a `merge:merge-target-rejected-fusion-sibling` audit event.
2. **`findLandedTaskCommit` blindly accepted the first `git log --grep`
   hit**, mis-attributing FN-5441/5446 to an unrelated FN-5483 commit whose
   body merely *mentioned* them. Fixed in
   `packages/engine/src/self-healing.ts` — `commitOwnedByTask` is now
   line-anchored (trailers or conventional-commit subject), and step (4)
   re-verifies each candidate's body.
3. **No-op finalize cleared `modifiedFiles` when the task claimed real
   work.** Fixed in `merger.ts:aiMergeTask` and
   `self-healing.ts:recoverNoOpReviewTasks` — if a task claims
   `modifiedFiles` but the classifier would finalize as no-op, the task is
   moved back to `todo` (with progress preserved) and a
   `task:finalize-lost-work-blocked` audit event is emitted instead of
   silently destroying the audit trail.

## Re-spec catalog (the 9 lost tasks)

The original `PROMPT.md` files are intact under `.fusion/tasks/<FN-ID>/`. The
table below condenses each task's file scope and acceptance criteria so a
fresh executor run can re-implement them. Re-create each as a new Fusion
task referencing the original ID for context.

| FN-ID | Title | File scope | What needs to land |
|---|---|---|---|
| **FN-5441** | Document mergeIntegrationWorktree modes | `docs/settings-reference.md` (+ `docs/architecture.md` if it enumerates modes) | Row per value in `MergeIntegrationWorktreeMode`; default from `DEFAULT_PROJECT_SETTINGS`; cover reuse-task-worktree opt-in semantics, deprecation/alias normalization, worktrunk shortcut, `merge:cwd-integration-fallback-removed` audit. Docs-only. |
| **FN-5446** | Fix soft-delete deadlock + `blockedBy` residue | `packages/core/src/store.ts`, `packages/engine/src/scheduler.ts`, `packages/engine/src/self-healing.ts`, `packages/engine/src/run-audit.ts` + new tests in `engine/__tests__/reliability-interactions/soft-delete-blocker-residue.test.ts` and `core/__tests__/store-delete-task-blocker-residue.test.ts` | `deleteTask` clears `blockedBy`+`status` on dependents in same transaction; scheduler `task:deleted` handler mirrors `task:moved→done/archived`; new `reconcileSoftDeletedColumnDrift` self-heal w/ `task:soft-delete-column-reconciled` audit; `clearStaleBlockedBy` recognizes soft-deleted blockers; preserve FN-5147/FN-5208 invariants. |
| **FN-5487** | Self-edge removal blocked by cycle guard | `packages/core/src/store.ts`, regression tests in `core/__tests__/store-dependency-cycle.test.ts` and `engine/__tests__/reliability-interactions/dependency-cycle-reconcile.test.ts` | Make `updateTask` cycle guard delta-aware — skip `assertNoDependencyCycle` when `updates.dependencies` adds no new edges; `createTask`/`createTaskWithReservedId`/`applyReplicatedTaskCreate` untouched; self-edge guard preserved; depends on FN-5432 already on main. |
| **FN-5490** | Tokenize bare hex colors in dashboard CSS | `packages/dashboard/app/components/ScriptsModal.css`, `SettingsSyncLog.css`, `app/__tests__/dashboard-component-color-tokenization.test.ts` | Replace `#58a6ff` + `#0969da` in ScriptsModal diff-hunk with `var(--color-info, …)`; replace `#d29922` in SettingsSyncLog `--conflict` with `var(--color-warning, …)`; keep light-theme override structure; regression test asserts no bare hex outside `var(…)` fallbacks. |
| **FN-5517** | Compound @media regex helpers (768px/480px) | ~55 dashboard test files only (no CSS, no prod) | Replace broken `\)\s*\{` after `\(max-width: 768px\)` with `\)[^{]*\{`; same fix to `[^)]*` variant; convert literal `indexOf("@media (max-width: 768px) {")` to regex search; add compound-query synthetic unit test in `board-mobile.test.tsx`. |
| **FN-5526** | Reuse-worktree audit emit sites | `packages/engine/src/merger.ts`, `engine/__tests__/reliability-interactions/merge-reuse-task-worktree.test.ts` | Extend `emitReuseHandoffAuditEvent` union with `"merge:reuse-worktree-fresh-acquire"` + `"merge:reuse-worktree-fresh-acquired"`; capture `priorWorktreePath`; emit fresh-acquire/fresh-acquired before existing `merge:reuse-fallback-new-worktree`. Final order: `fresh-acquire → fresh-acquired → fallback-new-worktree`. Step 0 short-circuit if FN-5449 already landed it. |
| **FN-5539** | Typecheck fix: undefined `worktreePool` | `packages/cli/src/commands/dashboard.ts` only | Remove trailing `worktreePool` arg from `processPullRequestMergeTask(...)` call inside `onMergeImpl` (~line 1206); leave the non-dev `ProjectEngineManager` callback (~line 1520) untouched. |
| **FN-5540** | Re-spec FN-5515 regression matrix | `.fusion/tasks/FN-5515/PROMPT.md` only (gitignored) | Rewrite FN-5515's PROMPT so the matrix is permanent backstop using `it(...)` only; append 4 cases to `executor-abort-all-in-flight.test.ts` and 8 to `engine-stop-aborts-execution.test.ts`; extend existing AGENTS FN-5403 Reliability bullet; explicit denylist of existing case titles; save via `fn_task_document_write(key="docs")`. |
| **FN-5542** | Message-delivery test deflake | `packages/engine/src/agent-tools.ts`, `engine/__tests__/reliability-interactions/auto-recovery-message-delivery.test.ts` | Add optional `deliveryHandler?: MessageDeliveryAutoRecoveryHandler` to `createSendMessageTool` and `createPostRoomMessageTool`; default preserved when omitted; un-skip both flaky cases and inject a handler with `sleep: vi.fn(async () => {})` + inert `runAudit`; full reliability pool 3× clean. |

## Patterns

- **Mis-attributed-to-unrelated-commit** (FN-5441, FN-5446): both attributed
  to `e3dbfaae` — an FN-5483 commit whose body mentioned them in prose.
- **Tree-verification-only finalize** (FN-5490, FN-5539, FN-5542): logs show
  "Recorded verification pass for tree `<SHA>`" but the tree was never
  promoted to a commit; the no-op finalize then cleared `modifiedFiles`.
- **Finalized with incomplete steps** (FN-5526 at 1/7, FN-5517 at 8/8 with
  no commit, FN-5487 at 6/6 with no commit, FN-5540 at 5/5): step-gate
  passed but the work product never made it to a commit.

The three engine fixes in this sweep prevent the *recurrence* of these
patterns. The lost work itself still needs to be re-implemented as fresh
Fusion tasks.
