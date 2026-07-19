// @vitest-environment node

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { TaskStore, RunAuditEvent } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

function makeEvent(overrides: Partial<RunAuditEvent>): RunAuditEvent {
  return {
    id: "evt-1",
    timestamp: "2026-05-21T00:00:00.000Z",
    taskId: "FN-100",
    agentId: "agent-1",
    runId: "run-1",
    domain: "git",
    mutationType: "merge:integration-ref-advance",
    target: "merge",
    metadata: {},
    ...overrides,
  };
}

describe("merge advance events route", () => {
  it("returns empty events when audit store is empty", async () => {
    const store: TaskStore = {
      getRootDir: vi.fn(() => process.cwd()),
      // FNXC:PostgresCutover 2026-07-16-06:30: API routes use the async
      // run-audit accessor when backed by PostgreSQL, including test doubles.
      getRunAuditEventsAsync: vi.fn(async () => []),
    } as unknown as TaskStore;

    const app = express();
    app.use("/api", createApiRoutes(store));

    const res = await REQUEST(app, "GET", "/api/tasks/merge-advance-events");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [] });
  });

  it("hydrates matching worktree state and preserves dynamic branch names", async () => {
    const advance = makeEvent({
      id: "evt-advance",
      mutationType: "merge:integration-ref-advance",
      timestamp: "2026-05-21T10:00:00.000Z",
      metadata: {
        integrationBranch: "master",
        refName: "refs/heads/master",
        fromSha: "abc1234",
        toSha: "def5678",
        advanceMode: "update-ref",
        succeeded: true,
      },
    });
    const state = makeEvent({
      id: "evt-state",
      mutationType: "merge:integration-worktree-state",
      timestamp: "2026-05-21T09:59:59.000Z",
      metadata: {
        userCheckout: {
          worktreePath: "/repo",
          dirty: true,
          untrackedCount: 2,
        },
      },
    });

    const getRunAuditEvents = vi.fn((filters?: { mutationType?: string }) => {
      if (filters?.mutationType === "merge:integration-ref-advance") {
        return [advance];
      }
      if (filters?.mutationType === "merge:integration-worktree-state") {
        return [state];
      }
      return [];
    });

    const store: TaskStore = {
      getRootDir: vi.fn(() => process.cwd()),
      getRunAuditEventsAsync: vi.fn(async (filters?: { mutationType?: string }) => getRunAuditEvents(filters)),
    } as unknown as TaskStore;

    const app = express();
    app.use("/api", createApiRoutes(store));

    const res = await REQUEST(app, "GET", "/api/tasks/merge-advance-events");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      events: [
        {
          taskId: "FN-100",
          integrationBranch: "master",
          refName: "refs/heads/master",
          toSha: "def5678",
          fromSha: "abc1234",
          advanceMode: "update-ref",
          succeeded: true,
          advancedAt: "2026-05-21T10:00:00.000Z",
          userCheckout: {
            worktreePath: "/repo",
            dirty: true,
            untrackedCount: 2,
          },
          autoSync: [],
        },
      ],
    });
  });

  it("surfaces merge:auto-sync outcomes (clean-sync + synced-with-pop-conflict) alongside the advance event", async () => {
    const advance = makeEvent({
      id: "evt-advance",
      mutationType: "merge:integration-ref-advance",
      timestamp: "2026-05-21T10:00:00.000Z",
      metadata: {
        integrationBranch: "main",
        refName: "refs/heads/main",
        toSha: "newSha",
        fromSha: "prevSha",
        advanceMode: "update-ref",
        succeeded: true,
      },
    });
    const clean = makeEvent({
      id: "evt-auto-clean",
      mutationType: "merge:auto-sync",
      timestamp: "2026-05-21T10:00:01.000Z",
      metadata: {
        worktreePath: "/repo",
        mode: "stash-and-ff",
        outcome: "clean-sync",
        integrationBranch: "main",
      },
    });
    const conflict = makeEvent({
      id: "evt-auto-conflict",
      mutationType: "merge:auto-sync",
      timestamp: "2026-05-21T10:00:02.000Z",
      metadata: {
        worktreePath: "/secondary",
        mode: "stash-and-ff",
        outcome: "synced-with-pop-conflict",
        integrationBranch: "main",
        conflictedFiles: ["packages/foo/old.ts"],
        patchPath: "/tmp/fusion-worktree-sync-abc/edits.patch",
        untrackedSkippedAsTracked: [],
      },
    });
    // Stale event outside the 5-minute window must be excluded.
    const stale = makeEvent({
      id: "evt-auto-stale",
      mutationType: "merge:auto-sync",
      timestamp: "2026-05-20T10:00:00.000Z",
      metadata: { worktreePath: "/old", mode: "stash-and-ff", outcome: "clean-sync" },
    });

    const store: TaskStore = {
      getRootDir: vi.fn(() => process.cwd()),
      getRunAuditEventsAsync: vi.fn(async (filters?: { mutationType?: string }) => {
        if (filters?.mutationType === "merge:integration-ref-advance") return [advance];
        if (filters?.mutationType === "merge:auto-sync") return [clean, conflict, stale];
        return [];
      }),
    } as unknown as TaskStore;

    const app = express();
    app.use("/api", createApiRoutes(store));
    const res = await REQUEST(app, "GET", "/api/tasks/merge-advance-events");
    expect(res.status).toBe(200);
    const body = res.body as { events: Array<{ autoSync: Array<Record<string, unknown>> }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0].autoSync).toHaveLength(2);
    expect(body.events[0].autoSync).toEqual(expect.arrayContaining([
      expect.objectContaining({ worktreePath: "/repo", outcome: "clean-sync" }),
      expect.objectContaining({
        worktreePath: "/secondary",
        outcome: "synced-with-pop-conflict",
        conflictedFiles: ["packages/foo/old.ts"],
        patchPath: "/tmp/fusion-worktree-sync-abc/edits.patch",
      }),
    ]));
  });

  it("maps succeeded false from metadata", async () => {
    const advance = makeEvent({
      id: "evt-advance-fail",
      metadata: {
        integrationBranch: "trunk",
        refName: "refs/heads/trunk",
        toSha: "deadbeef",
        advanceMode: "update-ref",
        succeeded: false,
      },
    });

    const store: TaskStore = {
      getRootDir: vi.fn(() => process.cwd()),
      getRunAuditEventsAsync: vi.fn(async (filters?: { mutationType?: string }) =>
        filters?.mutationType === "merge:integration-ref-advance" ? [advance] : []),
    } as unknown as TaskStore;

    const app = express();
    app.use("/api", createApiRoutes(store));

    const res = await REQUEST(app, "GET", "/api/tasks/merge-advance-events");
    expect(res.status).toBe(200);
    expect((res.body as { events: Array<{ succeeded: boolean }> }).events[0]?.succeeded).toBe(false);
  });

  it("defaults limit to 20, clamps max to 100, rejects invalid limit", async () => {
    const store: TaskStore = {
      getRootDir: vi.fn(() => process.cwd()),
      getRunAuditEventsAsync: vi.fn(async () => []),
    } as unknown as TaskStore;

    const app = express();
    app.use("/api", createApiRoutes(store));

    const defaultRes = await REQUEST(app, "GET", "/api/tasks/merge-advance-events");
    expect(defaultRes.status).toBe(200);

    const maxRes = await REQUEST(app, "GET", "/api/tasks/merge-advance-events?limit=999");
    expect(maxRes.status).toBe(200);

    const badRes = await REQUEST(app, "GET", "/api/tasks/merge-advance-events?limit=abc");
    expect(badRes.status).toBe(400);

    const getRunAuditEventsAsync = store.getRunAuditEventsAsync as unknown as ReturnType<typeof vi.fn>;
    const firstAdvanceCall = getRunAuditEventsAsync.mock.calls.find((call) => call[0]?.mutationType === "merge:integration-ref-advance");
    const secondAdvanceCall = [...getRunAuditEventsAsync.mock.calls].reverse().find((call) => call[0]?.mutationType === "merge:integration-ref-advance");
    expect(firstAdvanceCall?.[0]?.limit).toBe(20);
    expect(secondAdvanceCall?.[0]?.limit).toBe(100);
  });
});
