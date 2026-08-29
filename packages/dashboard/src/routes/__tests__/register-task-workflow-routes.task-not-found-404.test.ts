// @vitest-environment node

/*
FNXC:TaskLookup404 2026-07-26-12:20:
Requirement under test: a task-detail read for a task that does not exist must
return HTTP 404, never 500 — clients must be able to distinguish "this task is
gone" from "the server is broken".

Reported repro: `GET /api/tasks/FN-8610/runtime-fallback` returned 500 with the
body `{"error":"Task FN-8610 not found"}`. Root cause: route catches detected a
missing task only via `(err as NodeJS.ErrnoException).code === "ENOENT"`, a
file-backed-storage-era leftover. In Postgres/backend mode nothing on the task
read path sets an errno code, so EVERY missing/unknown/soft-deleted/wrong-project
task read fell through to 500.

Per AGENTS.md "Fix the Invariant, Not the Repro", this asserts the general
invariant across the affected route surfaces (task detail, runtime-fallback,
workflow-results, pause, PATCH, DELETE, session diff, PR status), not just the
one reported endpoint — plus the negative control that a genuine server fault
still surfaces as 500 rather than being laundered into a 404.
*/

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { TaskNotFoundError } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const MISSING_ID = "FN-8610";

/**
 * FNXC:TaskLookup404 2026-07-26-12:20:
 * In-memory store fake (no DB, no network, no timers — AGENTS.md "Do Not Add
 * Slow Tests"). Every task-lookup entry point throws the same typed
 * `TaskNotFoundError` the real `getTaskImpl` now throws, so the test exercises
 * the route-boundary mapping rather than the store.
 */
const createHarness = (taskLookupError: () => Error) => {
  const throwMiss = vi.fn(async (_id?: unknown) => {
    throw taskLookupError();
  });

  const store: TaskStore = {
    getRootDir: vi.fn(() => process.cwd()),
    getTask: throwMiss,
    updateTask: throwMiss,
    deleteTask: throwMiss,
    pauseTask: throwMiss,
    getRunAuditEventsAsync: vi.fn(async () => []),
    /*
    FNXC:PluginMcpServers 2026-07-24-02:05 (mirrored from the runtime-fallback
    suite): a store exposing getProjectScopedPluginMcpServers is treated as
    runtime-owned, so resolveProjectContext skips the plugin-MCP binder that
    would otherwise 500 on getPluginStore().
    */
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, store };
};

/*
FNXC:TaskLookup404 2026-07-26-12:20:
Surface enumeration for the invariant. Each entry is a route whose handler
pre-checks (or loads) the task through `store.getTask(...)` and therefore
observed the 500. The list spans all four registrars that own per-task `:id`
routes: register-task-workflow-routes, register-session-diff-routes,
register-git-github, and the shared PATCH/DELETE task-mutation handlers.
*/
const MISSING_TASK_SURFACES: ReadonlyArray<{ name: string; method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: Record<string, unknown> }> = [
  { name: "GET /tasks/:id (task detail)", method: "GET", path: `/api/tasks/${MISSING_ID}` },
  { name: "GET /tasks/:id/runtime-fallback (reported repro)", method: "GET", path: `/api/tasks/${MISSING_ID}/runtime-fallback` },
  { name: "GET /tasks/:id/workflow-results", method: "GET", path: `/api/tasks/${MISSING_ID}/workflow-results` },
  { name: "GET /tasks/:id/session-files", method: "GET", path: `/api/tasks/${MISSING_ID}/session-files` },
  { name: "GET /tasks/:id/pr/status", method: "GET", path: `/api/tasks/${MISSING_ID}/pr/status` },
  { name: "POST /tasks/:id/pause", method: "POST", path: `/api/tasks/${MISSING_ID}/pause`, body: {} },
  { name: "PATCH /tasks/:id", method: "PATCH", path: `/api/tasks/${MISSING_ID}`, body: { title: "renamed" } },
  { name: "DELETE /tasks/:id", method: "DELETE", path: `/api/tasks/${MISSING_ID}` },
];

describe("task-miss routes return 404 (not 500)", () => {
  for (const surface of MISSING_TASK_SURFACES) {
    it(`${surface.name} responds 404 for an unknown task id`, async () => {
      const { app } = createHarness(() => new TaskNotFoundError(MISSING_ID));

      const res = await REQUEST(
        app,
        surface.method,
        surface.path,
        surface.body ? JSON.stringify(surface.body) : undefined,
        surface.body ? { "content-type": "application/json" } : {},
      );

      expect(res.status).toBe(404);
      expect(res.status).not.toBe(500);
    });
  }

  /*
  FNXC:TaskLookup404 2026-07-26-12:20:
  Legacy safety: the file-backed-era ENOENT signal must keep mapping to 404 so
  genuinely file-backed reads on the same handlers are unaffected by the switch
  to the typed error.
  */
  it("keeps mapping a legacy errno ENOENT task miss to 404", async () => {
    const { app } = createHarness(() => {
      const err = new Error(`Task ${MISSING_ID} not found`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return err;
    });

    const res = await REQUEST(app, "GET", `/api/tasks/${MISSING_ID}/runtime-fallback`);

    expect(res.status).toBe(404);
  });

  /*
  FNXC:TaskLookup404 2026-07-26-12:20:
  Negative control — the fix must not launder real server faults into 404s. A
  non-miss failure on the same call path still has to surface as 500 so genuine
  breakage stays visible/alertable.
  */
  it("still returns 500 when the task read fails for a non-miss reason", async () => {
    const { app } = createHarness(() => new Error("connection terminated unexpectedly"));

    const res = await REQUEST(app, "GET", `/api/tasks/${MISSING_ID}`);

    expect(res.status).toBe(500);
  });

  /*
  FNXC:TaskLookup404 2026-07-26-12:20:
  Response-body contract: the 404 keeps the byte-identical legacy message so
  existing message-matching clients and tests are unaffected — only the status
  code changes.
  */
  it("preserves the legacy `Task <id> not found` message on the 404", async () => {
    const { app } = createHarness(() => new TaskNotFoundError(MISSING_ID));

    const res = await REQUEST(app, "GET", `/api/tasks/${MISSING_ID}`);

    expect(res.status).toBe(404);
    expect((res.body as { error?: string }).error).toBe(`Task ${MISSING_ID} not found`);
  });
});
