/**
 * FNXC:PlannerOversight 2026-07-21-22:56:
 * Unit coverage for FN-8471 prevention helpers: live-session detection used by
 * overseer retry_step, and execute-family failure park that must not stamp
 * status=failed over a peer live session.
 *
 * FNXC:PlannerOversight 2026-07-21-23:20:
 * Surface Enumeration: overseer liveness covers session + handoff + executing
 * ownership; handleGraphFailure preserve is scoped to SEPARATE session surfaces
 * (coding/step/CLI/workflow) — not the dying graph's own executing/graphRouting
 * markers (CodeRabbit #2393).
 */
import { describe, expect, it } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import type { TaskDetail } from "@fusion/core";

const now = "2026-07-21T22:56:00.000Z";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-LIVE",
    title: "Live session gate",
    description: "coverage",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implement", status: "in-progress" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-live",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-live",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

type Surface = {
  name: string;
  install: (executor: TaskExecutor, taskId: string) => void;
  clear: (executor: TaskExecutor, taskId: string) => void;
};

/** Surfaces that mark isTaskLiveForOverseerRetry (includes handoff/executing). */
const OVERSEER_LIVE_SURFACES: Surface[] = [
  {
    name: "coding session",
    install: (e, id) => {
      (e as any).activeSessions.set(id, { id: "s1" });
    },
    clear: (e, id) => {
      (e as any).activeSessions.delete(id);
    },
  },
  {
    name: "step executor",
    install: (e, id) => {
      (e as any).activeStepExecutors.set(id, {});
    },
    clear: (e, id) => {
      (e as any).activeStepExecutors.delete(id);
    },
  },
  {
    name: "CLI session",
    install: (e, id) => {
      (e as any).activeCliTaskSessions.set(id, {});
    },
    clear: (e, id) => {
      (e as any).activeCliTaskSessions.delete(id);
    },
  },
  {
    name: "workflow step session",
    install: (e, id) => {
      (e as any).activeWorkflowStepSessions.set(id, {});
    },
    clear: (e, id) => {
      (e as any).activeWorkflowStepSessions.delete(id);
    },
  },
  {
    name: "resumingUnpaused handoff",
    install: (e, id) => {
      (e as any).resumingUnpaused.add(id);
    },
    clear: (e, id) => {
      (e as any).resumingUnpaused.delete(id);
    },
  },
  {
    name: "executing ownership",
    install: (e, id) => {
      (e as any).executing.add(id);
    },
    clear: (e, id) => {
      (e as any).executing.delete(id);
    },
  },
];

/**
 * Peer session surfaces only — handleGraphFailure preserve deliberately excludes
 * the dying run's own executing/graphRouting so a pure graph fail still parks.
 */
const PEER_SESSION_SURFACES: Surface[] = OVERSEER_LIVE_SURFACES.filter((s) =>
  ["coding session", "step executor", "CLI session", "workflow step session"].includes(s.name),
);

function settingsForStore() {
  return {
    autoMerge: true,
    maxAutoMergeRetries: 3,
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    executorToolFailureRetryCount: 0,
  };
}

describe("isTaskLiveForOverseerRetry", () => {
  it("is false when no sessions or execution claims exist", () => {
    resetExecutorMocks();
    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    expect(executor.isTaskLiveForOverseerRetry("FN-1")).toBe(false);
  });

  it.each(OVERSEER_LIVE_SURFACES.map((s) => [s.name, s] as const))(
    "is true for %s ownership",
    (_name, surface) => {
      resetExecutorMocks();
      const executor = new TaskExecutor(createMockStore(), "/tmp/test");
      surface.install(executor, "FN-1");
      expect(executor.isTaskLiveForOverseerRetry("FN-1")).toBe(true);
      surface.clear(executor, "FN-1");
    },
  );
});

describe("handleGraphFailure execute-family live session preserve", () => {
  it.each(PEER_SESSION_SURFACES.map((s) => [s.name, s] as const))(
    "does not park status=failed for step-execute when peer %s is live",
    async (_name, surface) => {
      resetExecutorMocks();
      const store = createMockStore();
      const live = task({ column: "in-progress", status: null });
      store.getTask.mockResolvedValue(live);
      store.getSettings.mockResolvedValue(settingsForStore());
      const executor = new TaskExecutor(store, "/tmp/test");
      surface.install(executor, live.id);
      (executor as any).graphRouting.add(live.id);
      try {
        await (executor as any).handleGraphFailure(live, {
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: ["steps#1:step-execute"],
          context: { "node:steps#1:step-execute:value": "step-failed" },
        });
      } finally {
        (executor as any).graphRouting.delete(live.id);
        surface.clear(executor, live.id);
      }

      expect(store.logEntry).toHaveBeenCalledWith(
        live.id,
        expect.stringContaining("while a live agent session is still executing"),
        undefined,
        undefined,
      );
      // Match actual updateTask signature (run context is undefined on this path).
      expect(store.updateTask).not.toHaveBeenCalledWith(
        live.id,
        expect.objectContaining({ status: "failed" }),
        undefined,
      );
    },
  );

  it("still parks status=failed for merge-region failure even when a live session exists", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const live = task({ column: "in-progress", status: null });
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue(settingsForStore());
    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any).activeSessions.set(live.id, { id: "peer-session" });
    (executor as any).graphRouting.add(live.id);
    try {
      await (executor as any).handleGraphFailure(live, {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["merge-attempt"],
        context: { "node:merge-attempt:value": "merge-failed" },
      });
    } finally {
      (executor as any).graphRouting.delete(live.id);
      (executor as any).activeSessions.delete(live.id);
    }

    expect(store.updateTask).toHaveBeenCalledWith(
      live.id,
      expect.objectContaining({ status: "failed", error: expect.stringContaining("merge-attempt") }),
      undefined,
    );
  });
});
