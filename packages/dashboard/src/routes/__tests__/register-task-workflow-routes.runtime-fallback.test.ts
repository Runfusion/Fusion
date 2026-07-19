// @vitest-environment node

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { TaskStore, RunAuditEvent } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const makeTaskState = (overrides: Record<string, unknown> = {}) => ({
  id: "FN-001",
  description: "task with runtime hint",
  column: "in-progress",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-05-15T00:00:00.000Z",
  updatedAt: "2026-05-15T00:00:00.000Z",
  ...overrides,
} as any);

const makeAuditEvent = (overrides: Partial<RunAuditEvent> = {}): RunAuditEvent => ({
  id: "audit-1",
  timestamp: "2026-07-08T00:00:00.000Z",
  taskId: "FN-001",
  agentId: "agent-1",
  runId: "run-1",
  domain: "database",
  mutationType: "session:runtime-resolved" as any,
  target: "pi",
  metadata: {},
  ...overrides,
});

const createHarness = (taskState: any, events: RunAuditEvent[]) => {
  const store: TaskStore = {
    getRootDir: vi.fn(() => process.cwd()),
    getTask: vi.fn(async (id: string) => {
      if (id !== taskState.id) {
        throw new Error(`Task ${id} not found`);
      }
      return taskState;
    }),
    // FNXC:PostgresCutover 2026-07-16-06:30: runtime fallback status reads
    // audit events asynchronously from the PostgreSQL-backed task store.
    getRunAuditEventsAsync: vi.fn(async (options: Record<string, unknown> = {}) => {
      let filtered = events;
      if (options.taskId) {
        filtered = filtered.filter((e) => e.taskId === options.taskId);
      }
      if (options.mutationType) {
        filtered = filtered.filter((e) => e.mutationType === options.mutationType);
      }
      // Events array in these fixtures is already provided most-recent-first,
      // matching the store's real ORDER BY timestamp DESC, rowid DESC.
      if (typeof options.limit === "number") {
        filtered = filtered.slice(0, options.limit);
      }
      return filtered;
    }),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, store };
};

describe("GET /api/tasks/:id/runtime-fallback", () => {
  it("returns hasEvent=false and showFallbackBadge=false when no session:runtime-resolved event exists", async () => {
    const { app } = createHarness(makeTaskState(), []);

    const res = await REQUEST(app, "GET", "/api/tasks/FN-001/runtime-fallback");

    expect(res.status).toBe(200);
    expect(res.body.hasEvent).toBe(false);
    expect(res.body.showFallbackBadge).toBe(false);
    expect(res.body.wasConfigured).toBeNull();
    expect(res.body.runtimeHint).toBeNull();
  });

  it("does not show badge when the most recent event has wasConfigured=true", async () => {
    const { app } = createHarness(makeTaskState(), [
      makeAuditEvent({ metadata: { wasConfigured: true, runtimeHint: "hermes" } }),
    ]);

    const res = await REQUEST(app, "GET", "/api/tasks/FN-001/runtime-fallback");

    expect(res.status).toBe(200);
    expect(res.body.hasEvent).toBe(true);
    expect(res.body.wasConfigured).toBe(true);
    expect(res.body.showFallbackBadge).toBe(false);
  });

  it("shows badge when wasConfigured=false and runtimeHint is non-empty", async () => {
    const { app } = createHarness(makeTaskState(), [
      makeAuditEvent({
        metadata: { wasConfigured: false, runtimeHint: "hermes", reason: "not_found" },
      }),
    ]);

    const res = await REQUEST(app, "GET", "/api/tasks/FN-001/runtime-fallback");

    expect(res.status).toBe(200);
    expect(res.body.hasEvent).toBe(true);
    expect(res.body.wasConfigured).toBe(false);
    expect(res.body.runtimeHint).toBe("hermes");
    expect(res.body.reason).toBe("not_found");
    expect(res.body.showFallbackBadge).toBe(true);
  });

  it("does not show badge when wasConfigured=false but runtimeHint is blank/absent", async () => {
    const { app } = createHarness(makeTaskState(), [
      makeAuditEvent({ metadata: { wasConfigured: false } }),
    ]);

    const res = await REQUEST(app, "GET", "/api/tasks/FN-001/runtime-fallback");

    expect(res.status).toBe(200);
    expect(res.body.wasConfigured).toBe(false);
    expect(res.body.runtimeHint).toBeNull();
    expect(res.body.showFallbackBadge).toBe(false);
  });

  it("only the most recent event governs — a stale fallback superseded by a later success shows no badge", async () => {
    const { app } = createHarness(makeTaskState(), [
      // Most recent first, matching real store ordering.
      makeAuditEvent({ id: "audit-2", timestamp: "2026-07-08T01:00:00.000Z", metadata: { wasConfigured: true, runtimeHint: "hermes" } }),
      makeAuditEvent({ id: "audit-1", timestamp: "2026-07-08T00:00:00.000Z", metadata: { wasConfigured: false, runtimeHint: "hermes", reason: "not_found" } }),
    ]);

    const res = await REQUEST(app, "GET", "/api/tasks/FN-001/runtime-fallback");

    expect(res.status).toBe(200);
    expect(res.body.eventId).toBe("audit-2");
    expect(res.body.wasConfigured).toBe(true);
    expect(res.body.showFallbackBadge).toBe(false);
  });
});
