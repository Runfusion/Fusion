---
title: "U10 remainder — fn_review_step is gone; the flip now costs 102, and two of its seams are identified"
type: handoff
status: ready
date: 2026-07-19
parent_plan: docs/plans/2026-07-18-001-refactor-ir-driven-lifecycle-cutover-plan.md
supersedes: docs/plans/2026-07-19-004-u5g-flip-residual-handoff.md
---

# U10 remainder — the fn_review_step slice is retired, the flip is measured, the merge boundary is the next unlock

## What landed (both green, both on the branch)

**`e460752f1` — U10 pt2: `fn_review_step` and its exclusive machinery are deleted.**
Ordered first per the coordinator, and the ruling held: the whole
`tools.fn_review_step is not a function` slice is gone before the flip ever pays for it.
Full deletion list and the per-file test triage are in that commit's body.

**`<this commit>` — U10's tombstone ratchet + AGENTS.md re-key.**
`packages/engine/src/__tests__/legacy-tombstones.test.ts` (5 tests, 258 ms) asserts 3 deleted
files stay deleted and 14 deleted symbols never reappear in executable production source. It
strips comments first — every deletion left an explanatory FNXC note naming what it removed, and
those notes are the point; they must survive while the code must not.

## The measured state of the flip

Surface: the 40 engine test files that drive `execute()` (method in the predecessor handoff).

| | failed | passed |
| --- | --- | --- |
| baseline before this session | 10 | 1063 |
| after deleting `fn_review_step` (`e460752f1`) | **9** | 1018 |
| + the flip (both selection readers on `createMockStore`) | **111** | 916 |
| + flip + write-through `updateStep` | 114 | 913 |

**The flip's cost is 102, not 155.** The predecessor's 155 included the ~25 `fn_review_step`
failures plus ~28 tests that no longer exist. The flip itself was NOT landed — 111 reds violates
the green-at-every-commit rule — and the two selection readers were reverted out of
`executor-test-helpers.ts`. Re-apply them next to `getTaskDocument` in `createMockStore`:

```ts
getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "builtin:coding", stepIds: [] }),
getTaskWorkflowSelection:      vi.fn().mockReturnValue({ workflowId: "builtin:coding", stepIds: [] }),
```

### Post-flip failure classes (measured, 111 reds)

```
 13  moveTask never called with (id, "in-review")      <- ONE seam, diagnosed below
 11  Cannot read properties of undefined ('execute')   <- tool-capture, residual after seam 3
  9  "expected not to be called, but was called"
  8  tools.fn_task_add_dep is not a function           <- tool-capture clobber, more sites
  5  step list [pending] vs [pending,pending,pending]
```

Files: `restart.integration` (many), `executor-task-done-invariant`, `executor-prompt`,
`executor-review-verdicts`, `executor-worktree`, `executor-stuck-requeue-preserve-progress`,
`executor-step-session`.

## THE NEXT UNLOCK — do not re-derive this

**The 13-red `in-review` cluster is one missing harness surface: no merge requester.**

Traced end to end with a probe (temporarily make the harness's `logger.js` mock write to
`console.error` behind an env flag — worth doing again, it is how every finding below was reached):

1. Under graph ownership the in-review handoff **is** the merge boundary:
   `requestMerge` seam → `ensureWorkflowMergeBoundaryTask` → `moveTask(id, mergeNodeColumn)`.
   There is no completion-path `moveTask(id, "in-review")` any more.
2. `requestMerge` returns `merge-unavailable` **before any row mutation** when
   `this.mergeRequester` is unset (`executor.ts` ~6717). These tests build a bare
   `new TaskExecutor(store, root)`, so the graph terminated failed with **zero** `moveTask` calls.
   Production always injects a requester (the work engine wires it), so this is harness absence,
   not the contract under test.
3. Injecting a default `{merged:false, noOp:false, reason:"queued"}` requester moves the failure
   forward to the **implementation-proof gate**
   (`getWorkflowMergeImplementationProofFailure`): `builtin:coding` resolves to
   `BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR`, which `usesParsedSteps`, so it demands
   either all-terminal `task.steps` or a `source:"node"` pre-merge `workflowStepResult`.

**A prototype accessor does NOT work for the requester** — TS class fields define an own
`mergeRequester` (undefined) per instance, shadowing it. Patch `TaskExecutor.prototype.execute` /
`.resumeTaskForAgent` in the harness to call `setMergeRequester(default)` at entry when unset; a
test that sets its own still wins. (Verified: this is what moved the failure to the proof gate.)

**Write-through `updateStep` is necessary but not sufficient.** The step-execute node consults the
projection (`getTask().steps[i].status`), and the mock's `updateStep` was a black hole while
`getTask` replayed only `updateTask` patches — so `steps#N:step-execute` reported
`step N not completed by implementation pass` and terminated the graph. A write-through
`updateStep` fixes that, but on its own (no flip) it costs 1 red in
`executor-task-done-invariant`, so land it WITH the flip, not before. Draft:

```ts
updateStep: vi.fn(async (id, stepIndex, status) => {
  const current = await store.getTask(id);
  const steps = (current?.steps ?? []).map((s, i) => (i === stepIndex ? { ...s, status } : s));
  applyPatch(id, { steps }); return { ...current, steps };
}),
```

**Ruled out, do not repeat:** removing the `### Step 0` heading from the `getTaskDocument`
PROMPT.md stub. It does let the graph reach `merge`, but it also skips the implementation session
entirely (empty foreach), which is the thing most of these tests assert.

## Still open after the flip lands

4. Delete the legacy fallback (`executor.ts` ~5333/5405/5660, `transferPreHeldToLegacy`), making
   `graphCompletion` mandatory → 3 completion boundaries collapse to returns → legacy in-review
   handoff tails → seam maps become explicit params. `executor-preheld-legacy-handoff.test.ts`
   has 2 tests that `delete` both selection methods to reach the fallback; they die with it.
5. Dead statuses. `runPlanReviewBeforeExecution` is already gone (comment references only), but
   `needs-replan` is still WRITTEN in `scheduler.ts` (5 sites), `comments-ops.ts`, and
   `register-task-workflow-routes.ts` (3 sites). This is a real migration, not a sweep — it was
   deliberately NOT attempted at the tail of a session. `legacy-adoption.ts` already maps these
   statuses, so the writers are what must go.
6. Add the newly-tombstoned symbols from step 4/5 to `DELETED_SYMBOLS` in
   `legacy-tombstones.test.ts` as each lands.

## Guardrails (held at every commit this session)

Oracle net 59/59 (`task-pipeline-smoke`, `executor-graph-requeue-gate`,
`workflow-graph-executor-parity`, `executor-graph-boundary`, `merger-trait-rekey`,
`self-healing-trait-rekey`, `workflow-graph-column-moves`); engine-core gate 294/294; engine
typecheck + eslint clean. pg-gate's 3 reds are the known rotating suite-level contention (a
different file set every run, zero assertion failures) and are excluded.
