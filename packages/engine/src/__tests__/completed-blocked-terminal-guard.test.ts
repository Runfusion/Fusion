/*
FNXC:WorkflowLifecycleColumns 2026-07-31-20:25 (live on main):

THE INVARIANT: "is this card already finished?" is answered from the task's own workflow, so a completed
card is never rebounded out of its complete or archived lane.

WHY INERT IS WORSE THAN WRONG HERE. `parkCompletedBlockedTask` opened with a literal
`task.column === "done" || task.column === "archived"`. On a renamed board neither matches, so the guard
did nothing — and the very next block rebounds the card to its planning lane. So a COMPLETED card sitting
in a renamed complete/archived column was moved BACKWARDS out of it.

THE PAIR IS WHAT MADE IT DANGEROUS, and it is why this survived two PRs. #2644 converted the rebound half
to resolve its target by role; this terminal half stayed a literal. A role-resolved rebound behind a
name-matched guard means the renamed board takes the rebound and never the guard — the same
half-conversion shape as the evacuation branch, except the halves were owned by different changes, so
neither review saw both.

The fix exists in #2568 but is stranded four deep in a stack whose bottom (#2544) has not merged, so it is
re-landed directly against main here. Noted on that PR so its author can drop the hunk rather than
resolve it twice.
*/
import { describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore } from "./executor-test-helpers.js";
import type { WorkflowIr } from "@fusion/core";

/** Standard traits under non-default names: `shipped` is complete, `attic` is archived. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "queued", name: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "attic", name: "Attic", traits: [{ trait: "archived" }] },
  ],
} as unknown as WorkflowIr;

function completedTaskIn(column: string) {
  return {
    id: "FN-DONE",
    title: "completed work",
    description: "",
    column,
    worktree: "/repo/.worktrees/done",
    branch: "fusion/fn-done",
    steps: [{ name: "Implement", status: "done" as const }],
    currentStep: 0,
    dependencies: [],
    log: [],
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
  };
}

function harness(ir: WorkflowIr | undefined, column: string) {
  const store = createMockStore();
  let task: Record<string, unknown> = completedTaskIn(column);
  const moves: Array<[string, string]> = [];
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  const widened = store as unknown as Record<string, unknown>;
  widened.getTaskWorkflowSelection = () => (ir ? selection : undefined);
  widened.getTaskWorkflowSelectionAsync = async () => (ir ? selection : undefined);
  widened.getWorkflowDefinition = async () => (ir ? { id: "wf-renamed", ir } : undefined);

  store.getTask.mockImplementation(async () => ({ ...task }));
  store.updateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => {
    task = { ...task, ...updates };
    return task;
  });
  store.moveTask.mockImplementation(async (id: string, to: string) => {
    moves.push([id, to]);
    task = { ...task, column: to };
    return { ...task };
  });
  store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);

  const executor = new TaskExecutor(store as never, "/repo");
  const park = (t: Record<string, unknown>) =>
    (executor as unknown as {
      parkCompletedBlockedTask: (task: unknown, blocker: string, source: string, workComplete?: boolean) => Promise<boolean>;
    }).parkCompletedBlockedTask(t, "unmet dependency FN-OTHER", "test", true);

  return { store, moves, park };
}

describe("a completed card is never rebounded out of its own terminal lane", () => {
  it("refuses to park a card in the renamed COMPLETE column", async () => {
    // Pre-fix: the literal guard missed `shipped`, and the next block moved this finished card to `queued`.
    const h = harness(RENAMED_IR, "shipped");

    await expect(h.park(completedTaskIn("shipped"))).resolves.toBe(false);
    expect(h.moves).toEqual([]);
  });

  it("refuses to park a card in the renamed ARCHIVED column", async () => {
    const h = harness(RENAMED_IR, "attic");

    await expect(h.park(completedTaskIn("attic"))).resolves.toBe(false);
    expect(h.moves).toEqual([]);
  });

  it("STILL parks a completed-blocked card that is genuinely mid-pipeline", async () => {
    // The paired positive: "never park" must not be able to pass for "resolve the terminal lanes".
    const h = harness(RENAMED_IR, "building");

    await expect(h.park(completedTaskIn("building"))).resolves.toBe(true);
    expect(h.moves).toEqual([["FN-DONE", "queued"]]);
  });

  it("keeps the legacy pair when the workflow cannot be resolved", async () => {
    const h = harness(undefined, "done");

    await expect(h.park(completedTaskIn("done"))).resolves.toBe(false);
    expect(h.moves).toEqual([]);
  });

  it("does NOT treat an unclassifiable column as terminal", async () => {
    /*
    Being unable to prove a card is finished must not be the same as proving it is. A card in a column this
    workflow does not declare still gets the park, which is the behaviour that keeps stranded cards moving.
    */
    const h = harness(RENAMED_IR, "some-column-this-board-lacks");

    await expect(h.park(completedTaskIn("some-column-this-board-lacks"))).resolves.toBe(true);
  });
});
