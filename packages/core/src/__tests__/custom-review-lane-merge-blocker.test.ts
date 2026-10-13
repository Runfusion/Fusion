import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
} from "../__test-utils__/pg-test-harness.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import type { TaskStore, WorkflowStepResult } from "../types.js";

/*
FNXC:WorkflowTransitionPolicy 2026-07-19-10:50:
Regression for the re-hardcoded review lane in the KTD-5 merge-blocker invariant
(PR #2335 review). moveTaskInternal resolved `getTaskMergeBlocker(task)` for
EVERY non-bypassed move into a `complete` column, but that helper hard-rejects
any source column that is not literally "in-review". Two legal edges broke:
 - six-column benchmark shape: merging → done (custom review pipeline; the
   merge-blocker trait lives on in-review, NOT on merging), and
 - builtin:coding in-progress → done (the mission-validation cross edge that
   legacy flag-OFF allowed unchecked — its blocker gate was literally
   `fromColumn === "in-review"`).
The fix keys blocker resolution on the SOURCE column's `mergeBlocker` trait
flag (the workflow's actual review-lane identity) and neutralizes the helper's
column-identity precondition, keeping only its content checks.

Surface enumeration (invariant: the merge blocker fires on complete-bound exits
from a merge-blocker column, and ONLY there):
 - Custom workflow, non-merge-blocker source into complete: merging → done allowed.
 - Builtin cross edge, non-merge-blocker source into complete: in-progress → done allowed.
 - Builtin merge-blocker source into complete with unmet content checks:
   in-review → done with incomplete steps still rejects.

/*
FNXC:CompleteColumnGateEvidence 2026-10-11-20:48 (RUFU-406):
The cross-edge case above is the merge-BLOCKER half of the completion boundary. RUFU-406 added a
second, orthogonal door on every move into a `complete` column: the required pre-merge gate-EVIDENCE
check, which fires whatever the source column's traits are — including this `in-progress → done`
edge, where the merge blocker is skipped entirely and the evidence check is therefore the ONLY door.
That is the RUFU-389 shape. So this fixture now carries approving `plan-review` + `code-review`
evidence, which is the intent it always implicitly assumed: it exists to prove the merge blocker does
NOT refuse this edge, not to prove a gateless card may be completed. The refusal of the gateless
shape is pinned as its own case below, so both doors stay covered on the same edge.
*/

/** Minimal six-column-benchmark-shaped IR: custom `merging` column between the
 *  merge-blocker review lane and the complete `done` column. */
function sixColumnShapedIr(): WorkflowIr {
  return {
    version: "v2",
    name: "test:six-column-shape",
    columns: [
      { id: "ideas", name: "Ideas", traits: [{ trait: "intake" }] },
      {
        id: "todo",
        name: "Todo",
        traits: [{ trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }],
      },
      {
        id: "in-progress",
        name: "In-progress",
        traits: [
          { trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } },
          { trait: "abort-on-exit" },
          { trait: "timing" },
        ],
      },
      {
        id: "in-review",
        name: "In-review",
        traits: [{ trait: "merge-blocker" }, { trait: "stall-detection" }],
      },
      { id: "merging", name: "Merging", traits: [{ trait: "merge" }, { trait: "human-review" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "ideas" },
      { id: "triage", kind: "prompt", column: "todo", config: { name: "Triage", prompt: "Specify." } },
      { id: "implement", kind: "prompt", column: "in-progress", config: { name: "Implement", prompt: "Do it." } },
      { id: "review", kind: "prompt", column: "in-review", config: { name: "Review", prompt: "Review it." } },
      { id: "merge-attempt", kind: "merge-attempt", column: "merging", config: { capability: "task-merge" } },
      { id: "finalize", kind: "notify", column: "done", config: { name: "Announce done", event: "task.completed" } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "triage" },
      { from: "triage", to: "implement", condition: "success" },
      { from: "implement", to: "review", condition: "success" },
      { from: "review", to: "merge-attempt", condition: "success" },
      { from: "merge-attempt", to: "finalize", condition: "success" },
      { from: "finalize", to: "end", condition: "success" },
    ],
  } as WorkflowIr;
}

pgDescribe("merge-blocker keys on the workflow's review lane, not a hardcoded 'in-review'", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_review_lane" });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  /*
  FNXC:WorkflowTransitionPolicy 2026-07-19-11:05:
  The KTD-5 invariant block under test only runs on the flag-ON workflow path
  (isWorkflowColumnsCompatibilityFlagEnabled reads the RAW experimental flag,
  not the post-cutover "stale false counts as on" helper). Without this the
  suite silently exercises the flag-OFF legacy path and cannot catch the bug.
  */
  beforeEach(async () => {
    await harness.store().updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
  });

  /** Give a card the built-in's required pre-merge gates as approving evidence, so a case that
   *  exercises the merge-blocker half is not first refused by the gate-evidence door (RUFU-406). */
  async function approveRequiredGates(store: TaskStore, taskId: string): Promise<void> {
    const rows: WorkflowStepResult[] = ["plan-review", "code-review"].map((id) => ({
      workflowStepId: id,
      workflowStepName: id === "plan-review" ? "Plan Review" : "Code Review",
      phase: "pre-merge" as const,
      status: "passed" as const,
      verdict: "APPROVE" as const,
      reviewInputFingerprint: `sha256:${id}-fingerprint`,
      completedAt: "2026-10-11T00:00:00.000Z",
    }));
    await store.updateTask(taskId, { workflowStepResults: rows });
  }

  /** Force a task's column directly (bypassing move guards) so a single move
   *  edge can be exercised in isolation. Columnar tasks table (PG cutover). */
  async function forceColumn(taskId: string, column: string): Promise<void> {
    const store = harness.store();
    const layer = store.getAsyncLayer();
    if (!layer) throw new Error("expected async layer in backend mode");
    const { project } = await import("../postgres/schema/index.js");
    await layer.db.update(project.tasks).set({ column }).where(eq(project.tasks.id, taskId));
  }

  it("allows a non-bypassed user move merging → done in a six-column-shaped workflow", async () => {
    const store = harness.store();
    const def = await store.createWorkflowDefinition({ name: "Six Column Shape", ir: sixColumnShapedIr() });
    const task = await store.createTask({ description: "benchmark card", workflowId: def.id });
    expect(task.column).toBe("ideas");

    await forceColumn(task.id, "merging");
    const moved = await store.moveTask(task.id, "done", { moveSource: "user" });
    expect(moved.column).toBe("done");
  });

  it("allows the builtin in-progress → done mission-validation cross edge for user moves", async () => {
    const store = harness.store();
    // Explicit workflowId writes a selection row, so the move preflight and the
    // in-lock move resolve the SAME catalog IR (a task with no selection hits a
    // pre-existing catalog-vs-const signature mismatch unrelated to this test).
    const task = await store.createTask({ description: "mission validation card", workflowId: "builtin:coding" });
    // RUFU-406: this card owes the built-in's required pre-merge gates, and the evidence door is the
    // only door on this edge. Carry the evidence so the assertion below stays about the merge blocker.
    await approveRequiredGates(store, task.id);

    await forceColumn(task.id, "in-progress");
    const moved = await store.moveTask(task.id, "done", { moveSource: "user" });
    expect(moved.column).toBe("done");
  });

  /*
  FNXC:CompleteColumnGateEvidence 2026-10-11-20:48 (RUFU-406):
  The paired refusal on the SAME edge. Before RUFU-406 this move succeeded with zero gate rows,
  because the merge-blocker invariant consults `getTaskMergeBlocker` only when the SOURCE column
  carries the `mergeBlocker` trait — so `in-progress → done` never read the evidence authority at
  all. The refusal is the fix: a card with no approving gate row cannot be hand-completed from its
  execution lane either, over any transport.
  */
  it("refuses that same cross edge when the card carries no gate evidence, which is the RUFU-389 shape", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "gateless mission validation card", workflowId: "builtin:coding" });

    await forceColumn(task.id, "in-progress");
    await expect(store.moveTask(task.id, "done", { moveSource: "user" })).rejects.toThrow(
      /Required workflow gate evidence is missing for: code-review/,
    );
    expect((await store.getTask(task.id))?.column).toBe("in-progress");
  });

  it("still rejects in-review → done when the merge-blocker content checks fail", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "blocked card", workflowId: "builtin:coding" });
    await store.updateTask(task.id, { steps: [{ name: "step 1", status: "pending" }] });

    await forceColumn(task.id, "in-review");
    await expect(store.moveTask(task.id, "done", { moveSource: "user" })).rejects.toThrow(
      /incomplete steps/,
    );
  });
});
