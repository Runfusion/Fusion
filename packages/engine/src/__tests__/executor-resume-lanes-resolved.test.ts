/*
FNXC:WorkflowLifecycleColumns 2026-07-30-21:10 (Phase C convergence — resume eligibility):

THE INVARIANT: the columns a paused-node RESUME may start from are the task's own hold, wip and
review lanes.

Four literal comparisons decided that one question and had to agree with each other:
`preservedInReview`, the audit `mode` label, the resume-safety recheck inside the retry callback,
and the branch choosing `execute()` versus `executeWorkflowGraph()`. On a renamed board
`preservedInReview` was false for a card sitting in review AND the recheck rejected it, so the
paused-node re-entry silently never happened — an engine pause/resume left the card parked with
nothing to resume it.

OFF THE `triage` BAR, deliberately: these are `in-review`/`in-progress`/`todo` guards. Same defect
class, different literals; recorded here so the next sweep of that class has a worked example and a
shared resolver to reuse.
*/
import { describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore } from "./executor-test-helpers.js";
import type { WorkflowIr } from "@fusion/core";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "queued", name: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

function harness(ir: WorkflowIr | undefined) {
  const store = createMockStore();
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  const widened = store as unknown as Record<string, unknown>;
  widened.getTaskWorkflowSelection = () => (ir ? selection : undefined);
  widened.getTaskWorkflowSelectionAsync = async () => (ir ? selection : undefined);
  widened.getWorkflowDefinition = async () => (ir ? { ir } : undefined);
  store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);

  const executor = new TaskExecutor(store as never, "/repo");
  const lanes = (taskId: string) =>
    (executor as unknown as {
      resolveResumeLanes: (id: string) => Promise<{ hold: string; wip: string; review: string }>;
    }).resolveResumeLanes(taskId);

  return { store, executor, lanes };
}

describe("resume lanes come from the task's own workflow", () => {
  it("resolves the renamed hold, wip and review columns", async () => {
    // Pre-fix these three were the default lineage's names, so every resume-safety comparison on a
    // renamed board answered "not a safe resume state" and the re-entry never fired.
    const h = harness(RENAMED_IR);

    await expect(h.lanes("FN-1")).resolves.toEqual({
      hold: "queued",
      wip: "building",
      review: "checking",
    });
  });

  it("falls back to the legacy trio when no workflow resolves", async () => {
    // A v1 / column-less workflow has no vocabulary to read, so the legacy names ARE the answer
    // and the default lineage behaves exactly as before.
    const h = harness(undefined);

    await expect(h.lanes("FN-1")).resolves.toEqual({
      hold: "todo",
      wip: "in-progress",
      review: "in-review",
    });
  });

  it("never throws, so a resume decision is never blocked on IR resolution", async () => {
    // The re-entry path runs inside a retry callback; a throw here would strand the card silently.
    const h = harness(RENAMED_IR);
    (h.store as unknown as Record<string, unknown>).getWorkflowDefinition = async () => {
      throw new Error("workflow store unavailable");
    };

    await expect(h.lanes("FN-1")).resolves.toEqual({
      hold: "todo",
      wip: "in-progress",
      review: "in-review",
    });
  });
});
