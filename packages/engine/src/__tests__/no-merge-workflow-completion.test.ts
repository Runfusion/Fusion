import "./executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor.js";
import { resetExecutorMocks } from "./executor-test-helpers.js";
import {
  BUILTIN_WORKFLOWS,
  parseWorkflowIr,
  resolveCompleteColumn,
  resolveMergeOrchestrationColumn,
} from "@fusion/core";
import type { TaskDetail, WorkflowIr } from "@fusion/core";

/*
FNXC:WorkflowNoMergeCompletion 2026-07-19-12:55:
Regression for a card that finishes its whole graph and never reaches its
workflow's `complete` column.

Original symptom: a `builtin:lead-generation` task walked triage -> sourcing ->
qualification -> enrichment -> outreach, the graph reported `completed`, and the
card then sat in `outreach` forever — `converted` (its only `complete`-trait
column) was never entered. Consequence beyond the board: `complete` never became
true for that card, so dependents blocked on it never released either.

Cause: `end` is a graph terminal and never a column destination (KTD-1), so a
card only reaches the complete column when a REAL node lives there. Every
merge-bearing built-in inherits that from `post-merge-verification`; a workflow
with no merge region has nothing there, and both existing movers to the complete
column (merger.completeTask, finalizeProvenAutoMergeTask) are merge-proof-gated.

Fix: `advanceNoMergeWorkflowToCompleteColumn` in executor.ts, on the
`disposition === "completed"` branch, keyed on the merge-orchestration TRAIT.

Surface enumeration (invariant: a completed graph run lands the card in its
workflow's complete column IFF that workflow has no merge region — the merge path
keeps sole ownership otherwise):
 - positive, the shipped no-merge built-in: lead-generation -> `converted`;
 - positive, the CLASS not the repro: a custom no-merge workflow with entirely
   non-default column ids -> its own complete column;
 - negative, every merge-bearing built-in (coding, marketing, brainstorming, and
   the whole catalog by enumeration): the mover must not fire, so the
   done-only-on-confirmed-merge invariant is untouched;
 - no-op, an IR with NO complete-trait column: legal shape, no move, no throw;
 - no-op, the card is already in the complete column;
 - a task with no worktree is normal here, not an error;
 - a rejected move degrades to a warning — a finished run is never failed by
   this bookkeeping.
*/

/** A no-merge workflow with entirely non-default column ids — proves the mover
 *  keys on the traits, not on `done`/`in-review` literals. */
function customNoMergeIr(): WorkflowIr {
  return parseWorkflowIr({
    version: "v2",
    name: "custom-no-merge",
    columns: [
      { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
      { id: "working", name: "Working", traits: [{ trait: "wip" }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      { id: "archived", name: "Archived", traits: [{ trait: "archived" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "inbox" },
      { id: "do-it", kind: "prompt", column: "working", config: { name: "Do it", prompt: "x" } },
      { id: "end", kind: "end", column: "shipped" },
    ],
    edges: [
      { from: "start", to: "do-it", condition: "success" },
      { from: "do-it", to: "end", condition: "success" },
    ],
  } as never);
}

/** Same shape, but with NO complete-trait column at all — a legal IR. */
function noCompleteColumnIr(): WorkflowIr {
  return parseWorkflowIr({
    version: "v2",
    name: "custom-no-complete",
    columns: [
      { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
      { id: "working", name: "Working", traits: [{ trait: "wip" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "inbox" },
      { id: "do-it", kind: "prompt", column: "working", config: { name: "Do it", prompt: "x" } },
      { id: "end", kind: "end", column: "working" },
    ],
    edges: [
      { from: "start", to: "do-it", condition: "success" },
      { from: "do-it", to: "end", condition: "success" },
    ],
  } as never);
}

function builtinIr(id: string): WorkflowIr {
  return parseWorkflowIr(BUILTIN_WORKFLOWS.find((wf) => wf.id === id)!.ir as never);
}

interface Harness {
  executor: TaskExecutor;
  moveTask: ReturnType<typeof vi.fn>;
  recordRunAuditEvent: ReturnType<typeof vi.fn>;
}

function harness(ir: WorkflowIr, options: { moveRejects?: Error } = {}): Harness {
  const moveTask = options.moveRejects
    ? vi.fn().mockRejectedValue(options.moveRejects)
    : vi.fn().mockResolvedValue(undefined);
  const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  const store = {
    on: vi.fn(),
    off: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
    listTasks: vi.fn().mockResolvedValue([]),
    getTaskWorkflowSelection: () => ({ workflowId: "wf", stepIds: [] }),
    getTaskWorkflowSelectionAsync: async () => ({ workflowId: "wf", stepIds: [] }),
    getWorkflowDefinition: async () => ({ ir }),
    moveTask,
    recordRunAuditEvent,
  } as never;
  return { executor: new TaskExecutor(store, "/tmp/test"), moveTask, recordRunAuditEvent };
}

/** A finished card with NO worktree — the normal shape for a no-merge workflow. */
function completedTask(column: string): TaskDetail {
  return { id: "FN-NM", column, worktree: undefined, steps: [] } as unknown as TaskDetail;
}

const advance = (h: Harness, task: TaskDetail) =>
  (h.executor as unknown as {
    advanceNoMergeWorkflowToCompleteColumn(t: TaskDetail): Promise<void>;
  }).advanceNoMergeWorkflowToCompleteColumn(task);

describe("no-merge workflow completion advances to the complete column", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.clearAllMocks();
  });

  it("moves a completed builtin:lead-generation card from `outreach` to `converted`", async () => {
    const ir = builtinIr("builtin:lead-generation");
    // Precondition the fix depends on: no merge region, and `converted` is the
    // complete column with nothing but `end` in it.
    expect(resolveMergeOrchestrationColumn(ir)).toBeUndefined();
    expect(resolveCompleteColumn(ir)).toBe("converted");

    const h = harness(ir);
    await advance(h, completedTask("outreach"));

    expect(h.moveTask).toHaveBeenCalledTimes(1);
    expect(h.moveTask.mock.calls[0]![0]).toBe("FN-NM");
    expect(h.moveTask.mock.calls[0]![1]).toBe("converted");
    expect(h.moveTask.mock.calls[0]![2]).toMatchObject({
      moveSource: "engine",
      workflowMoveSource: "workflow-graph",
      preserveProgress: true,
    });
  });

  it("emits an ids/outcomes-only run-audit event for the advance", async () => {
    const h = harness(builtinIr("builtin:lead-generation"));
    await advance(h, completedTask("outreach"));

    expect(h.recordRunAuditEvent).toHaveBeenCalledTimes(1);
    const event = h.recordRunAuditEvent.mock.calls[0]![0];
    expect(event.mutationType).toBe("task:workflow-complete-column-advanced");
    expect(event.metadata).toEqual({
      taskId: "FN-NM",
      fromColumn: "outreach",
      toColumn: "converted",
      reason: "no-merge-workflow-completed",
    });
    // No prose, no node/run internals — ids, columns, and a fixed reason only.
    expect(Object.keys(event.metadata).sort()).toEqual(["fromColumn", "reason", "taskId", "toColumn"]);
  });

  it("moves a CUSTOM no-merge workflow to its own complete column (the class, not the repro)", async () => {
    const h = harness(customNoMergeIr());
    await advance(h, completedTask("working"));
    expect(h.moveTask.mock.calls[0]![1]).toBe("shipped");
  });

  it("does not require a worktree", async () => {
    const h = harness(customNoMergeIr());
    const task = completedTask("working");
    expect((task as { worktree?: string }).worktree).toBeUndefined();
    await expect(advance(h, task)).resolves.toBeUndefined();
    expect(h.moveTask).toHaveBeenCalledTimes(1);
  });
});

describe("the mover is inert for every merge-bearing workflow", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.clearAllMocks();
  });

  /*
  These workflows DO reach their complete column — via the merge path and their
  `post-merge-verification` node, asserted end to end in
  builtin-workflows-lifecycle.test.ts. What must hold HERE is that this mover
  takes no part in it, so `done` still requires a confirmed merge.
  */
  const mergeBearing = BUILTIN_WORKFLOWS.map((wf) => wf.id).filter(
    (id) => resolveMergeOrchestrationColumn(builtinIr(id)) !== undefined,
  );

  it("covers the merge-bearing built-ins including coding, marketing and brainstorming", () => {
    expect(mergeBearing).toContain("builtin:coding");
    expect(mergeBearing).toContain("builtin:marketing");
    expect(mergeBearing).toContain("builtin:brainstorming");
  });

  for (const id of BUILTIN_WORKFLOWS.map((wf) => wf.id)) {
    const ir = builtinIr(id);
    const hasMerge = resolveMergeOrchestrationColumn(ir) !== undefined;
    if (!hasMerge) continue;
    it(`${id}: a completed run does not trigger the no-merge mover`, async () => {
      const h = harness(ir);
      // Sit the card one column short of complete — the exact position where a
      // careless mover would "helpfully" finish the job without merge proof.
      const complete = resolveCompleteColumn(ir)!;
      const columns = (ir.version === "v2" ? ir.columns : []).map((c) => c.id);
      const before = columns[Math.max(0, columns.indexOf(complete) - 1)]!;
      await advance(h, completedTask(before));
      expect(h.moveTask).not.toHaveBeenCalled();
      expect(h.recordRunAuditEvent).not.toHaveBeenCalled();
    });
  }
});

describe("no-op and degradation cases", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.clearAllMocks();
  });

  it("an IR with no complete-trait column is a legal shape: no move, no throw", async () => {
    const ir = noCompleteColumnIr();
    expect(resolveCompleteColumn(ir)).toBeUndefined();
    const h = harness(ir);
    await expect(advance(h, completedTask("working"))).resolves.toBeUndefined();
    expect(h.moveTask).not.toHaveBeenCalled();
  });

  it("a card already in the complete column is left alone", async () => {
    const h = harness(customNoMergeIr());
    await advance(h, completedTask("shipped"));
    expect(h.moveTask).not.toHaveBeenCalled();
    expect(h.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("a rejected move warns instead of failing the finished run", async () => {
    const h = harness(customNoMergeIr(), { moveRejects: new Error("Invalid transition") });
    await expect(advance(h, completedTask("working"))).resolves.toBeUndefined();
    // The audit event is NOT emitted for a move that did not happen.
    expect(h.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("an unresolvable workflow degrades to a no-op", async () => {
    const store = {
      on: vi.fn(),
      off: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({}),
      listTasks: vi.fn().mockResolvedValue([]),
      getTaskWorkflowSelectionAsync: async () => {
        throw new Error("selection read failed");
      },
      getWorkflowDefinition: async () => {
        throw new Error("definition read failed");
      },
      moveTask: vi.fn(),
    } as never;
    const executor = new TaskExecutor(store, "/tmp/test");
    await expect(
      (executor as unknown as {
        advanceNoMergeWorkflowToCompleteColumn(t: TaskDetail): Promise<void>;
      }).advanceNoMergeWorkflowToCompleteColumn(completedTask("working")),
    ).resolves.toBeUndefined();
  });
});
