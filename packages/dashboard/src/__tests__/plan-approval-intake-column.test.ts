// @vitest-environment node
/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — P0, post-#2515):
Plan approve/reject must resolve the workflow's INTAKE column, not the id `triage`.

THE STALL THIS PINS. #2515 removed `triage` from the default lineage: there is now one
pre-implementation column, id `todo`, displayed as "Planning". The routes guarded with
`if (task.column !== "triage") throw badRequest(...)`, so after that merge the condition
was TRUE for every default-workflow card and BOTH routes rejected all of them. A card
parked `awaiting-approval` could be neither approved nor rejected — stuck, with no
operator action able to release it, and nothing crashing to reveal it.

That is the inverse of the usual drift: the guard did not stop firing, it started firing
on everything.

REVERT CHECK: restore either `task.column !== "triage"` literal and the matching case
fails with 400 instead of succeeding, because these cards are in `todo`.
*/
import { describe, it, expect, vi } from "vitest";
import express from "express";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskStore, TaskDetail } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

/** The post-#2515 default lineage: ONE pre-implementation column, id `todo`. */
const MERGED_CODING_IR = {
  version: "v2",
  name: "builtin-stepwise-coding",
  columns: [
    { id: "todo", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [{ id: "start", kind: "start", column: "todo" }, { id: "end", kind: "end", column: "done" }],
  edges: [{ from: "start", to: "end" }],
};

/** A card parked awaiting approval on the merged planning column. */
const PLANNING_TASK: TaskDetail = {
  id: "FN-200",
  title: "awaiting approval",
  description: "",
  column: "todo",
  status: "awaiting-approval",
  sourceType: "task_refine",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  prompt: "# Plan",
} as unknown as TaskDetail;

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    getRootDir: vi.fn().mockReturnValue(mkdtempSync(join(tmpdir(), "kb-plan-approval-"))),
    getTask: vi.fn().mockResolvedValue(PLANNING_TASK),
    updateTask: vi.fn().mockResolvedValue(PLANNING_TASK),
    moveTask: vi.fn().mockResolvedValue(PLANNING_TASK),
    logEntry: vi.fn().mockResolvedValue(undefined),
    // Resolve the merged workflow so the routes see its real intake column.
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "builtin:stepwise-coding" }),
    getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "builtin:stepwise-coding", name: "Coding", ir: MERGED_CODING_IR }),
    listWorkflowDefinitions: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    off: vi.fn(),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as TaskStore;
}

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

describe("plan approval on the merged planning column (post-#2515)", () => {
  it("does NOT reject approve-plan for a card in the merged intake column", async () => {
    const res = await performRequest(createApp(createMockStore()), "POST", "/api/tasks/FN-200/approve-plan");
    /*
    Assert the SUCCESS status, not merely "not 400" (PR #2571 review — greptile). A
    not-400 assertion also passes on a 404 or a 500, so it would keep this case green
    while the route was broken in a different way — a guard that reports success without
    checking, which is the class this whole audit exists to remove.
    */
    expect(res.status).toBe(200);
  });

  it("does NOT reject reject-plan for a card in the merged intake column", async () => {
    const res = await performRequest(createApp(createMockStore()), "POST", "/api/tasks/FN-200/reject-plan");
    expect(res.status).toBe(200);
  });

  /*
  The two `task_refine` routes share the same converted guard, so they share the same
  failure mode (PR #2571 review — greptile): before the fix they rejected every card on a
  lineage without `triage`, which is how a stranded refinement became unrecoverable from
  the UI. Covering only approve/reject would have left that guard unprotected.
  */
  it("does NOT reject the stranded-refinement read for a merged-lineage card", async () => {
    // The read path also consults the stranded-refinement list; stub it so a 500 from
    // missing store surface cannot masquerade as the guard passing.
    const store = createMockStore({ listStrandedRefinements: vi.fn().mockResolvedValue([]) });
    const res = await performRequest(createApp(store), "GET", "/api/tasks/FN-200/stranded-refinement");
    expect(res.status).toBe(200);
  });

  it("does NOT reject expedite-refinement for a merged-lineage card", async () => {
    const store = createMockStore({ listStrandedRefinements: vi.fn().mockResolvedValue([]) });
    const res = await performRequest(createApp(store), "POST", "/api/tasks/FN-200/expedite-refinement");
    expect(res.status).toBe(200);
  });

  it("still rejects a card that is NOT in its workflow's intake column", async () => {
    // The guard must narrow, not disappear: an in-progress card is still not approvable.
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue({ ...PLANNING_TASK, column: "in-progress" }),
    });
    const res = await performRequest(createApp(store), "POST", "/api/tasks/FN-200/approve-plan");
    expect(res.status).toBe(400);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
Reset must verify against the column it actually TARGETED.

`resolveReboundColumnForTask` picks the rebound column from the task's workflow, but both
post-reset checks compared against the literal `todo`. On any workflow whose rebound
column is not `todo` — Coding (Ideas), any custom or renamed lineage — a reset that
SUCCEEDED was reported as a "limbo state" conflict: the mover and its own verification
disagreed about where the card was supposed to land.

REVERT CHECK: restore either `updated.column !== "todo"` and this fails with a 409,
because the card lands in `backlog`, which is where its workflow says a reset belongs.
*/
describe("reset verification uses the resolved rebound column", () => {
  const REBOUND_IR = {
    version: "v2",
    name: "custom",
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip" }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
    nodes: [{ id: "start", kind: "start", column: "backlog" }, { id: "end", kind: "end", column: "shipped" }],
    edges: [{ from: "start", to: "end" }],
  };

  it("does not report a limbo-state conflict when the card lands in its own rebound column", async () => {
    const resetTask = {
      ...PLANNING_TASK,
      id: "FN-300",
      column: "backlog",
      status: undefined,
      worktree: null,
      branch: null,
      checkedOutBy: null,
    } as unknown as TaskDetail;

    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue(resetTask),
      moveTask: vi.fn().mockResolvedValue(resetTask),
      updateTask: vi.fn().mockResolvedValue(resetTask),
      getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "wf-custom" }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "wf-custom", name: "Custom", ir: REBOUND_IR }),
    });

    // The route is destructive and demands explicit confirmation; without it the request
    // 400s before ever reaching the column check, which would make this case vacuous.
    const res = await performRequest(
      createApp(store),
      "POST",
      "/api/tasks/FN-300/reset",
      JSON.stringify({ confirm: true }),
      { "content-type": "application/json" },
    );
    /*
    Assert SUCCESS, not "not 409" (PR #2582 review — greptile). A negative assertion also
    passes on a 404 or 500, so it would stay green while the route failed some other way.
    */
    expect(res.status).toBe(200);
  });

  it("routes drift correction to the resolved rebound column, not `todo`", async () => {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (PR #2582 review — greptile):
    The drift-correction path is where fixing the CHECK without fixing the WRITER just
    moved the bug: `RESET_DRIFT_CORRECTION_FIELDS` hardcoded `column: "todo"`, so a card
    with stale reset metadata was forced to `todo` and the final check — now comparing
    against `resetColumn` — raised the very 409 this change removes.

    REVERT CHECK: restore `column: "todo"` in the constant and this fails, because the
    correction writes `todo` while the workflow's rebound column is `backlog`.
    */
    const driftedTask = {
      ...PLANNING_TASK,
      id: "FN-301",
      column: "backlog",
      // Stale binding: this is what triggers drift correction.
      worktree: "/tmp/stale",
      branch: null,
      checkedOutBy: null,
    } as unknown as TaskDetail;
    const corrected = { ...driftedTask, worktree: null } as unknown as TaskDetail;

    const updateTask = vi.fn().mockResolvedValue(corrected);
    let reads = 0;
    const store = createMockStore({
      /*
      The route reads the task before the move AND after it; both must still show the
      stale worktree for drift correction to trigger. Only reads after the correction
      writes see the cleaned task.
      */
      getTask: vi.fn().mockImplementation(async () => (reads++ < 2 ? driftedTask : corrected)),
      moveTask: vi.fn().mockResolvedValue(driftedTask),
      updateTask,
      getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "wf-custom" }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "wf-custom", name: "Custom", ir: REBOUND_IR }),
    });

    await performRequest(
      createApp(store),
      "POST",
      "/api/tasks/FN-301/reset",
      JSON.stringify({ confirm: true }),
      { "content-type": "application/json" },
    );

    const correctionCall = updateTask.mock.calls.find(([, patch]) => patch && "column" in patch);
    expect(correctionCall).toBeDefined();
    expect((correctionCall![1] as { column: string }).column).toBe("backlog");
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
A SPEC RETRY must be recognised in the workflow's intake column, whatever its id.

`retrySpecification` decided "this is a re-plan, not a generic retry" with
`task.column === "triage"`, plus a `todo` fallback that only applied when the workflow
had no `triage` column at all. Both are id checks, so on a lineage whose intake column is
named anything else the flag stayed false — and because `status: "planning"` is retryable
ONLY through that flag, the route answered 400 "not in a retryable state" for a card that
was plainly sitting in planning. The operator's Retry button did nothing.

This is the one conversion in this PR with an observable behaviour change, so it is the
one that gets a test. Narrowing the four `&& task.column !== "triage"` disjuncts I had
added while widening the P0 guard cannot be tested by construction: removing an extra
acceptance only shrinks what is accepted, and no case feeds these routes a `triage` card
now that no shipped lineage declares one.

REVERT CHECK: restore `task.column === "triage"` and this fails with 400, because the
card is in `backlog` — measured, not assumed.
*/
describe("spec retry resolves the workflow's intake column", () => {
  const CUSTOM_IR = {
    version: "v2",
    name: "custom",
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip" }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
    nodes: [{ id: "start", kind: "start", column: "backlog" }, { id: "end", kind: "end", column: "shipped" }],
    edges: [{ from: "start", to: "end" }],
  };

  it("accepts a retry for a planning card in a custom intake column", async () => {
    /*
    `status: "planning"` is deliberate: it is NOT in the generic retryable set
    (`failed` / `stuck-killed`), so the request survives the retryable-state check only if
    `retrySpecification` resolved true. A `failed` fixture would pass either way and prove
    nothing.
    */
    const planningTask = {
      ...PLANNING_TASK,
      id: "FN-400",
      column: "backlog",
      status: "planning",
    } as unknown as TaskDetail;

    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue(planningTask),
      updateTask: vi.fn().mockResolvedValue(planningTask),
      moveTask: vi.fn().mockResolvedValue(planningTask),
      getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "wf-custom" }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "wf-custom", name: "Custom", ir: CUSTOM_IR }),
    });

    const res = await performRequest(createApp(store), "POST", "/api/tasks/FN-400/retry");
    expect(res.status).toBe(200);
  });
});
