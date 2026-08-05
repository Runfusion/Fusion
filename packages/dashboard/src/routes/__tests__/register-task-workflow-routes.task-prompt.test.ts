// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-PROMPT", title: "Prompt task", description: "Detail must stay private", column: "queued",
    status: "queued", dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", prompt: "# Current definition",
    ...overrides,
  } as Task;
}

function scopedApp(stores: Record<string, TaskStore>) {
  const engineManager = {
    getEngine: vi.fn((projectId: string) => ({ getTaskStore: () => stores[projectId] })),
    onProjectAccessed: vi.fn(),
  };
  const app = express();
  app.use("/api", createApiRoutes({
    getRootDir: () => process.cwd(),
    getProjectScopedPluginMcpServers: async () => [],
    getSettingsFast: async () => ({}),
    getPluginStore: () => ({}),
  } as unknown as TaskStore, { engineManager } as never));
  return { app, engineManager };
}

describe("task prompt route registration", () => {
  it("matches the literal prompt route before task detail and returns its narrow shape", async () => {
    const getTask = vi.fn(async (id: string) => {
      if (id !== "FN-PROMPT") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return task();
    });
    const store = {
      getRootDir: vi.fn(() => process.cwd()), getProjectScopedPluginMcpServers: vi.fn(async () => []),
      getSettingsFast: vi.fn(async () => ({})), getTask,
    } as unknown as TaskStore;
    const app = express();
    app.use("/api", createApiRoutes(store));

    const response = await REQUEST(app, "GET", "/api/tasks/FN-PROMPT/prompt");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: "FN-PROMPT", prompt: "# Current definition" });
    expect(Object.keys(response.body)).toEqual(["id", "prompt"]);
    expect(getTask).toHaveBeenCalledWith("FN-PROMPT");
    expect((await REQUEST(app, "GET", "/api/tasks/unknown/prompt")).status).toBe(404);
  });

  it("preserves empty and absent prompts without serializing lifecycle fields", async () => {
    const store = {
      getRootDir: vi.fn(() => process.cwd()), getProjectScopedPluginMcpServers: vi.fn(async () => []),
      getSettingsFast: vi.fn(async () => ({})), getTask: vi.fn(async (id: string) => task({ prompt: id === "FN-EMPTY" ? "" : undefined })),
    } as unknown as TaskStore;
    const app = express();
    app.use("/api", createApiRoutes(store));
    expect(await REQUEST(app, "GET", "/api/tasks/FN-EMPTY/prompt")).toMatchObject({ status: 200, body: { id: "FN-PROMPT", prompt: "" } });
    expect(await REQUEST(app, "GET", "/api/tasks/FN-PROMPT/prompt")).toMatchObject({ status: 200, body: { id: "FN-PROMPT" } });
  });

  it("uses the selected project store and maps task misses and ordinary errors", async () => {
    const projectA = {
      getPluginStore: () => ({ init: async () => {} }),
      getProjectScopedPluginMcpServers: async () => [],
      getRootDir: () => process.cwd(),
      getTask: vi.fn(async (id: string) => id === "FN-PROMPT" ? task({ id }) : Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }))),
    } as unknown as TaskStore;
    const projectB = {
      getPluginStore: () => ({ init: async () => {} }),
      getProjectScopedPluginMcpServers: async () => [],
      getRootDir: () => process.cwd(),
      getTask: vi.fn(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }),
    } as unknown as TaskStore;
    const broken = {
      getPluginStore: () => ({ init: async () => {} }),
      getProjectScopedPluginMcpServers: async () => [],
      getRootDir: () => process.cwd(),
      getTask: vi.fn(async () => { throw new Error("database offline"); }),
    } as unknown as TaskStore;
    const { app, engineManager } = scopedApp({ "project-a": projectA, "project-b": projectB, broken });

    expect((await REQUEST(app, "GET", "/api/tasks/FN-PROMPT/prompt?projectId=project-a")).body).toEqual({ id: "FN-PROMPT", prompt: "# Current definition" });
    expect((await REQUEST(app, "GET", "/api/tasks/FN-PROMPT/prompt?projectId=project-b")).status).toBe(404);
    expect((await REQUEST(app, "GET", "/api/tasks/unknown/prompt?projectId=project-a")).status).toBe(404);
    expect((await REQUEST(app, "GET", "/api/tasks/FN-PROMPT/prompt?projectId=broken")).status).toBe(500);
    expect(engineManager.getEngine).toHaveBeenCalledWith("project-a");
    expect(projectA.getTask).toHaveBeenCalledWith("FN-PROMPT");
    expect(projectB.getTask).toHaveBeenCalledWith("FN-PROMPT");
  });
});
