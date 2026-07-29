// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

function createHarness() {
  const task = {
    id: "FN-001",
    description: "legacy checklist task",
    column: "in-review",
    dependencies: [],
    steps: [
      { title: "Implement", status: "pending" },
      { title: "Verify", status: "pending" },
    ],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  } as any;
  const updateStep = vi.fn(async (_id: string, index: number, status: string) => {
    task.steps[index].status = status;
    return task;
  });
  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
    getTask: vi.fn(async () => task),
    updateStep,
  } as unknown as TaskStore;
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, updateStep };
}

describe("task checklist step update route", () => {
  it("updates one step through the live project store", async () => {
    const { app, updateStep } = createHarness();
    const response = await REQUEST(
      app,
      "PATCH",
      "/api/tasks/FN-001/steps/1",
      JSON.stringify({ status: "done" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(updateStep).toHaveBeenCalledWith("FN-001", 1, "done");
    expect((response.body as { steps: Array<{ status: string }> }).steps[1].status).toBe("done");
  });

  it.each([
    ["not-an-index", { status: "done" }],
    ["-1", { status: "done" }],
    ["0", { status: "invalid" }],
  ])("rejects invalid step update %s", async (index, body) => {
    const { app, updateStep } = createHarness();
    const response = await REQUEST(
      app,
      "PATCH",
      `/api/tasks/FN-001/steps/${index}`,
      JSON.stringify(body),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(updateStep).not.toHaveBeenCalled();
  });
});
