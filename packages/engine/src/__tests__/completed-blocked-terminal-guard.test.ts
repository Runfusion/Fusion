/*
FNXC:WorkflowLifecycleColumns 2026-07-30-08:25 (live on main):

THE INVARIANT: "is this card already finished?" is answered from the task's own workflow, so a completed
card is never rebounded out of its complete lane.

WHY INERT IS WORSE THAN WRONG HERE. `parkCompletedBlockedTask` opened with a literal
a literal `task.column === "done"` check. On a renamed board it does not match, so the guard
did nothing — and the very next block rebounds the card to its planning lane. So a COMPLETED card sitting
in a renamed complete column was moved BACKWARDS out of it.

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

/** Standard traits under non-default names: `shipped` is complete. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "queued", name: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
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

function harness(ir: WorkflowIr | undefined, column: string, gate?: Promise<void>) {
  const store = createMockStore();
  let task: Record<string, unknown> = completedTaskIn(column);
  const moves: Array<[string, string]> = [];
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  const widened = store as unknown as Record<string, unknown>;
  widened.getTaskWorkflowSelection = () => (ir ? selection : undefined);
  widened.getTaskWorkflowSelectionAsync = async () => (ir ? selection : undefined);
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-09:15 (#2670 review):
  `gate` holds workflow resolution open so a test can change the STORED card while the
  resolution is still pending. Without it every await in this file settles immediately,
  and the post-await re-read of the task is unreachable — a test can only observe the
  column it started with, which is what let the re-read look covered when it was not.
  */
  widened.getWorkflowDefinition = async () => {
    if (gate) await gate;
    return ir ? { id: "wf-renamed", ir } : undefined;
  };

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

  /** Mutates the STORED card only — the caller keeps its own stale copy, as the real caller does. */
  const setStoredColumn = (to: string) => { task = { ...task, column: to }; };

  return { store, moves, park, setStoredColumn };
}

describe("the terminal guard covers the Complete role and refuses to guess", () => {
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-08:40 (reduced after #2568's fix landed on main):

  MAIN'S FIX IS BETTER THAN MINE AND SHIPPED FIRST, so the implementation here is main's: it routes through
  core's shared `resolveTerminalColumns` (which owns the per-role fallback) and re-reads the task after the
  await, which my version did not do — an operator pause landing during the resolution would have been
  overwritten.

  What survives is the coverage main's fixture does NOT reach. Its renamed workflow declares `complete` and
  no `archived` column, and `resolve-terminal-columns.test.ts` covers the resolver in isolation, so these two
  cases sit in between: the ARCHIVED role resolved through the executor path, and the refusal to treat an
  unclassifiable column as terminal.
  */
  it("refuses to park a card in the renamed Complete column", async () => {
    const h = harness(RENAMED_IR, "shipped");

    await expect(h.park(completedTaskIn("shipped"))).resolves.toBe(false);
    expect(h.moves).toEqual([]);
  });

  it("does NOT treat an unclassifiable column as terminal", async () => {
    /*
    Being unable to prove a card is finished must not be the same as proving it is. A card in a column this
    workflow does not declare still gets the park — which is what keeps a card stranded by a lineage change
    moving instead of parked forever in a column no sweep owns.
    */
    const h = harness(RENAMED_IR, "some-column-this-board-lacks");

    await expect(h.park(completedTaskIn("some-column-this-board-lacks"))).resolves.toBe(true);
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-09:15 (#2670 review):
    The boolean alone is satisfied by an implementation that reports success and moves nothing, or
    moves to the wrong lane. The parked card must land in the workflow's HOLD column, resolved by
    role — `queued` here, not `todo`.
    */
    expect(h.moves).toEqual([["FN-DONE", "queued"]]);
  });

  it("re-reads the card AFTER resolving the workflow, so a mid-await move into a terminal lane is honoured", async () => {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-09:15 (#2670 review):
    Resolving the workflow is an await, and the card can reach a terminal lane inside that window —
    the merge path completing. The guard therefore has to judge the card as
    it is NOW, not as the caller found it. Every other test here settles immediately and starts in
    the column it asserts on, so none of them can distinguish the re-read from the caller's stale
    copy; this one holds resolution open and moves the STORED card underneath it.
    */
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness(RENAMED_IR, "building", gate);

    /* The caller's copy says `building` — mid-pipeline, and parkable on its face. */
    const stale = completedTaskIn("building");
    const parked = h.park(stale);

    h.setStoredColumn("shipped");
    release();

    await expect(parked).resolves.toBe(false);
    expect(h.moves).toEqual([]);
  });
});
