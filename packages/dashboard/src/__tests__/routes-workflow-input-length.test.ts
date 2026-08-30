// @vitest-environment node

import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request } from "../test-request.js";

describe("POST /tasks/:taskId/workflow/input", () => {
  it("keeps await-input steering uncapped above the former task-message limit", async () => {
    const text = "a".repeat(5_000);
    const store = {
      getRootDir: vi.fn().mockReturnValue("/fake/root"),
      getAsyncLayer: vi.fn().mockReturnValue(null),
      getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
      addSteeringComment: vi.fn().mockResolvedValue(undefined),
      updateTask: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const response = await request(
      app,
      "POST",
      "/api/tasks/KB-001/workflow/input",
      JSON.stringify({ text }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(store.addSteeringComment).toHaveBeenCalledWith("KB-001", text);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: null, paused: false });
  });
});
