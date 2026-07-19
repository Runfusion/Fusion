---
title: "U5f remainder — the workflow-aware flip, now measured on a clean surface"
type: handoff
status: ready
date: 2026-07-19
parent_plan: docs/plans/2026-07-18-001-refactor-ir-driven-lifecycle-cutover-plan.md
supersedes: docs/plans/2026-07-19-002-u5e-remaining-deletions-handoff.md
---

# U5f remainder — one flip, 257 migrations, and why that number is now trustworthy

## What U5f landed: `a7432a338`

**The "~155 pre-existing reds" on this surface were almost entirely harness drift, not
cutover damage.** Two missing mock surfaces accounted for 219 of them.

| | failed | passed | red files |
| --- | --- | --- | --- |
| before | 231 | 844 | 30 |
| after | **10** | **1065** | **4** |

Diff of failing-test *names*: **219 fixed, 0 new.** Command was identical before and after —
the 40 engine test files that drive `execute()` (list: `files_affected.txt` method below).

The two fixes:
1. **Session shape at the one seam.** ~419 per-file
   `mockedCreateFnAgent.mockResolvedValue({session:{...}})` literals define only
   `prompt`/`dispose`. Anything reaching the workflow-step session calls
   `session.subscribe(...)`. Fixed in `createResolvedAgentSession` (the single seam every
   executor session is built through) via `withSessionDefaults`, which fills only what a
   stub omitted — a stub's own methods always win.
2. **`getTaskVerificationRequestAsync` / `getTaskVerificationRequest`** were absent from
   `createMockStore` but are called unconditionally on the completion path.

**Do not re-derive this.** The lesson generalizes: mass red on this surface has repeatedly
turned out to be a handful of missing mock surfaces, not hundreds of genuine behavior
disagreements. Look for the shared seam before editing files one at a time.

The 10 that remain: 7 `restart.integration`, 1 each `executor-fast-mode-workflows` (asserts
`fn_review_step` omission — pt3 rewrites it), `executor-task-done-invariant`, `triage`.

## The remaining blocker, measured on a CLEAN surface

Adding the two workflow-selection readers to `createMockStore`:

```ts
getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "builtin:coding", stepIds: [] }),
getTaskWorkflowSelection:      vi.fn().mockReturnValue({ workflowId: "builtin:coding", stepIds: [] }),
```

costs **257 new failures across 29 files** (10 → 269). That is the honest price of routing
this surface through the graph. The earlier "+59" estimate came from a 12-file sample taken
against the 231-red surface, where the noise hid most of the cost.

Top files: `executor-worktree` 54, `executor-review-verdicts` 53, `executor-prompt` 25,
`executor-task-done-invariant` 22, `executor-step-session` 10. Full list saved during the
run; regenerate with the method below.

### Failure classes of the 257 — these look systemic, not individual

```
 64  TypeError: Cannot read properties of undefined (reading 'execute')
 41  graph abort: no-worktree-for-write-node
 29  "Workflow step failed: Code Review"
 29  "Advisory workflow step failed: Plan Review"
 20  tools.fn_review_step is not a function
 12  this.store.getTaskVerificationRequestAsync is not a function   <- per-file local fakes
  7  tools.fn_task_update / fn_task_add_dep is not a function
```

**Read this optimistically, and verify before budgeting for 257 hand migrations.** The 219
collapse came from exactly this shape of list. The `reading 'execute'` cluster (64) and the
`no-worktree-for-write-node` cluster (41) are each almost certainly ONE missing harness
surface, not 105 independent test disagreements. Probe those two first; the residual after
fixing them is the real migration cost.

Diagnosed root cause of the `no-worktree` cluster: once graph-owned, a run logs
`[pre-merge] Starting workflow step: Plan Review` → `Advisory workflow step failed` →
`[pre-merge] Starting workflow step: Code Review` →
`Code Review failed before producing a verdict: no-worktree-for-write-node`. The execute
seam never produces a worktree, so worktree-mechanics assertions never see
`"Worktree created at"`.

Two levers already tried and **ruled out** — do not repeat them:
- Explicit `enabledWorkflowSteps: []` on the mock store's default task. No effect: the graph
  reads `enabledWorkflowSteps` off the task object *passed to `execute()`*, and these tests
  pass inline task literals.
- Adding `enabledWorkflowSteps: []` to those inline literals too. Made it **worse** (54 → 57),
  so the degenerate behavior is not merely `defaultOn` Plan Review.
  (`workflow-graph-executor.ts:658` does confirm `[]` bypasses `defaultOn` — the bypass works;
  it just is not what is breaking these runs.)

### On the "generalize task-pipeline-smoke's fixture" shortcut

It does not apply as stated, and knowing why saves a session. **`task-pipeline-smoke` never
constructs a `TaskExecutor`.** It drives `WorkflowTaskRuntime` directly with *injected
primitives* (`stepExecute`, `runReview`, `runVerification`, `requestMerge`, …) that all
return `{outcome:"success"}`. Its "store" is a 3-method stub only because the primitives are
injected — there is no faithful store fixture there to lift.

The transferable idea is the *primitive injection*, not the store: the executor's graph run
builds its seams internally (`createGraphSeams`), so the harness has no way to substitute
succeeding primitives. If the 64/41 clusters do not fall to a simpler fix, adding a
test-only primitive-injection seam to the executor is the principled next step — and it is
also what would let these tests assert graph behavior without standing up a real worktree.

## Then the unlock (unchanged, still strictly gated behind the flip)

```
delete maybeExecuteWorkflowGraph's legacy fallback (executor.ts ~5493,
  `transferPreHeldToLegacy = true; return false;`)
  -> graph always owns -> graphCompletion becomes MANDATORY
  -> 3 completion boundaries (executor.ts ~11627, ~12527, ~12843) -> plain returns
  -> legacy in-review handoff tails -> delete
  -> fn_review_step injection gate (~11961) statically false -> delete tool factory
     (~15384), deferred re-raise channel, review-level scaffolding
  -> workflowReviewGatesOwnedByGraph flags (~12338, ~12754, ~12776) -> constant true
  -> seam maps -> explicit runImplementation params
```

Also delete `executor-preheld-legacy-handoff.test.ts` outright — all 4 of its tests exist
*only* to assert the fallback (they `delete` both selection methods from the fake).

## Method — reproduce the measurement exactly

```bash
cd packages/engine
# the 40-file surface
grep -rln "createMockStore" src/__tests__/ | sort > /tmp/m.txt
grep -rln "\.execute(\|resumeTaskForAgent" src/__tests__/ | sort > /tmp/e.txt
comm -12 /tmp/m.txt /tmp/e.txt > /tmp/files_affected.txt
pnpm exec vitest run $(cat /tmp/files_affected.txt | tr '\n' ' ') --silent=passed-only --reporter=dot
```
Compare failing-test NAMES, not counts — counts hide simultaneous fix+break:
```bash
grep -aoE "^ *FAIL +\|?[a-z-]*\|? ?src/__tests__/[^ ]+\.test\.ts > .*" run.txt \
  | sed 's/^ *FAIL *|[a-z-]*| *//' | sort -u > names.txt
comm -13 before_names.txt after_names.txt   # NEW failures
comm -23 before_names.txt after_names.txt   # FIXED
```
The run takes ~5 minutes; background it (a foreground 2-minute cap will kill it mid-run, and
a partial file silently reads as "still running").

## Guardrails

Oracle net (59/59), `pnpm test:gate` engine-core (294/294) and pg-gate (126/126, fully green
at `a7432a338`) must stay green at every commit. Scope verification to changed files, no
`allowFullSuite`; port 4040 reserved; stage by explicit path (Fusion writes concurrently).
