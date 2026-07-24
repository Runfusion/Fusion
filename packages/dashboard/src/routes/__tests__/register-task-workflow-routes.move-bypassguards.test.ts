// @vitest-environment node
//
// U4 hardening: `bypassGuards` is engine-internal (KTD-9). The HTTP move
// endpoint hardcodes its move options (mirroring the hardcoded
// `moveSource: "user"` posture) and must NEVER forward a caller-supplied
// `bypassGuards` (or `moveSource`) from the request body — otherwise a remote
// caller could bypass trait guards / abort-on-exit.

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

describe("task move route — bypassGuards is not forwardable", () => {
  it("ignores a caller-supplied bypassGuards/moveSource in the request body", async () => {
    const moveTask = vi.fn(async (_id: string, column: string, _options?: Record<string, unknown>) => ({
      id: "FN-001",
      column,
      dependencies: [],
      steps: [],
      currentStep: 0,
    }));

    const store: TaskStore = {
      getRootDir: vi.fn(() => process.cwd()),
      /*
      FNXC:PluginMcpServers 2026-07-24-01:25:
      FN-8491 (3cd023fa4) binds a project-scoped plugin-MCP provider on every getProjectContext.
      Exposing getProjectScopedPluginMcpServers marks this mock as runtime-owned so the binder
      short-circuits instead of calling getPluginStore().
      */
      getProjectScopedPluginMcpServers: vi.fn(async () => []),
      getTask: vi.fn(async () => ({ id: "FN-001", column: "todo" })),
      getSettings: vi.fn(async () => ({})),
      moveTask,
    } as unknown as TaskStore;

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const res = await REQUEST(
      app,
      "POST",
      "/api/tasks/FN-001/move",
      JSON.stringify({ column: "triage", bypassGuards: true, moveSource: "engine" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(moveTask).toHaveBeenCalledTimes(1);
    const passedOptions = moveTask.mock.calls[0][2] as Record<string, unknown> | undefined;
    // The route constructs its own options; the injected fields must not leak.
    expect(passedOptions?.bypassGuards).toBeUndefined();
    // The route hardcodes moveSource: "user" — the body's "engine" is ignored.
    expect(passedOptions?.moveSource).toBe("user");
  });
});
