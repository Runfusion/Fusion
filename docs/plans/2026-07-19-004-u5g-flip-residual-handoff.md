---
title: "U5g remainder — the flip, now costing 164 instead of 257"
type: handoff
status: ready
date: 2026-07-19
parent_plan: docs/plans/2026-07-18-001-refactor-ir-driven-lifecycle-cutover-plan.md
supersedes: docs/plans/2026-07-19-003-u5f-workflow-aware-flip-handoff.md
---

# U5g remainder — five seams closed, one folded deletion landed, the flip still open

## What U5g landed

**`29fe4b91c` — the probe. The U5f prediction held: both dominant clusters were
ONE missing harness surface each.**

| | failed | passed |
| --- | --- | --- |
| flip only (U5f's measurement, reproduced exactly) | 269 | 806 |
| flip + the seam fixes | **174** | 901 |
| the seam fixes, NO flip | **10** | 1065 |

The last row is why the commit was safe to land alone: identical to `a7432a338`'s
baseline by failing-test **NAME**, not merely by count. **The flip's remaining cost is
164, not 257.**

**`d0bf24ec9` — U10-pt1**, folded in per the coordinator: parity-observer chain,
`WorkflowAuthoritativeDriver` + `workflowAuthoritativeDispatch`, and
`workflow-cutover.ts`, ~1060 lines. `workflow-parity.ts` stays (live via `store.ts` and
`remaining-ops-7.ts`).

## The three seams — do not re-derive these

1. **`getTaskDocument` on `createMockStore` (59 failures).** The `Cannot read properties
   of undefined (reading 'execute')` cluster was **not** a session problem, and not the
   tool-capture problem it looks like. The builtin coding graph parses PROMPT.md into
   task steps at its `parse` node *before* the implementation node, and
   `readTaskArtifact` (executor.ts) resolves that artifact as
   `getTaskDocument(id,"PROMPT.md")` first, falling back to `getTask().prompt`. ~10 files
   install their own `store.getTask` returning a literal with **no `prompt`**, so the read
   returned undefined → `parse` failed `parse-error` → **the graph terminated before any
   agent session existed**, which is why the captured `fn_task_done` tool was null.
   `getTaskDocument` is overridden nowhere on this surface, so one stub fixed every file.
2. **Write-through task state (41 failures, `no-worktree-for-write-node`).** `updateTask`
   was a black hole and `getTask` a frozen literal. The graph's write-capable-node guard
   re-reads the row (`executionTarget = await this.store.getTask(live.id)`) precisely so
   it cannot trust a stale in-memory copy, then rejected because the literal had no
   worktree. `updateTask` now records patches and `getTask` replays them.
3. **Tool-capture clobber (11 sites, 9 files).** `doneTool = customTools.find(...)` ran on
   *every* session creation, so the workflow-step session (no `fn_task_done`) overwrote it
   with undefined. Now `?? <prev>`.

### Two levers the earlier handoffs got WRONG — corrected here (`c1c9629cb`)

Both were previously recorded as ruled out. Both are real; the earlier verdicts were
measurement artifacts. **Do not re-revert them.**

4. **Default APPROVE verdict for review sessions.** 29fe4b91c recorded this as "net zero,
   reverted". Wrong: the run-level count did not move because a downstream blocker
   dominated, but the seam is real and directly observable — the probe goes from
   `[pre-merge] Advisory workflow step failed: Plan Review` to
   `[pre-merge] Workflow step completed: Plan Review`. Aggregate counts mask per-layer
   progress; check the probe log, not just the total.
5. **`enabledWorkflowSteps: []` — WHERE you set it decides everything.** U5f ruled this out
   after setting it on the inline task literals passed to `execute()`, where it provably
   does nothing (re-confirmed: `executor-prompt` stayed at 25). On the **store's default
   task** it works — the graph re-reads the row rather than trusting the passed object,
   the same re-read that made seam 2 necessary. `executor-prompt` 25 → 16, surface
   174 → **155**.

   This one also explains the whole failure *shape*: these legacy-shaped stubs assume the
   FIRST session is the implementation session. Under graph ownership the first session is
   Plan Review, so every stub side effect (pausing, disposing, triggering store events)
   fired against the wrong session.

Still genuinely ruled out: nothing else. The "shared session-completes default" hypothesis
from the previous revision is **answered NO** — stubs define their own `prompt`, so the
harness cannot make them call `fn_task_done` without overriding behavior tests assert.
The remaining `Agent finished without calling fn_task_done` runs are real per-test work.

## Then the unlock (unchanged)

`maybeExecuteWorkflowGraph`'s fallback is `executor.ts:5459-5495` (the
`typeof this.store.getTaskWorkflowSelection* !== "function"` block ending
`transferPreHeldToLegacy = true; return false;`). Deleting it makes `graphCompletion`
mandatory → 3 completion boundaries collapse to plain returns → legacy in-review tails,
all remaining `fn_review_step` sites, and the seam maps follow.

`executor-preheld-legacy-handoff.test.ts` still has 2 tests that `delete` both selection
methods to reach the fallback; they die with it. (Its other 2 authoritative-dispatch tests
were already removed in `d0bf24ec9`.)

## Method

```bash
cd packages/engine
grep -rln "createMockStore" src/__tests__/ | sort > /tmp/m.txt
grep -rln "\.execute(\|resumeTaskForAgent" src/__tests__/ | sort > /tmp/e.txt
comm -12 /tmp/m.txt /tmp/e.txt > /tmp/files_affected.txt   # 40 files
pnpm exec vitest run $(cat /tmp/files_affected.txt | tr '\n' ' ') --silent=passed-only --reporter=dot
```
Background it (~5 min; a foreground 2-minute cap kills it mid-run and the partial file
reads as "still running"). Compare failing test **names**, not counts.

## Guardrails

Oracle net 59/59 and engine-core gate 294/294 at every commit; final execute()-surface
reds ≤ the 10-red baseline. pg-gate reds are pre-existing rotating suite-level contention —
a different file set every run (3, then 5, then 6 across this session) with **zero**
assertion failures. Excluded; do not chase or appease. Every new `index.ts` export mirrors
into `index.gate.ts`.
