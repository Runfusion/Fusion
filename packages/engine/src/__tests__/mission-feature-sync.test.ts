import { describe, expect, it } from "vitest";
import { reconcileMissionFeatureState } from "../mission-feature-sync.js";

describe("reconcileMissionFeatureState", () => {
  it("keeps assertion validation as the completion gate for research-derived features", async () => {
    const decision = await reconcileMissionFeatureState(
      { getTask: async () => undefined } as never,
      { id: "FN-1", column: "done", status: "completed" } as never,
      { id: "F-1", status: "in-progress", lastValidatorStatus: "failed" } as never,
      { hasLinkedAssertions: true },
    );
    expect(decision).toEqual(expect.objectContaining({ kind: "noop" }));
  });

  it("reconciles return and active board states without fabricating completion", async () => {
    const taskStore = { getTask: async () => undefined } as never;
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "todo", status: "pending" } as never, { id: "F-1", status: "in-progress" } as never)).resolves.toMatchObject({ kind: "update", status: "triaged" });
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "triage" } as never, { id: "F-1", status: "in-progress" } as never)).resolves.toMatchObject({ kind: "update", status: "triaged" });
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "in-review", status: "in-progress" } as never, { id: "F-1", status: "triaged" } as never)).resolves.toMatchObject({ kind: "update", status: "in-progress" });
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "in-progress" } as never, { id: "F-1", status: "defined" } as never)).resolves.toMatchObject({ kind: "update", status: "in-progress" });
  });

  it("keeps archived and failed task outcomes as idempotent non-completion", async () => {
    const taskStore = { getTask: async () => undefined } as never;
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "archived" } as never, { id: "F-1", status: "in-progress" } as never)).resolves.toEqual({ kind: "noop" });
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "todo", status: "failed", error: "BLOCKED" } as never, { id: "F-1", status: "triaged" } as never)).resolves.toMatchObject({ kind: "failure" });
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-08:50 (triage-guard census):
"The task went back to a pre-implementation lane" is a lifecycle ROLE. Naming `triage`/`todo`
literally meant a workflow that renames either one stopped rolling its mission feature back — the
feature stayed `in-progress` while the task was queued for re-planning, so the roadmap reported
work in flight that nobody was doing. Silent, and only visible to whoever reads the mission board.
*/
describe("mission feature rollback resolves the planner lane from the task's workflow", () => {
  const WF = "custom:renamed";
  const renamedIr = {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", label: "Inbox", traits: [{ trait: "intake" }] },
      { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
    ],
  };
  const renamedStore = {
    getTask: async () => undefined,
    getTaskWorkflowSelection: () => ({ workflowId: WF, stepIds: [] }),
    getTaskWorkflowSelectionAsync: async () => ({ workflowId: WF, stepIds: [] }),
    getWorkflowDefinition: async () => ({ id: WF, ir: renamedIr }),
  } as never;

  it("rolls back for a RENAMED hold column", async () => {
    await expect(reconcileMissionFeatureState(
      renamedStore,
      { id: "FN-1", column: "drafting" } as never,
      { id: "F-1", status: "in-progress" } as never,
    )).resolves.toMatchObject({ kind: "update", status: "triaged" });
  });

  it("rolls back for a RENAMED intake column", async () => {
    await expect(reconcileMissionFeatureState(
      renamedStore,
      { id: "FN-1", column: "inbox" } as never,
      { id: "F-1", status: "in-progress" } as never,
    )).resolves.toMatchObject({ kind: "update", status: "triaged" });
  });

  it("does NOT roll back from that workflow's implementation column", async () => {
    /* The guard must stay narrow — rolling back mid-implementation would erase real progress. */
    await expect(reconcileMissionFeatureState(
      renamedStore,
      { id: "FN-1", column: "building" } as never,
      { id: "F-1", status: "in-progress" } as never,
    )).resolves.toMatchObject({ kind: "noop" });
  });
});
