import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, expect, it } from "vitest";
import { computePlanApprovalFingerprint, isTaskBlockedOnApproval, TaskStore } from "@fusion/core";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createApiRoutes } from "../routes.js";
import { request } from "../test-request.js";

pgDescribe("plan approval status persistence", () => {
  let harness: PgTestHarness;
  let store: TaskStore;

  beforeEach(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_plan_approval_status" });
    store = harness.store;
  });

  afterEach(async () => {
    await harness.teardown();
  });

  function createApp(appStore = store) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(appStore));
    return app;
  }

  function barrier() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  it("clears the approval hold and persists the approved plan fingerprint", async () => {
    const task = await store.createTask({ description: "Approve this plan" });
    await store.updateTask(task.id, {
      status: "awaiting-approval",
      approvedPlanFingerprint: "stale-fingerprint",
    });
    expect((await store.getTask(task.id)).approvedPlanFingerprint).toBe("stale-fingerprint");

    const prompt = "# Approved plan\n\nImplement the requested behavior.\n";
    const taskDir = join(harness.rootDir, ".fusion", "tasks", task.id);
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "PROMPT.md"), prompt, "utf8");

    const response = await request(createApp(), "POST", `/api/tasks/${task.id}/approve-plan`);

    expect(response.status).toBe(200);
    const persisted = await store.getTask(task.id);
    expect(persisted.status).toBeUndefined();
    expect(isTaskBlockedOnApproval(persisted)).toBe(false);
    expect(persisted.approvedPlanFingerprint).toBe(computePlanApprovalFingerprint(prompt));
    expect(response.body.approvedPlanFingerprint).toBe(persisted.approvedPlanFingerprint);
  });

  it.each(["failed", "advisory_failure"] as const)(
    "durably bypasses an exhausted %s Plan Review before clearing its approval hold",
    async (reviewStatus) => {
    const task = await store.createTask({ description: "Approve after Plan Review did not converge" });
    await store.updateTask(task.id, {
      status: "awaiting-approval",
      awaitingApprovalReason: "plan-review-replan-cap",
      workflowStepResults: [{
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        phase: "pre-merge",
        source: "optional-group",
        status: reviewStatus,
        verdict: "REVISE",
        output: "The plan still needs revision.",
        priorAttempts: [{
          workflowStepId: "plan-review",
          workflowStepName: "Plan Review",
          status: "failed",
          verdict: "REVISE",
          output: "Earlier revision request.",
        }],
      }],
    } as never);

    const taskDir = join(harness.rootDir, ".fusion", "tasks", task.id);
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "PROMPT.md"), "# Human-approved plan\n", "utf8");

    const response = await request(createApp(), "POST", `/api/tasks/${task.id}/approve-plan`);

    expect(response.status).toBe(200);
    const persisted = await store.getTask(task.id);
    expect(persisted.status).toBeUndefined();
    expect(persisted.awaitingApprovalReason).toBeUndefined();
    expect(persisted.workflowStepResults).toContainEqual(expect.objectContaining({
      workflowStepId: "plan-review",
      status: "skipped",
      bypassedBy: "dashboard-operator",
      bypassReason: "Approved after Plan Review did not converge",
      bypassedFromStatus: reviewStatus,
      bypassedFromVerdict: "REVISE",
      priorAttempts: [expect.objectContaining({ output: "Earlier revision request." })],
    }));
    expect(persisted.workflowStepResults?.[0]?.verdict).toBeUndefined();
    },
  );

  it("approves an exhausted Plan Review from a split workflow's review column", async () => {
    const task = await store.createTask({ description: "Approve legacy split-column review" });
    await store.writeTaskWorkflowSelection(task.id, "builtin:legacy-coding", []);
    await store.updateTask(task.id, {
      status: "awaiting-approval",
      awaitingApprovalReason: "plan-review-replan-cap",
      workflowStepResults: [{
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        status: "failed",
        verdict: "REVISE",
      }],
    } as never);

    const response = await request(createApp(), "POST", `/api/tasks/${task.id}/approve-plan`);

    expect(response.status).toBe(200);
    const persisted = await store.getTask(task.id);
    expect(persisted.column).toBe("todo");
    expect(persisted.status).toBeUndefined();
    expect(persisted.workflowStepResults).toContainEqual(expect.objectContaining({
      workflowStepId: "plan-review",
      status: "skipped",
      bypassedFromStatus: "failed",
      bypassedFromVerdict: "REVISE",
    }));
  });

  it("rejects an exhausted Plan Review from a split workflow's review column", async () => {
    const task = await store.createTask({ description: "Reject legacy split-column review" });
    await store.writeTaskWorkflowSelection(task.id, "builtin:legacy-coding", []);
    await store.updateTask(task.id, {
      status: "awaiting-approval",
      awaitingApprovalReason: "plan-review-replan-cap",
    } as never);

    const response = await request(createApp(), "POST", `/api/tasks/${task.id}/reject-plan`);

    expect(response.status).toBe(200);
    const persisted = await store.getTask(task.id);
    expect(persisted.column).toBe("todo");
    expect(persisted.status).toBeUndefined();
  });

  it.each(["approve-plan", "reject-plan"] as const)(
    "does not let stale %s overwrite dependency-first invalidation",
    async (endpoint) => {
      const task = await store.createTask({ description: "Dependency wins approval race" });
      const dependency = await store.createTask({ description: "New prerequisite", column: "done" });
      await store.updateTask(task.id, { status: "awaiting-approval" });

      const mutationStore = new TaskStore(harness.rootDir, undefined, { asyncLayer: harness.layer });
      await mutationStore.init();
      const mutationEntered = barrier();
      const allowMutation = barrier();
      const originalMutationLock = mutationStore.withPlanningLifecycleLock.bind(mutationStore);
      mutationStore.withPlanningLifecycleLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> =>
        originalMutationLock(id, async () => {
          mutationEntered.release();
          await allowMutation.promise;
          return await fn();
        });

      const approvalAttempted = barrier();
      const originalApprovalLock = store.withPlanningLifecycleLock.bind(store);
      store.withPlanningLifecycleLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
        approvalAttempted.release();
        return await originalApprovalLock(id, fn);
      };

      const mutation = mutationStore.updateTaskDependencies(task.id, {
        operation: "add",
        dependency: dependency.id,
      });
      await mutationEntered.promise;
      const approval = request(createApp(), "POST", `/api/tasks/${task.id}/${endpoint}`);
      await approvalAttempted.promise;
      allowMutation.release();

      await mutation;
      const response = await approval;
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("awaiting-approval");
      const persisted = await store.getTask(task.id);
      expect(persisted.status).toBe("needs-replan");
      expect(persisted.dependencies).toContain(dependency.id);
      expect(persisted.approvedPlanFingerprint).toBeUndefined();
    },
  );

  it("lets a later dependency invalidation supersede approval-first state", async () => {
    const task = await store.createTask({ description: "Approval precedes dependency" });
    const dependency = await store.createTask({ description: "Later prerequisite", column: "done" });
    await store.updateTask(task.id, { status: "awaiting-approval" });

    const mutationStore = new TaskStore(harness.rootDir, undefined, { asyncLayer: harness.layer });
    await mutationStore.init();
    const approvalEntered = barrier();
    const allowApproval = barrier();
    const originalApprovalLock = store.withPlanningLifecycleLock.bind(store);
    store.withPlanningLifecycleLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> =>
      originalApprovalLock(id, async () => {
        approvalEntered.release();
        await allowApproval.promise;
        return await fn();
      });

    const mutationAttempted = barrier();
    const originalMutationLock = mutationStore.withPlanningLifecycleLock.bind(mutationStore);
    mutationStore.withPlanningLifecycleLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      mutationAttempted.release();
      return await originalMutationLock(id, fn);
    };

    const approval = request(createApp(), "POST", `/api/tasks/${task.id}/approve-plan`);
    await approvalEntered.promise;
    const mutation = mutationStore.updateTaskDependencies(task.id, {
      operation: "add",
      dependency: dependency.id,
    });
    await mutationAttempted.promise;
    allowApproval.release();

    const response = await approval;
    expect(response.status).toBe(200);
    await mutation;
    const persisted = await store.getTask(task.id);
    expect(persisted.status).toBe("needs-replan");
    expect(persisted.dependencies).toContain(dependency.id);
    expect(persisted.approvedPlanFingerprint).toBeUndefined();
  });

  it("keeps the approval hold when cap metadata has no failed REVISE result", async () => {
    const task = await store.createTask({ description: "Malformed exhausted review state" });
    await store.updateTask(task.id, {
      status: "awaiting-approval",
      awaitingApprovalReason: "plan-review-replan-cap",
      workflowStepResults: [],
    } as never);

    const response = await request(createApp(), "POST", `/api/tasks/${task.id}/approve-plan`);

    expect(response.status).toBe(409);
    const persisted = await store.getTask(task.id);
    expect(persisted.status).toBe("awaiting-approval");
    expect(persisted.awaitingApprovalReason).toBe("plan-review-replan-cap");
  });

  it("clears a prior fingerprint when the approved plan cannot be read", async () => {
    const task = await store.createTask({ description: "Approve without a readable plan" });
    await store.updateTask(task.id, {
      status: "awaiting-approval",
      approvedPlanFingerprint: "stale-fingerprint",
    });
    await rm(join(harness.rootDir, ".fusion", "tasks", task.id, "PROMPT.md"), { force: true });
    expect((await store.getTask(task.id)).approvedPlanFingerprint).toBe("stale-fingerprint");

    const response = await request(createApp(), "POST", `/api/tasks/${task.id}/approve-plan`);

    expect(response.status).toBe(200);
    const persisted = await store.getTask(task.id);
    expect(persisted.status).toBeUndefined();
    expect(isTaskBlockedOnApproval(persisted)).toBe(false);
    expect(persisted.approvedPlanFingerprint).toBeUndefined();
    expect(response.body.approvedPlanFingerprint).toBeUndefined();
  });

  it("clears the approval hold and stale fingerprint when rejecting a plan", async () => {
    const task = await store.createTask({ description: "Reject this plan" });
    await store.updateTask(task.id, {
      status: "awaiting-approval",
      approvedPlanFingerprint: "stale-fingerprint",
    });
    expect((await store.getTask(task.id)).approvedPlanFingerprint).toBe("stale-fingerprint");

    const response = await request(createApp(), "POST", `/api/tasks/${task.id}/reject-plan`);

    expect(response.status).toBe(200);
    const persisted = await store.getTask(task.id);
    expect(persisted.status).toBeUndefined();
    expect(isTaskBlockedOnApproval(persisted)).toBe(false);
    expect(persisted.approvedPlanFingerprint).toBeUndefined();
  });

  it("keeps the approval hold when the rejected plan cannot be removed", async () => {
    /*
     * FNXC:PlanApproval 2026-08-03-19:12 UTC:
     * A rejected plan stays blocked and retains its approved fingerprint when
     * PROMPT.md removal fails; only a successful removal may release the hold.
     */
    const task = await store.createTask({ description: "Reject a plan that cannot be removed" });
    await store.updateTask(task.id, {
      status: "awaiting-approval",
      approvedPlanFingerprint: "rejected-fingerprint",
    });

    const promptPath = join(harness.rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
    await rm(promptPath, { force: true });
    await mkdir(promptPath, { recursive: true });
    await writeFile(join(promptPath, "nested-plan.md"), "# Rejected plan\n", "utf8");

    const response = await request(createApp(), "POST", `/api/tasks/${task.id}/reject-plan`);

    expect(response.status).toBe(500);
    expect(response.body.error).toContain("PROMPT.md");
    const persisted = await store.getTask(task.id);
    expect(persisted.status).toBe("awaiting-approval");
    expect(isTaskBlockedOnApproval(persisted)).toBe(true);
    expect(persisted.approvedPlanFingerprint).toBe("rejected-fingerprint");
    expect(persisted.log).toContainEqual(expect.objectContaining({
      action: "Plan rejected by user",
      outcome: "Specification will be regenerated",
    }));
  });
});
