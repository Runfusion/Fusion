// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

describe("task workflow merge route", () => {
  it("invokes engine.onMerge for manual merge requests", async () => {
    const store: TaskStore = {
      getRootDir: vi.fn(() => process.cwd()),
      mergeTask: vi.fn(),
      /*
      FNXC:PluginMcpServers 2026-07-24-02:05:
      FN-8491 (3cd023fa4) made resolveProjectContext bind a project-scoped plugin
      MCP provider on every getProjectContext call; a store exposing
      getProjectScopedPluginMcpServers is treated as runtime-owned and skips the
      binder (which would otherwise 500 on getPluginStore()).
      */
      getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
    } as unknown as TaskStore;

    const onMerge = vi.fn(async (id: string) => ({
      task: { id, column: "done" },
      branch: `fusion/${id.toLowerCase()}`,
      merged: true,
      worktreeRemoved: false,
      branchDeleted: false,
    }));

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { onMerge }));

    const res = await REQUEST(app, "POST", "/api/tasks/FN-5438/merge");

    expect(res.status).toBe(200);
    expect(onMerge).toHaveBeenCalledWith("FN-5438");
    expect((res.body as { merged: boolean }).merged).toBe(true);
  });
});
