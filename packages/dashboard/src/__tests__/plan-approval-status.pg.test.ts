import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR, computePlanApprovalFingerprint, isTaskBlockedOnApproval, TaskStore } from "@fusion/core";
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

  /** FNXC:SpecLock 2026-08-09-17:37: approval-path fixtures need a structurally available plan because malformed Mission evidence now fails closed. */
  async function writeLockablePrompt(taskId: string): Promise<void> {
    const taskDir = join(harness.rootDir, ".fusion", "tasks", taskId);
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "PROMPT.md"), "## Mission\n\nImplement the approved plan.\n\n## File Scope\n\n- src/**\n\n## Steps\n\n- Implement it\n", "utf8");
  }

  it("clears the approval hold and persists the approved plan fingerprint", async () => {
    const task = await store.createTask({ description: "Approve this plan" });
    await store.updateTask(task.id, {
      status: "awaiting-approval",
      approvedPlanFingerprint: "stale-fingerprint",
    });
    expect((await store.getTask(task.id)).approvedPlanFingerprint).toBe("stale-fingerprint");

    const prompt = "# Approved plan\n\n## Mission\n\nImplement the requested behavior.\n\n## File Scope\n\n- src/**\n\n## Steps\n\n- Implement it\n";
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

    // FNXC:SpecLockApproval 2026-08-09-19:51: the manual release route must append the
    // immutable lock and a current deterministic report before graph execution can resume.
    await expect(store.getActiveSpecLock(task.id)).resolves.toMatchObject({
      version: 1,
      approvalFingerprint: persisted.approvedPlanFingerprint,
    });
    await expect(store.getLatestSpecDriftReport(task.id)).resolves.toMatchObject({
      alignment: "on-plan",
      lockVersion: 1,
      currentPlanVersion: 1,
    });
  });

  it("does not rewrite locked Mission evidence during a description-only synchronization", async () => {
    const task = await store.createTask({ description: "Initial description" });
    const prompt = "# Approved plan\n\n## Mission\n\nKeep this locked Mission statement.\n\n## File Scope\n\n- src/**\n\n## Steps\n\n- Implement it\n";
    const taskDir = join(harness.rootDir, ".fusion", "tasks", task.id);
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "PROMPT.md"), prompt, "utf8");
    await store.updateTask(task.id, { status: "awaiting-approval" });
    expect((await request(createApp(), "POST", `/api/tasks/${task.id}/approve-plan`)).status).toBe(200);

    await store.updateTask(task.id, { description: "Cosmetic task description update" });

    await expect(store.getActiveSpecLock(task.id)).resolves.toMatchObject({ version: 1 });
    await expect(store.getLatestSpecDriftReport(task.id)).resolves.toMatchObject({ alignment: "on-plan" });
    expect(await readFile(join(taskDir, "PROMPT.md"), "utf8")).toContain("## Mission\n\nKeep this locked Mission statement.");
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
    await writeFile(join(taskDir, "PROMPT.md"), "# Human-approved plan\n\n## Mission\n\nImplement the approved plan.\n\n## File Scope\n\n- src/**\n\n## Steps\n\n- Implement it\n", "utf8");

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
    await writeLockablePrompt(task.id);

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

  it("keeps a split-column approval blocked and retryable when the final hold clear fails", async () => {
    const task = await store.createTask({ description: "Retry interrupted split-column approval" });
    const splitWorkflow = await store.createWorkflowDefinition({
      name: "Split Plan Review approval",
      ir: {
        ...BUILTIN_CODING_WORKFLOW_IR,
        id: "split-plan-review-approval",
        nodes: BUILTIN_CODING_WORKFLOW_IR.nodes.map((node) =>
          node.id === "plan-review" ? { ...node, column: "in-review" } : node
        ),
      },
    });
    await store.selectTaskWorkflow(task.id, splitWorkflow.id);
    await store.moveTask(task.id, "in-review", {
      moveSource: "engine",
      recoveryRehome: true,
      bypassGuards: true,
    });
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
    await writeLockablePrompt(task.id);

    const originalUpdate = store.updateTask.bind(store);
    let approvalUpdates = 0;
    store.updateTask = (async (id, updates, runContext) => {
      if (id === task.id && updates.status !== undefined) {
        approvalUpdates += 1;
        if (approvalUpdates === 2) throw new Error("injected final approval write failure");
      }
      return originalUpdate(id, updates, runContext);
    }) as typeof store.updateTask;

    try {
      const interrupted = await request(createApp(), "POST", `/api/tasks/${task.id}/approve-plan`);
      expect(interrupted.status).toBe(500);
      const persisted = await store.getTask(task.id);
      expect(persisted.column).toBe("todo");
      expect(persisted.status).toBe("awaiting-approval");
      expect(persisted.workflowStepResults).toContainEqual(expect.objectContaining({
        workflowStepId: "plan-review",
        status: "skipped",
        bypassedBy: "dashboard-operator",
      }));
    } finally {
      store.updateTask = originalUpdate;
    }

    const retried = await request(createApp(), "POST", `/api/tasks/${task.id}/approve-plan`);
    expect(retried.status).toBe(200);
    const persisted = await store.getTask(task.id);
    expect(persisted.status).toBeUndefined();
    expect(persisted.workflowStepResults).toContainEqual(expect.objectContaining({
      workflowStepId: "plan-review",
      status: "skipped",
      bypassedBy: "dashboard-operator",
    }));
  });

  it("rejects an exhausted Plan Review from a split workflow's review column", async () => {
    const task = await store.createTask({ description: "Reject split-column review" });
    const splitWorkflow = await store.createWorkflowDefinition({
      name: "Split Plan Review rejection",
      ir: {
        ...BUILTIN_CODING_WORKFLOW_IR,
        id: "split-plan-review-rejection",
        nodes: BUILTIN_CODING_WORKFLOW_IR.nodes.map((node) =>
          node.id === "plan-review" ? { ...node, column: "in-review" } : node
        ),
      },
    });
    await store.selectTaskWorkflow(task.id, splitWorkflow.id);
    const intakeColumn = BUILTIN_CODING_WORKFLOW_IR.columns.find((column) =>
      column.traits.some((trait) => trait.trait === "intake")
    )!.id;
    await store.moveTask(task.id, "in-review", {
      moveSource: "engine",
      recoveryRehome: true,
      bypassGuards: true,
    });
    await store.updateTask(task.id, {
      status: "awaiting-approval",
      awaitingApprovalReason: "plan-review-replan-cap",
    });

    const originalUpdate = store.updateTask.bind(store);
    let interruptFinalClear = true;
    store.updateTask = (async (id, updates, runContext) => {
      if (interruptFinalClear && updates.status === null && updates.approvedPlanFingerprint === null) {
        interruptFinalClear = false;
        throw new Error("simulated final reject clear interruption");
      }
      return originalUpdate(id, updates, runContext);
    }) as typeof store.updateTask;

    try {
      const interrupted = await request(createApp(), "POST", `/api/tasks/${task.id}/reject-plan`);
      expect(interrupted.status).toBe(500);
      const partiallyRejected = await store.getTask(task.id);
      expect(partiallyRejected.column).toBe(intakeColumn);
      expect(partiallyRejected.status).toBe("awaiting-approval");
      expect(partiallyRejected.awaitingApprovalReason).toBe("plan-review-replan-cap");
    } finally {
      store.updateTask = originalUpdate;
    }

    const response = await request(createApp(), "POST", `/api/tasks/${task.id}/reject-plan`);

    expect(response.status).toBe(200);
    const persisted = await store.getTask(task.id);
    expect(persisted.column).toBe(intakeColumn);
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

      try {
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
      } finally {
        allowMutation.release();
        mutationStore.withPlanningLifecycleLock = originalMutationLock;
        store.withPlanningLifecycleLock = originalApprovalLock;
      }
    },
  );

  it("lets a later dependency invalidation supersede approval-first state", async () => {
    const task = await store.createTask({ description: "Approval precedes dependency" });
    const dependency = await store.createTask({ description: "Later prerequisite", column: "done" });
    await store.updateTask(task.id, { status: "awaiting-approval" });
    await writeLockablePrompt(task.id);

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

    try {
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
    } finally {
      allowApproval.release();
      store.withPlanningLifecycleLock = originalApprovalLock;
      mutationStore.withPlanningLifecycleLock = originalMutationLock;
    }
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

  it("keeps the approval hold when the plan cannot be read for a spec lock", async () => {
    const task = await store.createTask({ description: "Approve without a readable plan" });
    await store.updateTask(task.id, {
      status: "awaiting-approval",
      approvedPlanFingerprint: "stale-fingerprint",
    });
    await rm(join(harness.rootDir, ".fusion", "tasks", task.id, "PROMPT.md"), { force: true });
    expect((await store.getTask(task.id)).approvedPlanFingerprint).toBe("stale-fingerprint");

    const response = await request(createApp(), "POST", `/api/tasks/${task.id}/approve-plan`);

    expect(response.status).toBe(409);
    const persisted = await store.getTask(task.id);
    expect(persisted.status).toBe("awaiting-approval");
    expect(isTaskBlockedOnApproval(persisted)).toBe(true);
    expect(persisted.approvedPlanFingerprint).toBe("stale-fingerprint");
    await expect(store.getLatestSpecLock(task.id)).resolves.toBeUndefined();
  });

  it("invalidates an accepted lock for removed and replaced dependencies", async () => {
    const task = await store.createTask({ description: "Dependency changes invalidate the lock" });
    const first = await store.createTask({ description: "First prerequisite", column: "done" });
    const replacement = await store.createTask({ description: "Replacement prerequisite", column: "done" });
    await writeLockablePrompt(task.id);
    await store.updateTask(task.id, { status: "awaiting-approval" });
    expect((await request(createApp(), "POST", `/api/tasks/${task.id}/approve-plan`)).status).toBe(200);
    expect((await store.getTask(task.id)).approvedPlanFingerprint).toBeTruthy();

    await store.updateTaskDependencies(task.id, { operation: "add", dependency: first.id });
    await store.updateTask(task.id, { status: "awaiting-approval" });
    expect((await request(createApp(), "POST", `/api/tasks/${task.id}/approve-plan`)).status).toBe(200);
    await store.updateTaskDependencies(task.id, { operation: "replace", from: first.id, to: replacement.id });

    const afterReplace = await store.getTask(task.id);
    expect(afterReplace.approvedPlanFingerprint).toBeUndefined();
    // FNXC:SpecLock 2026-08-10-16:40: A dependency replacement invalidates admission but remains
    // structurally comparable to the retained lock, so the roadmap receives divergence—not silence.
    expect((await store.getLatestSpecDriftReport(task.id))?.alignment).toBe("diverged-needs-review");

    await store.updateTask(task.id, { status: "awaiting-approval" });
    expect((await request(createApp(), "POST", `/api/tasks/${task.id}/approve-plan`)).status).toBe(200);
    await store.updateTaskDependencies(task.id, { operation: "remove", dependency: replacement.id });
    expect((await store.getTask(task.id)).approvedPlanFingerprint).toBeUndefined();
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
