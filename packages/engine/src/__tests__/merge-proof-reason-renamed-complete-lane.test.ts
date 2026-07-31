/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:40:
THE MERGE-REFUSAL REASON WAS CLASSIFIED BY A COLUMN ID.

`validateWorkflowDoneMergeProof` picks between two refusal reasons with
`task.column === "done"`. Both arms return `{ ok: false }`, so this never changed WHICH branch ran —
which is why an earlier audit recorded it as "diagnostic only" and declined it.

That undersold it. The reason is not a log line: it is written to run-audit metadata alongside
`previousColumn`, and that record is what an operator reads to find out why a merge was refused. On a
board whose complete lane is not called `done`, a card sitting in that lane was refused with the
generic `missing-merge-confirmation` — the classification for a card that is NOT in the complete lane
at all. The audit trail said the opposite of what happened.

Driven through `finalizeProvenAutoMergeTask` rather than by calling the validator with the new
argument, because the contract this pins is the WIRING: the caller already resolves
`isCompleteColumn` for its own guard one line earlier, and the defect was that it did not hand that
answer down. A test that passed the argument directly would assert my own parameter works and prove
nothing about the seam.
*/

import { describe, expect, it, vi } from "vitest";
import type { MergeResult, Task, TaskStore, WorkflowIr } from "@fusion/core";
import { finalizeProvenAutoMergeTask } from "../auto-merge-finalization.js";

/** Complete lane is `shipped`; the board declares no column called `done`. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "drafting", name: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

/** A card resting in a completion lane with NO durable merge proof — the refused case. */
function completedWithoutProof(column: string): Task {
  return {
    id: "FN-NOPROOF",
    title: "landed without proof",
    description: "t",
    column,
    dependencies: [],
    steps: [{ status: "done" }],
    currentStep: 0,
    log: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    mergeDetails: { mergeConfirmed: false, noOpMerge: true },
  } as unknown as Task;
}

function storeFor(task: Task, ir?: WorkflowIr) {
  const recordRunAuditEvent = vi.fn(async () => undefined);
  const store = {
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async () => task),
    moveTask: vi.fn(async () => task),
    logEntry: vi.fn(async () => undefined),
    getSettings: vi.fn(async () => ({})),
    recordRunAuditEvent,
    /* Absent → the resolver's documented degraded fallback, i.e. the legacy `done` answer. */
    ...(ir
      ? {
        getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "wf-renamed", stepIds: [] })),
        getWorkflowDefinition: vi.fn(async () => ({ id: "wf-renamed", ir })),
      }
      : {}),
  } as unknown as TaskStore;
  return { store, recordRunAuditEvent };
}

async function finalize(task: Task, ir?: WorkflowIr) {
  const { store, recordRunAuditEvent } = storeFor(task, ir);
  const result = await finalizeProvenAutoMergeTask({
    store,
    taskId: task.id,
    result: { task, ok: true, merged: true, noOp: true } as unknown as MergeResult,
    source: "workflow-graph-merge-finalize",
  });
  return { result, recordRunAuditEvent };
}

describe("the merge-proof refusal reason names the board's own complete lane", () => {
  /*
  CONTROL. A default board answers `column === "done"` either way, so this passes with or without
  the fix — it is here so a failure below means "renamed board", not "the refusal stopped working".
  */
  it("classifies a proof-less card in the legacy `done` column (control)", async () => {
    const { result } = await finalize(completedWithoutProof("done"));

    expect(result).toEqual(expect.objectContaining({
      outcome: "blocked", reason: "done-without-merge-confirmation",
    }));
  });

  it("classifies a proof-less card in a RENAMED complete lane the same way", async () => {
    const { result, recordRunAuditEvent } = await finalize(completedWithoutProof("shipped"), RENAMED_IR);

    /* Against the literal this was `missing-merge-confirmation` — the classification for a card that
       is not in the complete lane at all, which is the opposite of what happened. */
    expect(result).toEqual(expect.objectContaining({
      outcome: "blocked", reason: "done-without-merge-confirmation",
    }));

    /* The audit row is the artifact an operator actually reads; the return value alone is not the
       contract that was broken. */
    expect(recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ previousColumn: "shipped", reason: "done-without-merge-confirmation" }),
    }));
  });
});
