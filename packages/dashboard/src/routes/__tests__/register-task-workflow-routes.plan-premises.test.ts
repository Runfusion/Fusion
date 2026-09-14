// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const IR = {
  version: "v2", id: "premise-route", name: "Premise route",
  columns: [
    { id: "planning", name: "Planning", traits: [{ trait: "hold", config: { release: "manual" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
  ], nodes: [], edges: [],
};

describe("POST /tasks/:id/move plan-premise admission", () => {
  it("fails closed before allocation or movement when workflow resolution is unavailable", async () => {
    const task = {
      id: "FN-375-U", title: "unavailable", description: "unavailable", column: "planning", status: null,
      dependencies: [], steps: [], currentStep: 0, log: [],
      prompt: '# Planned\n\n## Plan Premises\n\n- {"kind":"file-exists","path":"package.json"}\n',
    } as Task;
    const moveTask = vi.fn();
    const moveTaskIf = vi.fn();
    const getSettings = vi.fn(async () => ({}));
    const store = {
      getRootDir: () => process.cwd(),
      getProjectScopedPluginMcpServers: vi.fn(async () => []),
      getTask: vi.fn(async () => task),
      getSettings,
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "premise-route", stepIds: [] })),
      getWorkflowDefinition: vi.fn(async () => { throw new Error("workflow store unavailable"); }),
      moveTask,
      moveTaskIf,
    } as unknown as TaskStore;
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const response = await REQUEST(app, "POST", `/api/tasks/${task.id}/move`, JSON.stringify({ column: "in-progress", expectedColumn: "planning" }), { "content-type": "application/json" });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ details: { code: "workflow-resolution-unavailable", retryable: true } });
    expect(task).toMatchObject({ column: "planning", status: null });
    expect(getSettings).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
    expect(moveTaskIf).not.toHaveBeenCalled();
  });

  it("keeps a stale plan in planning and never allocates or moves", async () => {
    const task = {
      id: "FN-375-R", title: "stale", description: "stale", column: "planning", status: null,
      dependencies: [], steps: [], currentStep: 0, log: [],
      prompt: '# Planned\n\n## Plan Premises\n\n- {"kind":"text-present","path":"package.json","literal":"alphaUpdatesEnabled"}\n',
    } as Task;
    const moveTask = vi.fn();
    const moveTaskIf = vi.fn();
    const logEntry = vi.fn(async (_id: string, message: string) => task.log.push({ timestamp: new Date().toISOString(), message } as never));
    const store = {
      getRootDir: () => process.cwd(),
      getProjectScopedPluginMcpServers: vi.fn(async () => []),
      getTask: vi.fn(async () => task),
      getSettings: vi.fn(async () => ({})),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "premise-route", stepIds: [] })),
      getWorkflowDefinition: vi.fn(async () => ({ id: "premise-route", ir: IR })),
      getActivePrEntityBySource: vi.fn(async () => null),
      updateTaskAtomic: vi.fn(async (_id: string, mutate: (live: Task) => Partial<Task> | null | Promise<Partial<Task> | null>) => { const patch = await mutate(task); if (patch) Object.assign(task, patch); return task; }),
      logEntry,
      moveTask,
      moveTaskIf,
    } as unknown as TaskStore;
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const response = await REQUEST(app, "POST", `/api/tasks/${task.id}/move`, JSON.stringify({ column: "building", expectedColumn: "planning" }), { "content-type": "application/json" });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ details: { code: "plan-premise-stale", retryable: false } });
    expect(task).toMatchObject({ column: "planning", status: "needs-replan", error: null });
    expect(logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("alphaUpdatesEnabled"));
    expect(moveTask).not.toHaveBeenCalled();
    expect(moveTaskIf).not.toHaveBeenCalled();
  });
});
