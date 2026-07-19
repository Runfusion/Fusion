// @vitest-environment node
/*
FNXC:MergeReliability 2026-07-15-22:05 (FN-8004 follow-up):

## Symptom Verification

Original symptom: FN-8004's AI merge was killed mid-flight, leaving `status: "landing"` stamped on
the task. `POST /api/tasks/FN-8004/retry` then answered
  400 — "Task is not in a retryable state (current status: landing)"
for the full self-healing sweep delay. The automatic sweep DID recover it minutes later, so the
operator's manual escape hatch was blocked at exactly the moment it was needed.

Exact reproduction: an in-review task with a merge-active status, no live merge lease, and an
`updatedAt` older than the staleness floor.

Assertion it is gone: that POST now succeeds AND takes the merge-retry branch — status/error
cleared, mergeRetries reset, task STAYS in in-review. Staying put is load-bearing: routing a
fully-executed task to `todo` would re-run finished work, which is the bug this fix could easily
have introduced.

## Surface Enumeration

- Every status in ACTIVE_MERGE_STATUSES (merging / merging-pr / merging-fix / reviewing / landing),
  since a merger can die in any phase — not just the reported `landing`.
- Live-merge protection via BOTH independent signals: the in-process lease, and a fresh updatedAt.
- The pre-existing retry paths (failed / status-none merge stall) must be unchanged.
*/
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request as performRequest } from "../test-request.js";
import { ApiError, sendErrorResponse } from "../api-error.js";
import { ACTIVE_MERGE_STATUSES, DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS } from "@fusion/engine";

const NOW = Date.now();
const STALE_AT = new Date(NOW - DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS - 60_000).toISOString();
const FRESH_AT = new Date(NOW - 5_000).toISOString();

/** An in-review task whose implementation is complete — the FN-8004 shape. */
function mkMergeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-8004",
    title: "soft-delete heartbeat race",
    description: "d",
    column: "in-review",
    status: "landing",
    dependencies: [],
    createdAt: "2026-07-15T09:00:00.000Z",
    updatedAt: STALE_AT,
    size: "M",
    subtasks: [],
    log: [],
    tags: [],
    blockedBy: [],
    mergeRetries: 3,
    // All steps complete: this is a merge failure, not an execution failure.
    steps: [{ status: "done" }, { status: "done" }],
    source: { sourceType: "api" },
    ...overrides,
  } as unknown as Task;
}

function buildApp(input: { task: Task; activeMergeTaskId?: string | null; staleMergingStatusMinAgeMs?: number }) {
  const updateTask = vi.fn(async () => input.task);
  const moveTask = vi.fn(async () => input.task);
  const logEntry = vi.fn(async () => {});
  const store = {
    getTask: async () => input.task,
    getTaskDetail: async () => input.task,
    updateTask,
    moveTask,
    logEntry,
    getSettings: async () => ({}),
    getSettingsFast: async () => ({}),
    getRootDir: () => "/tmp/does-not-exist",
    listTasks: async () => [input.task],
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
    // The seam the fix reads for live-merge proof.
    resolveSelfHealingManager: () => ({
      getActiveMergeTaskId: () => input.activeMergeTaskId ?? null,
      getStaleMergingStatusMinAgeMs: () => input.staleMergingStatusMinAgeMs ?? DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS,
    }),
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
  return { app, updateTask, moveTask, logEntry };
}

describe("POST /api/tasks/:id/retry — orphaned merge-active status (FN-8004)", () => {
  it("retries a task stranded in 'landing' by a killed merger", async () => {
    const { app, updateTask, moveTask } = buildApp({ task: mkMergeTask() });

    const res = await performRequest(app, "POST", "/api/tasks/FN-8004/retry", "{}", { "content-type": "application/json" });

    // The regression: this used to be 400 "not in a retryable state (current status: landing)".
    expect(res.status).toBe(200);
    // Merge-retry branch: clear the stamp and reset the budget...
    expect(updateTask).toHaveBeenCalledWith(
      "FN-8004",
      expect.objectContaining({ status: null, error: null }),
    );
    // ...and STAY in in-review. Moving completed work to todo would re-run it.
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("retries a task stranded in ANY merge-active phase, not just the reported one", async () => {
    for (const status of [...ACTIVE_MERGE_STATUSES]) {
      const { app } = buildApp({ task: mkMergeTask({ status } as Partial<Task>) });
      const res = await performRequest(app, "POST", "/api/tasks/FN-8004/retry", "{}", { "content-type": "application/json" });
      expect(res.status, `status=${status} must be retryable when orphaned`).toBe(200);
    }
  });

  it("uses the configured staleness floor, matching automatic recovery", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    const { app } = buildApp({
      task: mkMergeTask({ updatedAt: twoMinutesAgo }),
      staleMergingStatusMinAgeMs: 60_000,
    });

    const res = await performRequest(app, "POST", "/api/tasks/FN-8004/retry", "{}", { "content-type": "application/json" });

    expect(res.status).toBe(200);
  });

  it("still REFUSES to retry a merge holding the live in-process lease", async () => {
    const { app } = buildApp({ task: mkMergeTask(), activeMergeTaskId: "FN-8004" });

    const res = await performRequest(app, "POST", "/api/tasks/FN-8004/retry", "{}", { "content-type": "application/json" });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("not in a retryable state");
  });

  it("still REFUSES to retry a merge that is progressing (fresh updatedAt)", async () => {
    // Each merge phase writes a log entry, refreshing updatedAt — this is what stops
    // an operator from yanking a slow-but-live merge.
    const { app } = buildApp({ task: mkMergeTask({ updatedAt: FRESH_AT }) });

    const res = await performRequest(app, "POST", "/api/tasks/FN-8004/retry", "{}", { "content-type": "application/json" });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("not in a retryable state");
  });

  it("leaves the pre-existing failed-merge retry path unchanged", async () => {
    const { app, updateTask, moveTask } = buildApp({
      task: mkMergeTask({ status: "failed", updatedAt: FRESH_AT }),
    });

    const res = await performRequest(app, "POST", "/api/tasks/FN-8004/retry", "{}", { "content-type": "application/json" });

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith(
      "FN-8004",
      expect.objectContaining({ status: null, error: null }),
    );
    expect(moveTask).not.toHaveBeenCalled();
  });
});
