import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, expect, it } from "vitest";
import { computePlanApprovalFingerprint, isTaskBlockedOnApproval, type TaskStore } from "@fusion/core";
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

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
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
});
