// @vitest-environment node
/*
FNXC:HumanPlanApproval 2026-09-15-06:24:
FN-408 — the approve/reject routes carry the operator's message and are the ONLY producers of the
per-card release proof. This suite drives the real Express routes so the durable decision, its
identity fences, and the two different message destinations are all exercised end to end.

Surface enumeration:
  • Decision shapes: approve with note, approve without note, reject with message, reject without.
  • Message validation: Unicode, blank, over-long, non-string.
  • Identity fences: decide before Plan Review is satisfied, stale plan fingerprint, stale episode.
  • Concurrency: replayed requestId (idempotent) and opposite decision for the same request.
  • A card WITHOUT the option keeps the historical behavior (PROMPT.md deleted on reject).
*/
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { HUMAN_PLAN_APPROVAL_MESSAGE_MAX_LENGTH, computePlanApprovalFingerprint } from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

const EPISODE = "2026-09-15T06:20:00.000Z";
const TASK_ID = "FN-408";
const PLAN_TEXT = "# Existing plan\n\n## Steps\n\n### Step 0: Preflight\n";
/* The row's approved fingerprint must be the real hash of the on-disk plan, exactly as Plan Review writes it. */
const PLAN_FINGERPRINT = computePlanApprovalFingerprint(PLAN_TEXT);

const IR = {
  version: "v2",
  name: "human-plan-approval",
  columns: [
    { id: "planning", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "planning" },
    { id: "plan-review", kind: "optional-group", column: "planning", config: { name: "Plan Review", defaultOn: true, template: { nodes: [], edges: [] } } },
    { id: "execute", kind: "execute", column: "building" },
  ],
  edges: [{ from: "start", to: "plan-review" }, { from: "plan-review", to: "execute" }],
} as never;

function planReviewPassed(completedAt = EPISODE, over: Record<string, unknown> = {}) {
  return {
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    status: "passed",
    completedAt,
    ...over,
  };
}

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "Validation humaine",
    description: "Ajouter une validation humaine du plan par carte",
    column: "planning",
    status: "awaiting-approval",
    awaitingApprovalReason: "human-plan-approval",
    approvedPlanFingerprint: PLAN_FINGERPRINT,
    humanPlanApproval: { enabled: true },
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [planReviewPassed()],
    createdAt: "2026-09-15T06:00:00.000Z",
    updatedAt: "2026-09-15T06:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(row: Task, rootDir: string): TaskStore {
  const applyPatch = (patch: Partial<Task>) => {
    for (const [key, value] of Object.entries(patch)) {
      (row as unknown as Record<string, unknown>)[key] = value;
    }
  };
  return {
    getRootDir: vi.fn(() => rootDir),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getTask: vi.fn(async () => structuredClone(row)),
    listTasks: vi.fn(async () => [structuredClone(row)]),
    searchTasks: vi.fn().mockResolvedValue([]),
    findRecentTasksBySourceParentTaskId: vi.fn().mockResolvedValue([]),
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "wf-hpa" }),
    getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "wf-hpa", name: "HPA", ir: IR }),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      applyPatch(patch);
      return structuredClone(row);
    }),
    moveTask: vi.fn(async (_id: string, column: string) => {
      row.column = column;
      return structuredClone(row);
    }),
    // The real routes run every decision inside the planning lifecycle lock; the fake must too,
    // or the WhilePlanningLocked writes below would be exercised outside the fence they require.
    withPlanningLifecycleLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    lockCurrentPlanWhilePlanningLocked: vi.fn().mockResolvedValue(undefined),
    reconcileSpecDriftWhilePlanningLocked: vi.fn().mockResolvedValue(undefined),
    listWorkflowWorkItemsForTask: vi.fn().mockResolvedValue([]),
    replaceActiveTaskWorkflowContinuation: vi.fn().mockResolvedValue({ id: "wi-1" }),
    // Approval resumes the graph through the public engine seam; it must not re-run Plan Review.
    seedStrandedPlanReviewContinuation: vi.fn().mockResolvedValue({ seeded: false, reason: "plan-review-passed" }),
    transitionWorkflowWorkItem: vi.fn().mockResolvedValue(null),
    getWorkflowWorkItem: vi.fn().mockResolvedValue(null),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;
}

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(overrides: Partial<Task> = {}) {
  const root = await mkdtemp(join(tmpdir(), "fusion-fn408-route-"));
  roots.push(root);
  const taskDir = join(root, ".fusion", "tasks", TASK_ID);
  await mkdir(taskDir, { recursive: true });
  const promptPath = join(taskDir, "PROMPT.md");
  await writeFile(promptPath, PLAN_TEXT);
  const row = taskFixture(overrides);
  const store = createStore(row, root);
  return { root, promptPath, row, store, app: createApp(store) };
}

function post(app: express.Express, path: string, body: unknown) {
  return performRequest(app, "POST", path, JSON.stringify(body ?? {}), { "Content-Type": "application/json" });
}

describe("POST /tasks/:id/approve-plan — per-card human decision", () => {
  it("persists the operator note as durable release proof and clears the hold", async () => {
    const { row, app } = await setup();

    const response = await post(app, `/api/tasks/${TASK_ID}/approve-plan`, {
      message: "  Fais attention aux migrations ✅  ",
      requestId: "req-approve-1",
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(row.status).toBeNull();
    expect(row.awaitingApprovalReason).toBeNull();
    expect(row.humanPlanApproval).toMatchObject({
      enabled: true,
      decision: {
        requestId: "req-approve-1",
        decision: "approved",
        // Trimmed, Unicode preserved, stored as plain text.
        message: "Fais attention aux migrations ✅",
        decidedBy: "dashboard-operator",
        // The proof pins the fingerprint the route actually persisted, so it satisfies its own gate.
        planFingerprint: PLAN_FINGERPRINT,
        planningEpisodeId: EPISODE,
      },
    });
    expect(row.approvedPlanFingerprint).toBe(row.humanPlanApproval?.decision?.planFingerprint);
  });

  it("refuses when the plan on disk drifted away from the reviewed plan", async () => {
    const { row, promptPath, app } = await setup();
    await writeFile(promptPath, "# A completely different plan\n\n## Steps\n\n### Step 0: Other\n");

    const response = await post(app, `/api/tasks/${TASK_ID}/approve-plan`, { message: "ok" });

    expect(response.status).toBe(409);
    expect(row.humanPlanApproval?.decision).toBeUndefined();
    expect(row.status).toBe("awaiting-approval");
  });

  it("accepts an approval with no note at all", async () => {
    const { row, app } = await setup();

    const response = await post(app, `/api/tasks/${TASK_ID}/approve-plan`, { requestId: "req-bare" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(row.humanPlanApproval?.decision?.decision).toBe("approved");
    expect(row.humanPlanApproval?.decision?.message).toBeUndefined();
  });

  it("treats a blank message as no message", async () => {
    const { row, app } = await setup();

    await post(app, `/api/tasks/${TASK_ID}/approve-plan`, { message: "   \n  " });

    expect(row.humanPlanApproval?.decision?.message).toBeUndefined();
  });

  it("refuses a non-string message", async () => {
    const { row, app } = await setup();

    const response = await post(app, `/api/tasks/${TASK_ID}/approve-plan`, { message: 42 });

    expect(response.status).toBe(400);
    expect(row.humanPlanApproval?.decision).toBeUndefined();
  });

  it("refuses an over-long message and persists nothing", async () => {
    const { row, app } = await setup();

    const response = await post(app, `/api/tasks/${TASK_ID}/approve-plan`, {
      message: "x".repeat(HUMAN_PLAN_APPROVAL_MESSAGE_MAX_LENGTH + 1),
    });

    expect(response.status).toBe(400);
    expect(row.status).toBe("awaiting-approval");
    expect(row.humanPlanApproval?.decision).toBeUndefined();
  });

  it("refuses a decision opened against a plan that has since changed", async () => {
    const { row, app } = await setup();

    const response = await post(app, `/api/tasks/${TASK_ID}/approve-plan`, {
      expectedPlanFingerprint: "a-plan-that-is-no-longer-current",
    });

    expect(response.status).toBe(409);
    expect(row.status).toBe("awaiting-approval");
    expect(row.humanPlanApproval?.decision).toBeUndefined();
  });

  it("refuses a decision opened against an earlier review episode (stale tab)", async () => {
    const { row, app } = await setup();

    const response = await post(app, `/api/tasks/${TASK_ID}/approve-plan`, {
      expectedEpisodeId: "2026-01-01T00:00:00.000Z",
    });

    expect(response.status).toBe(409);
    expect(row.humanPlanApproval?.decision).toBeUndefined();
  });

  it("refuses a decision while Plan Review is not satisfied", async () => {
    const { row, app } = await setup({
      workflowStepResults: [planReviewPassed(EPISODE, { status: "failed", verdict: "REVISE" })] as never,
    });

    const response = await post(app, `/api/tasks/${TASK_ID}/approve-plan`, {});

    expect(response.status).toBe(409);
    expect(row.humanPlanApproval?.decision).toBeUndefined();
  });

  it("is idempotent when the same requestId is replayed (double click)", async () => {
    const { row, app } = await setup();

    const first = await post(app, `/api/tasks/${TASK_ID}/approve-plan`, { message: "note", requestId: "same" });
    expect(first.status).toBe(200);
    const decidedAt = row.humanPlanApproval?.decision?.decidedAt;

    // Re-park the hold as the engine would if the graph re-published it, then replay.
    row.status = "awaiting-approval";
    const second = await post(app, `/api/tasks/${TASK_ID}/approve-plan`, { message: "note", requestId: "same" });

    expect(second.status).toBe(200);
    expect(row.humanPlanApproval?.decision?.decidedAt).toBe(decidedAt);
    expect(row.status).toBeNull();
  });

  it("refuses the opposite decision for an already-resolved request", async () => {
    const { row, app } = await setup();

    expect((await post(app, `/api/tasks/${TASK_ID}/approve-plan`, { requestId: "dup" })).status).toBe(200);
    row.status = "awaiting-approval";

    const opposite = await post(app, `/api/tasks/${TASK_ID}/reject-plan`, { requestId: "dup" });

    expect(opposite.status).toBe(409);
    expect(row.humanPlanApproval?.decision?.decision).toBe("approved");
  });
});

describe("POST /tasks/:id/reject-plan — per-card human decision", () => {
  it("preserves PROMPT.md, retires the review evidence, and sends the message to the planner", async () => {
    const { promptPath, row, store, app } = await setup();

    const response = await post(app, `/api/tasks/${TASK_ID}/reject-plan`, {
      message: "Le périmètre est trop large, recentre sur la création",
      requestId: "req-reject-1",
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    // The rejected plan stays as revision source — it is NOT deleted for this branch.
    await expect(readFile(promptPath, "utf8")).resolves.toContain("# Existing plan");
    expect(row.status).toBe("needs-replan");
    expect(row.approvedPlanFingerprint).toBeNull();
    // The old review episode is retired, so the regenerated plan starts a new one.
    expect(row.workflowStepResults?.[0]).toMatchObject({ supersededReason: "respecify" });
    // The card keeps the per-card requirement.
    expect(row.humanPlanApproval?.enabled).toBe(true);
    expect(row.humanPlanApproval?.decision).toMatchObject({ decision: "rejected", requestId: "req-reject-1" });
    // The message goes to the PLANNER, through the feedback channel triage reads.
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      "AI spec revision requested",
      "Le périmètre est trop large, recentre sur la création",
    );
  });

  it("stays in the planning column rather than moving backward to intake", async () => {
    const { row, store, app } = await setup();

    await post(app, `/api/tasks/${TASK_ID}/reject-plan`, { message: "recommence" });

    expect(row.column).toBe("planning");
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("accepts a rejection with no message", async () => {
    const { row, app } = await setup();

    const response = await post(app, `/api/tasks/${TASK_ID}/reject-plan`, {});

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(row.humanPlanApproval?.decision?.decision).toBe("rejected");
    expect(row.humanPlanApproval?.decision?.message).toBeUndefined();
  });

  it("refuses an over-long rejection message and persists nothing", async () => {
    const { promptPath, row, app } = await setup();

    const response = await post(app, `/api/tasks/${TASK_ID}/reject-plan`, {
      message: "x".repeat(HUMAN_PLAN_APPROVAL_MESSAGE_MAX_LENGTH + 1),
    });

    expect(response.status).toBe(400);
    expect(row.status).toBe("awaiting-approval");
    await expect(readFile(promptPath, "utf8")).resolves.toContain("# Existing plan");
  });
});

describe("cards without the per-card option keep the historical behavior", () => {
  it("rejects by deleting PROMPT.md as before", async () => {
    const { promptPath, row, app } = await setup({
      humanPlanApproval: undefined,
      awaitingApprovalReason: undefined,
    });

    const response = await post(app, `/api/tasks/${TASK_ID}/reject-plan`, {});

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await expect(readFile(promptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(row.approvedPlanFingerprint).toBeNull();
    expect(row.humanPlanApproval).toBeUndefined();
  });

  it("approves without writing any decision record", async () => {
    const { row, app } = await setup({
      humanPlanApproval: undefined,
      awaitingApprovalReason: undefined,
    });

    const response = await post(app, `/api/tasks/${TASK_ID}/approve-plan`, {});

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(row.status).toBeNull();
    expect(row.humanPlanApproval).toBeUndefined();
  });

  it("ignores identity fences it never armed", async () => {
    const { app } = await setup({ humanPlanApproval: undefined, awaitingApprovalReason: undefined });

    const response = await post(app, `/api/tasks/${TASK_ID}/approve-plan`, {
      expectedPlanFingerprint: "irrelevant-for-legacy-cards",
    });

    expect(response.status).toBe(200);
  });
});
