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
      /*
      FNXC:WorkflowLifecycleColumns 2026-08-03-00:20 (red on main — a stale target column, not a route bug):
      THE TARGET WAS `triage`, AND U11 DELETED THAT COLUMN. The move route validates against the TASK'S
      WORKFLOW (U12/R2), and the default lineage post-#2515 declares
      `todo | in-progress | in-review | done | archived` — so the route correctly answered 400 "Invalid
      column", the request never reached `moveTask`, and every assertion below was unreachable.

      The route is right; the fixture outlived its column. Same class as the two assertions #2720 corrected in
      `task-dependency-mutation.pg.test.ts`: a test pinning an id the board no longer has, which reads as a
      product failure and is a test-maintenance failure.

      `in-progress` keeps this case's ACTUAL subject intact — that a caller-supplied `bypassGuards`/`moveSource`
      is not forwarded — and it is a forward move from `todo`, so the R16 backward-move PR guard stays out of
      the way. The point was never which column.
      */
      JSON.stringify({ column: "in-progress", bypassGuards: true, moveSource: "engine" }),
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

/*
FNXC:WorkflowLifecycleColumns 2026-08-03-00:35 (added while fixing the red above):

THE PAIRED CASE THE SUITE WAS MISSING: an undeclared column must still be REJECTED.

The red above was a stale target, and the cheapest wrong fix would have been to relax the route's validation
until the old fixture passed again. This pins the behaviour that makes such a "fix" impossible: the route
validates the target against the TASK'S OWN workflow (U12/R2), so a column the board does not declare is a
400 — including `triage`, which the default lineage deleted in #2515.

Without this case, a future worker seeing "Invalid column" in a test failure has no way to tell a stale fixture
from a broken guard, which is exactly the half-hour I just spent.
*/
describe("task move route — the target column must be one the workflow declares", () => {
  it("rejects `triage`, which the default lineage no longer declares", async () => {
    const moveTask = vi.fn();
    const store: TaskStore = {
      getRootDir: vi.fn(() => process.cwd()),
      getProjectScopedPluginMcpServers: vi.fn(async () => []),
      getTask: vi.fn(async () => ({ id: "FN-002", column: "todo" })),
      getSettings: vi.fn(async () => ({})),
      moveTask,
    } as unknown as TaskStore;

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const res = await REQUEST(
      app,
      "POST",
      "/api/tasks/FN-002/move",
      JSON.stringify({ column: "triage" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(400);
    // The refusal must name the board's OWN columns, so an operator can act on it.
    expect(JSON.stringify(res.body)).toContain("in-progress");
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("accepts a column the workflow DOES declare", async () => {
    // The paired positive: validation must not degrade into "reject everything".
    const moveTask = vi.fn(async (_id: string, column: string) => ({
      id: "FN-003", column, dependencies: [], steps: [], currentStep: 0,
    }));
    const store: TaskStore = {
      getRootDir: vi.fn(() => process.cwd()),
      getProjectScopedPluginMcpServers: vi.fn(async () => []),
      getTask: vi.fn(async () => ({ id: "FN-003", column: "todo" })),
      getSettings: vi.fn(async () => ({})),
      moveTask,
    } as unknown as TaskStore;

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const res = await REQUEST(
      app,
      "POST",
      "/api/tasks/FN-003/move",
      JSON.stringify({ column: "in-review" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(moveTask).toHaveBeenCalledTimes(1);
  });
});
