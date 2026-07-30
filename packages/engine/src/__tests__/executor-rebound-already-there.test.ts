/*
FNXC:WorkflowLifecycleColumns 2026-07-30-15:30 (Phase C convergence — executor rebound guards):

THE INVARIANT: an engine rebound moves the card only when it is NOT already in the column the
rebound resolves to — on ANY workflow, not just the default lineage.

WHAT WAS BROKEN. `resolveReboundColumnFor` was converted in U5b, so every rebound MOVE targeted
the workflow's own backlog column. The eight `X.column !== "todo"` guards standing in front of
those moves were not converted. On a renamed board the guard was therefore always true, and the
engine issued a move into the column the card was already sitting in.

WHY THAT IS NOT HARMLESS. `moveTaskInternal` runs the reset-on-entry effects on every real move.
So the redundant move re-cleared status/error/pause state, and at the stale-parse-pins site
(`preserveProgress: false`) it RESET STEP PROGRESS a second time on a card that had merely been
re-checked. The half-conversion shape again: the right target, reached through a check that could
not see it.

This drives `parkCompletedBlockedTask` — the FN-7926 completed-but-blocked park — because it is
the rebound site reachable without standing up a graph run. The other seven sites take the
identical shape and are covered by the same predicate; that is stated rather than implied.
*/
import { describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore } from "./executor-test-helpers.js";
import type { WorkflowIr } from "@fusion/core";

/** Standard traits, non-default names: the backlog role lives on `queued`. */
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

function blockedCompletedTask(column: string) {
  return {
    id: "FN-BLOCKED",
    title: "completed but blocked",
    description: "",
    column,
    worktree: "/repo/.worktrees/blocked",
    branch: "fusion/fn-blocked",
    steps: [{ name: "Implement", status: "done" as const }],
    currentStep: 0,
    dependencies: [],
    log: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function harness(ir: WorkflowIr | undefined, column: string) {
  const store = createMockStore();
  let task: Record<string, unknown> = blockedCompletedTask(column);
  const moves: Array<[string, string]> = [];

  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  const widened = store as unknown as Record<string, unknown>;
  widened.getTaskWorkflowSelection = () => (ir ? selection : undefined);
  widened.getTaskWorkflowSelectionAsync = async () => (ir ? selection : undefined);
  widened.getWorkflowDefinition = async () => (ir ? { ir } : undefined);

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

describe("an engine rebound does not move a card that is already in its rebound column", () => {
  it("issues NO move when the renamed board's backlog column already holds the card", async () => {
    // Pre-fix: `queued !== "todo"` was true, so a move into `queued` was issued — a real move,
    // which re-runs the reset-on-entry effects on a card nothing had actually moved.
    const h = harness(RENAMED_IR, "queued");

    const parked = await h.park(blockedCompletedTask("queued"));

    expect(parked).toBe(true);
    expect(h.moves).toEqual([]);
  });

  it("DOES move when the card is elsewhere on the renamed board", async () => {
    // The paired positive: "never move" must not be able to pass for "compare properly".
    const h = harness(RENAMED_IR, "building");

    await h.park(blockedCompletedTask("building"));

    expect(h.moves).toEqual([["FN-BLOCKED", "queued"]]);
  });

  it("still skips the redundant move on the default lineage", async () => {
    const h = harness(undefined, "todo");

    await h.park(blockedCompletedTask("todo"));

    expect(h.moves).toEqual([]);
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-16:20 (PR #2644 review, CodeRabbit):
  THIS FIXTURE HAD TO DIFFER FROM THE DEFAULT-LINEAGE ONE. Both used `harness(undefined, ...)`, which
  supplies no workflow SELECTION at all — so "the default lineage" and "the workflow cannot be resolved"
  were the same setup, and this case could pass without ever exercising a selection whose definition lookup
  fails. Two tests with identical fixtures are one test with two names.

  It now names a workflow whose definition read THROWS, which is the state that actually reaches the
  resolver's fail-soft path in production (a deleted or unreadable definition row, not an absent
  selection).
  */
  it("still moves to the legacy backlog when a SELECTED workflow's definition cannot be read", async () => {
    const h = harness(undefined, "in-progress");
    const selection = { workflowId: "wf-unreadable", stepIds: [] as string[] };
    const widened = h.store as unknown as Record<string, unknown>;
    widened.getTaskWorkflowSelection = () => selection;
    widened.getTaskWorkflowSelectionAsync = async () => selection;
    widened.getWorkflowDefinition = async () => {
      throw new Error("definition row is gone");
    };

    await h.park(blockedCompletedTask("in-progress"));

    expect(h.moves).toEqual([["FN-BLOCKED", "todo"]]);
  });
});
