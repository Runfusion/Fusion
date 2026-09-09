// @vitest-environment node
/*
FNXC:ManualRetry 2026-07-29-21:05 (triage census — register-task-workflow-routes.ts):

## Symptom Verification

Original symptom: `POST /api/tasks/:id/retry` decided between its DESTRUCTIVE specification branch
(stamp `status: "needs-replan"` AND delete PROMPT.md) and ordinary execution retry using
`!workflowHasColumn(ir, "triage")` as a proxy for "this card plans in place".

MEASURED across all 12 builtins (see packages/core/src/__tests__/workflow-plans-in-column.test.ts):
NOT ONE workflow plans in `triage`, while SEVEN still declare that column. So the proxy answered the
wrong question in both directions, and the damaging direction is DENIAL:

  builtin:quick-fix, review-heavy, compound-engineering, design, legacy-coding
    declare `triage` AND run every plan node in `todo`. `!hasColumn("triage")` is FALSE for them,
    so a `planning` / `needs-replan` card sitting in their PLANNING column was refused:
      400 - "Task is not in a retryable state (current status: needs-replan)"
    The operator had no button at all on a card that was parked mid-planning.

  A workflow that plans somewhere other than `todo` got the mirror-image fault: a card in `todo`
    was handed the spec-DELETING branch even though `todo` hosts no plan node.

Exact reproduction: a `needs-replan` card in `todo` on `builtin:quick-fix`. Retry it.

Assertion it is gone: that POST returns 200 and takes the specification branch
(`status: "needs-replan"` re-stamped by the retry path) instead of 400. The mirror-image case and
both already-correct builtins are asserted alongside, so neither direction can regress alone.

## Surface Enumeration

- All five builtins that declare `triage` but plan in `todo` — previously 400, must now retry.
- Default workflow (`builtin:coding`, plans in `todo`) — must STILL get specification retry.
- Manual-intake plan-in-place workflow (`builtin:coding-ideas-v2`) — must STILL; FN-8587 path.
- Custom workflow planning outside `todo` — must NOT take the spec-deleting branch...
- ...but must STILL be retryable (routed to execution retry), or the fix strands the card instead.
- Legacy workflow planning in `triage`, card in `todo` — must NOT, unchanged from before.
- A wip-column card must gain no retry path it lacked before (the widening is pre-WIP only).
- Every status that reaches the branch: `failed`, `planning`, `needs-replan`, stuckKillCount>0.
*/
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request as performRequest } from "../test-request.js";
import { ApiError, sendErrorResponse } from "../api-error.js";

/** A workflow with NO triage column whose planning happens in its own intake column. */
const PLANS_IN_INBOX = {
  version: "v2",
  id: "custom:plans-in-inbox",
  name: "Plans In Inbox",
  columns: [
    { id: "inbox", traits: [{ trait: "intake" }] },
    { id: "todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "in-review", traits: [{ trait: "review" }] },
    { id: "done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "plan", kind: "prompt", column: "inbox", config: {} },
    { id: "plan-review", kind: "prompt", column: "inbox", config: {} },
  ],
  edges: [],
};

/** Legacy shape: planning runs in `triage`, so a card in `todo` is past specification. */
const PLANS_IN_TRIAGE = {
  ...PLANS_IN_INBOX,
  id: "custom:plans-in-triage",
  columns: [{ id: "triage", traits: [{ trait: "intake" }] }, ...PLANS_IN_INBOX.columns.slice(1)],
  nodes: [{ id: "plan", kind: "prompt", column: "triage", config: {} }],
};

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-9001",
    title: "retry planning column",
    description: "d",
    column: "todo",
    status: "failed",
    dependencies: [],
    createdAt: "2026-07-29T09:00:00.000Z",
    updatedAt: "2026-07-29T09:10:00.000Z",
    size: "M",
    subtasks: [],
    log: [],
    tags: [],
    blockedBy: [],
    mergeRetries: 0,
    steps: [],
    source: { sourceType: "api" },
    ...overrides,
  } as unknown as Task;
}

function buildApp(input: { task: Task; workflowId?: string; definition?: unknown }) {
  const updateTask = vi.fn(async (_taskId: string, patch: Partial<Task>) => Object.assign(input.task, patch));
  const moveTask = vi.fn(async () => input.task);
  const workflowItems: Array<Record<string, unknown>> = [];
  const store = {
    getTask: async () => input.task,
    getTaskDetail: async () => input.task,
    updateTask,
    moveTask,
    logEntry: vi.fn(async () => {}),
    withPlanningLifecycleLock: async (_taskId: string, work: () => Promise<unknown>) => work(),
    updateTaskAtomic: async (_taskId: string, updater: (current: Task) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>) => {
      const patch = await updater(structuredClone(input.task));
      if (patch) Object.assign(input.task, patch);
      return input.task;
    },
    pauseTask: async (_taskId: string, paused: boolean, _context?: unknown, options?: { pausedReason?: string }) => {
      input.task.paused = paused || undefined;
      input.task.pausedReason = paused ? options?.pausedReason : undefined;
      return input.task;
    },
    cancelActiveWorkflowWorkItemsForTask: async () => {},
    replaceActiveTaskWorkflowContinuation: async (item: Record<string, unknown>) => {
      workflowItems.push(item);
      return item;
    },
    listWorkflowWorkItemsForTask: async () => workflowItems,
    clearWorkflowRunStepInstancesAsync: async () => {},
    getSettings: async () => ({}),
    getSettingsFast: async () => ({}),
    // A path that cannot exist, so the specification branch's PROMPT.md unlink is a
    // no-op (`force: true`) rather than touching any real tree.
    getRootDir: () => "/tmp/fusion-retry-planning-column-does-not-exist",
    listTasks: async () => [input.task],
    // FNXC:TaskWedgeNotifications 2026-08-15-05:10: dashboard Retry now clears the spent generic-terminal auto-recovery budget before mutating task state; the fixture must expose the seam or every retry 500s.
    resetTerminalFailureAutoRecoveryBudget: async () => {},
    getTaskWorkflowSelectionAsync: async () => (input.workflowId ? { workflowId: input.workflowId } : null),
    getWorkflowDefinition: async () => input.definition,
    getWorkflowSettingsProjectId: () => undefined,
    listTaskWorkflowStepResults: async () => [],
    getTaskWorkflowStepInstances: async () => [],
    deleteTaskWorkflowStepInstances: async () => {},
  } as unknown as TaskStore;

  const runtimeLogger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  const router = express.Router();
  registerTaskWorkflowRoutes({
    router,
    store,
    options: {},
    runtimeLogger: runtimeLogger as never,
    planningLogger: runtimeLogger as never,
    chatLogger: runtimeLogger as never,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => store,
    getProjectContext: async () => ({ store, engine: undefined as never, projectId: "p-1" }),
    prioritizeProjectsForCurrentDirectory: (projects: unknown) => projects,
    emitRemoteRouteDiagnostic: () => {},
    emitAuthSyncAuditLog: () => {},
    parseScopeParam: () => undefined,
    resolveAutomationStore: () => ({}) as never,
    resolveRoutineStore: () => ({}) as never,
    resolveRoutineRunner: () => ({}) as never,
    registerDispose: () => {},
    dispose: () => {},
    rethrowAsApiError: (error: unknown): never => {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, error instanceof Error ? error.message : "Internal server error");
    },
  } as never, {
    runtimeLogger,
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100,
    validateOptionalModelField: (value: unknown) => (typeof value === "string" ? value : undefined),
    normalizeModelSelectionPair: (provider: string | null, modelId: string | null) => ({ provider: provider ?? null, modelId: modelId ?? null }),
    runGitCommand: async () => "",
    isGitRepo: async () => true,
    resolveIntegrationBranch: async () => "main",
    trimTaskDetailActivityLog: (task: unknown) => task,
    triggerCommentWakeForAssignedAgent: async () => {},
    resolveSelfHealingManager: () => undefined,
  } as never);

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) {
      sendErrorResponse(res, error.statusCode, error.message, { details: error.details });
      return;
    }
    sendErrorResponse(res, 500, error instanceof Error ? error.message : "Internal server error");
  });
  return { app, updateTask, moveTask };
}

/** The status patch the route wrote — `needs-replan` means the specification branch was taken. */
function statusPatchOf(updateTask: ReturnType<typeof vi.fn>): unknown {
  const call = updateTask.mock.calls.find((c) => c[1] && "status" in (c[1] as object));
  return (call?.[1] as { status?: unknown } | undefined)?.status;
}

async function retry(app: express.Express) {
  return performRequest(app, "POST", "/api/tasks/FN-9001/retry", "{}", { "content-type": "application/json" });
}

describe("POST /api/tasks/:id/retry — specification retry follows the plan node's column", () => {
  /*
  THE DEFECT. Old predicate: `!workflowHasColumn(ir, "triage")` -> true (this workflow has no triage
  column), so a card in `todo` was given `needs-replan` and had its PROMPT.md deleted, even though
  `todo` hosts no plan node. Reverting to that predicate makes this assertion read "needs-replan".
  */
  it("does NOT take the spec-deleting branch for a card parked outside the planning column", async () => {
    const { app, updateTask } = buildApp({
      task: mkTask(),
      workflowId: "custom:plans-in-inbox",
      definition: { ir: PLANS_IN_INBOX },
    });

    const res = await retry(app);
    expect(res.status).toBe(200);
    expect(statusPatchOf(updateTask)).toBeNull();
  });

  it("does NOT take it for a legacy workflow that plans in triage (unchanged)", async () => {
    const { app, updateTask } = buildApp({
      task: mkTask(),
      workflowId: "custom:plans-in-triage",
      definition: { ir: PLANS_IN_TRIAGE },
    });

    const res = await retry(app);
    expect(res.status).toBe(200);
    expect(statusPatchOf(updateTask)).toBeNull();
  });

  /*
  The other half of the ratchet: narrowing must not remove specification retry from the cards that
  legitimately get it. Both builtins plan in `todo`, so a failed `todo` card there IS a planning
  failure. Without these, "return false always" would pass the tests above.
  */
  /*
  THE HEADLINE DEFECT, on real shipped workflows. These five declare a `triage` column and run every
  plan node in `todo`, so the old `!workflowHasColumn(ir, "triage")` was FALSE and a card parked
  mid-planning got 400 "not in a retryable state" — no button at all. Reverting to that predicate
  turns each of these into a 400.
  */
  it.each([
    "builtin:quick-fix",
    "builtin:review-heavy",
    "builtin:compound-engineering",
    "builtin:design",
    "builtin:legacy-coding",
  ])("retries a needs-replan card in the planning column of %s (was 400)", async (workflowId) => {
    const { app, updateTask } = buildApp({ task: mkTask({ status: "needs-replan" }), workflowId });

    const res = await retry(app);
    expect(res.status).toBe(200);
    expect(statusPatchOf(updateTask)).toBe("needs-replan");
  });

  it("STILL takes it for the default workflow, whose plan nodes are in todo", async () => {
    const { app, updateTask } = buildApp({ task: mkTask() }); // no selection -> builtin:coding

    const res = await retry(app);
    expect(res.status).toBe(200);
    expect(statusPatchOf(updateTask)).toBe("needs-replan");
  });

  it("STILL takes it for the Coding (Ideas) plan-in-place workflow (FN-8587 path)", async () => {
    const { app, updateTask } = buildApp({ task: mkTask(), workflowId: "builtin:coding-ideas-v2" });

    const res = await retry(app);
    expect(res.status).toBe(200);
    expect(statusPatchOf(updateTask)).toBe("needs-replan");
  });

  /*
  Narrowing the destructive branch must not leave a card with NO button. A `planning` card parked
  outside its planning column would otherwise answer 400 "not in a retryable state" — a card nothing
  can rescue, which is worse than the spec loss this change removes. It must stay retryable and take
  the ordinary execution retry (status cleared, spec preserved).
  */
  it("keeps a stranded planning-status card retryable, routed to the non-destructive branch", async () => {
    const { app, updateTask } = buildApp({
      task: mkTask({ status: "planning" }),
      workflowId: "custom:plans-in-inbox",
      definition: { ir: PLANS_IN_INBOX },
    });

    const res = await retry(app);
    expect(res.status).toBe(200); // NOT 400 "not in a retryable state"
    expect(statusPatchOf(updateTask)).toBeNull(); // and NOT needs-replan
  });

  it("does not hand a retry path to a status that never had one (in-progress)", async () => {
    // The widening above is scoped to pre-WIP columns; an in-progress card with a planning
    // status must still be refused exactly as before.
    const { app } = buildApp({
      task: mkTask({ column: "in-progress", status: "planning" }),
      workflowId: "custom:plans-in-inbox",
      definition: { ir: PLANS_IN_INBOX },
    });

    expect((await retry(app)).status).toBe(400);
  });

  /*
  GREPTILE #2621: a v1 IR declares no columns and no nodes, so the placement question is
  UNANSWERABLE. Reading that as "past planning" made both flags false and this route answered 400 —
  a regression against the old predicate, which admitted the card. It must stay retryable and take
  the non-destructive branch so an unanswerable question never costs a specification.
  */
  it("keeps a v1 column-less workflow retryable instead of 400ing", async () => {
    const { app, updateTask } = buildApp({
      task: mkTask({ status: "needs-replan" }),
      workflowId: "custom:v1-no-columns",
      definition: { ir: { version: 1, id: "custom:v1-no-columns", name: "V1", steps: [] } },
    });

    const res = await retry(app);
    expect(res.status).toBe(200); // was 400 "not in a retryable state"
    expect(statusPatchOf(updateTask)).toBeNull(); // non-destructive: spec preserved
  });

  /*
  GREPTILE #2621: a custom workflow whose planning node carries the builtin planning SEAM but a
  bespoke id must still be recognised, or Manual Retry preserves a stale spec instead of replanning.
  */
  it("takes the specification branch for a bespoke planning node id carrying the planning seam", async () => {
    const seamIr = {
      version: "v2",
      id: "custom:seam-planner",
      name: "Seam Planner",
      columns: [
        { id: "todo", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
        { id: "in-progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      ],
      nodes: [{ id: "write-the-spec", kind: "prompt", column: "todo", config: { seam: "planning" } }],
      edges: [],
    };
    const { app, updateTask } = buildApp({
      task: mkTask({ status: "needs-replan" }),
      workflowId: "custom:seam-planner",
      definition: { ir: seamIr },
    });

    const res = await retry(app);
    expect(res.status).toBe(200);
    expect(statusPatchOf(updateTask)).toBe("needs-replan");
  });

  /*
  GREPTILE #2621: the v1 branch must stay PRE-WIP scoped like the v2 one. Admitting every column let a
  planning-status card in `in-progress`/`in-review` through, and the generic branch then clears
  worktree/branch/retry counters and rebounds it — destroying live execution or review state.
  */
  it.each(["in-progress", "in-review"])("refuses a v1 planning-status card parked in %s", async (column) => {
    const { app } = buildApp({
      task: mkTask({ column, status: "planning" as never, steps: [] as never }),
      workflowId: "custom:v1-no-columns",
      definition: { ir: { version: 1, id: "custom:v1-no-columns", name: "V1", steps: [] } },
    });

    expect((await retry(app)).status).toBe(400);
  });

  it("applies to every status that reaches the branch, not just `failed`", async () => {
    for (const overrides of [
      { status: "planning" },
      { status: "needs-replan" },
      { status: null, stuckKillCount: 2 },
    ] as Array<Partial<Task>>) {
      const bad = buildApp({
        task: mkTask(overrides),
        workflowId: "custom:plans-in-inbox",
        definition: { ir: PLANS_IN_INBOX },
      });
      expect(await retry(bad.app).then((r) => r.status)).toBe(200);
      expect(statusPatchOf(bad.updateTask)).toBeNull();

      const good = buildApp({ task: mkTask(overrides) });
      expect(await retry(good.app).then((r) => r.status)).toBe(200);
      expect(statusPatchOf(good.updateTask)).toBe("needs-replan");
    }
  });
});
