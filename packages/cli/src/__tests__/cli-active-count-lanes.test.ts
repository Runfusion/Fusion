/*
FNXC:WorkflowLifecycleColumns 2026-08-02-09:20 (fleet: the CLI surface on a renamed board):

THE INVARIANT: `active=N` counts the board's own wip and review lanes.

The same four-line aggregation appears FOUR times in `dashboard.ts` — the TUI stats refresh, the serve
summary, the status line, and the agent-stats pass — each comparing the default lineage's two ids. On a
renamed board every one reported `active=0` while the board was plainly busy.

WHY THIS IS WORSE THAN AN INTERNAL INERT GUARD: this number is the operator's first read of a project. A
recovery path that silently stops firing is invisible until something breaks; a stats line that says zero is
read, believed, and acted on — "nothing is running, so I can restart the engine".

The four copies are now one helper, which is the other half of the fix: four independent copies of a
lifecycle decision is how they drift, and these four were identical by accident rather than by construction.
*/
import { describe, expect, it, vi } from "vitest";
import type { TaskStore, WorkflowIr } from "@fusion/core";

import { countActiveTasks } from "../commands/dashboard.js";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed",
  nodes: [{ id: "start", kind: "start", column: "backlog" }],
  edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

function storeFor(ir: WorkflowIr | undefined) {
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  const getWorkflowDefinition = vi.fn(async () => (ir ? { ir } : undefined));
  const getTaskWorkflowSelectionAsync = vi.fn(async () => (ir ? selection : undefined));
  return {
    store: {
      getTaskWorkflowSelection: () => (ir ? selection : undefined),
      getTaskWorkflowSelectionAsync,
      getWorkflowDefinition,
    } as unknown as TaskStore,
    getWorkflowDefinition,
    getTaskWorkflowSelectionAsync,
  };
}

describe("the CLI's active-task count resolves the board's lanes", () => {
  it("counts a renamed board's wip and review cards", async () => {
    // Pre-fix: neither `building` nor `signoff` matched, so this returned 0 for a busy board.
    const { store } = storeFor(RENAMED_IR);

    const active = await countActiveTasks(store, [
      { id: "FN-1", column: "building" },
      { id: "FN-2", column: "signoff" },
      { id: "FN-3", column: "backlog" },
      { id: "FN-4", column: "shipped" },
    ]);

    expect(active).toBe(2);
  });

  it("counts nothing when no card is in either lane", async () => {
    // The paired negative: the count must not degrade into "every card is active".
    const { store } = storeFor(RENAMED_IR);

    expect(await countActiveTasks(store, [
      { id: "FN-5", column: "backlog" },
      { id: "FN-6", column: "shipped" },
    ])).toBe(0);
  });

  it("PINS the per-task selection read, so the cost is visible rather than hidden", async () => {
    /*
    FNXC:WorkflowLifecycleColumns 2026-08-02-13:40 (PR #2728 review — greptile P2, and it is a fair catch):
    The shared IR cache avoids repeated workflow-DEFINITION reads, not the per-task SELECTION read — a board
    can mix workflows, so "which workflow governs this card" has to be asked per card. My first version
    asserted only the definition count, which made the aggregation look cheaper than it is.

    THE TRADE-OFF, stated rather than hidden: the previous implementation did ZERO reads and was wrong on
    every renamed board (`active=0` on a busy board). N selection reads per stats refresh is the price of a
    correct answer with today's resolver. The durable fix is a bulk selection read or a list projection that
    carries column flags — the dashboard already avoids this entirely by reading board flags it has in hand
    (`enrichRunningAgentTaskShapeFromFlags`), which is the shape a `listTasks` projection should copy.

    Pinned as an EXACT count so a future bulk read shows up here as a deliberate change rather than drifting.
    */
    const { store, getTaskWorkflowSelectionAsync } = storeFor(RENAMED_IR);
    const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `FN-${i}`, column: "building" }));

    await countActiveTasks(store, tasks);

    expect(getTaskWorkflowSelectionAsync).toHaveBeenCalledTimes(12);
  });

  it("resolves one IR per WORKFLOW, not per task", async () => {
    /*
    The cost of converting a per-list aggregation is the reason to assert this: a 500-card board must not
    become 500 workflow reads. The shared cache is what makes that true, and only a call count can see it —
    the returned number is identical either way.
    */
    const { store, getWorkflowDefinition } = storeFor(RENAMED_IR);
    const tasks = Array.from({ length: 25 }, (_, i) => ({ id: `FN-${i}`, column: "building" }));

    expect(await countActiveTasks(store, tasks)).toBe(25);
    expect(getWorkflowDefinition).toHaveBeenCalledTimes(1);
  });

  it("behaves identically on the DEFAULT board", async () => {
    // No workflow selection: falls back to the legacy pair. Passes either way by design.
    const { store } = storeFor(undefined);

    expect(await countActiveTasks(store, [
      { id: "FN-7", column: "in-progress" },
      { id: "FN-8", column: "in-review" },
      { id: "FN-9", column: "todo" },
    ])).toBe(2);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-08-02-13:00 (PR #2728 review — greptile P1 x2):

THE INVARIANT: the shared missing-worktree classifier answers with the CALLER'S review lane.

`isInReviewMissingWorktreeSessionStartFailure` is used by three surfaces — the dashboard retry route, the CLI
retry command, and `fn_task_retry` (the MCP tool agents call). All three resolve the review lane before
calling it, and the classifier compared the literal anyway. So every surface recognised a renamed review lane
and then delegated to a predicate that did not: the card was refused for the ONE reason the delegate exists to
allow, and no message anywhere mentions columns.

Testing the classifier directly rather than through three route harnesses: it is a pure function and the
defect lives in it. The three call sites passing their sets is asserted structurally below, because a call
site that accepts the parameter and does not pass it is the failure mode a unit test cannot see.
*/
describe("the shared missing-worktree classifier takes the caller's review lane", () => {
  const FAILURE = "Refusing to start coding agent in missing worktree: /gone";

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-11:30:
  The second parameter is a RESOLVED BOOLEAN (`isReviewColumn?: boolean`), not a lane Set. These two
  cases passed `new Set([...])`, and a non-empty Set is TRUTHY — so `isReviewColumn ?? ...` short-
  circuited to the Set and the classifier answered `true` for every column. The negative case failed
  on main, and the positive case was passing for the wrong reason: any truthy second argument
  satisfies it, including `new Set(["nothing-relevant"])`.

  Both now derive the boolean the way the real caller does — `commands/task.ts:1396` passes
  `retryReviewColumns.has(task.column)` — so the lane set is still what decides, and the cases
  exercise the resolution rather than a hand-picked literal.
  */
  const reviewLanes = new Set(["signoff"]);

  it("recognises a renamed review lane when the caller supplies it", async () => {
    const { isInReviewMissingWorktreeSessionStartFailure } = await import("@fusion/engine");
    const task = { id: "FN-1", column: "signoff", error: FAILURE } as never;

    // Pre-fix: `signoff` !== "in-review", so the retry bypass this classifier exists for never applied.
    expect(isInReviewMissingWorktreeSessionStartFailure(task, reviewLanes.has(task.column))).toBe(true);
  });

  it("still refuses a column outside the supplied set", async () => {
    const { isInReviewMissingWorktreeSessionStartFailure } = await import("@fusion/engine");
    const task = { id: "FN-2", column: "building", error: FAILURE } as never;

    expect(isInReviewMissingWorktreeSessionStartFailure(task, reviewLanes.has(task.column))).toBe(false);
  });

  it("keeps the legacy literal when no set is supplied", async () => {
    // Backwards compatibility is the reason the parameter is optional: existing callers must not change.
    const { isInReviewMissingWorktreeSessionStartFailure } = await import("@fusion/engine");

    expect(isInReviewMissingWorktreeSessionStartFailure({ id: "FN-3", column: "in-review", error: FAILURE } as never)).toBe(true);
    expect(isInReviewMissingWorktreeSessionStartFailure({ id: "FN-4", column: "signoff", error: FAILURE } as never)).toBe(false);
  });

  it("is called WITH a resolved set at all three surfaces", async () => {
    /*
    A call site that accepts the parameter and forgets to pass it is exactly the half-conversion this thread
    was about, and no unit test on the classifier can see it. Structural, and it names the file so a fourth
    surface has to be added here deliberately.
    */
    const { readFile } = await import("node:fs/promises");
    const surfaces = [
      new URL("../extension.ts", import.meta.url),
      new URL("../commands/task.ts", import.meta.url),
      new URL("../../../dashboard/src/routes/register-task-workflow-routes.ts", import.meta.url),
    ];

    for (const surface of surfaces) {
      const code = (await readFile(surface, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
      const call = code.match(/isInReviewMissingWorktreeSessionStartFailure\(([^)]*)\)/);
      expect(call, `${surface.pathname} does not call the classifier`).toBeTruthy();
      expect(call?.[1], `${surface.pathname} calls it without a resolved review set`).toContain(",");
    }
  });
});
