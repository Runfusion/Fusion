import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import {
  classifyExternalObstacle,
  detectRepairableObstacleHint,
} from "../execution-block-classifier.js";
import { parkExternalSessionObstacle } from "../executor/run-implementation.js";

function liveTask(): Task {
  return {
    id: "FN-209",
    description: "session failure",
    column: "in-progress",
    status: null,
    dependencies: [],
    steps: [{ name: "Testing & Verification", status: "in-progress" }],
    currentStep: 0,
    worktree: "/worktrees/fn-209",
    branch: "fusion/fn-209",
    effectiveNodeId: "steps#0:step-execute",
    createdAt: "2026-08-28T04:14:00.000Z",
    updatedAt: "2026-08-28T04:14:00.000Z",
  };
}

describe("executor external session failure parking", () => {
  it("classifies only conservative outside-worktree failures", () => {
    expect(classifyExternalObstacle("ENOSPC: no space left on device, write")).toEqual({ origin: "host-environment", code: "ENOSPC" });
    expect(classifyExternalObstacle("socket hang up")).toEqual({ origin: "network", code: "SOCKET_HANG_UP" });
    expect(classifyExternalObstacle("ECONNRESET from provider")).toEqual({ origin: "network", code: "ECONNRESET" });
    expect(classifyExternalObstacle("vitest assertion failed")).toBeUndefined();
    expect(classifyExternalObstacle("TypeScript type error TS2322")).toBeUndefined();
    expect(classifyExternalObstacle("Code Review verdict REVISE")).toBeUndefined();
  });

  it("freezes the live resume point and emits prose-free parked metadata", async () => {
    let task = liveTask();
    const store = {
      getTask: vi.fn(async () => ({ ...task })),
      updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
        task = { ...task, ...patch };
        return task;
      }),
      logEntry: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
    };

    await expect(parkExternalSessionObstacle({ store: store as never, getRunContextFor: () => undefined }, task.id, "ENOSPC: no space left on device, write")).resolves.toBe(true);

    expect(task).toMatchObject({
      status: "blocked",
      paused: true,
      pausedReason: "external-block",
      worktree: "/worktrees/fn-209",
      branch: "fusion/fn-209",
      externalBlock: {
        origin: "host-environment",
        code: "ENOSPC",
        source: "session-failure",
        resume: { nodeId: "steps#0:step-execute", currentStep: 0 },
      },
    });
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:external-block-parked",
      metadata: expect.objectContaining({ origin: "host-environment", code: "ENOSPC", source: "session-failure" }),
    }));
    expect(JSON.stringify(store.recordRunAuditEvent.mock.calls)).not.toContain("no space left on device");
  });

  it("leaves the FN-243 missing-interpreter failure for AI self-repair", async () => {
    const reason = "Implementation is committed in 1fc8057. JavaScript tests, typecheck, and build pass, but the required Python regression command cannot run because neither python nor python3 is installed in the execution host.";
    const store = {
      getTask: vi.fn(async () => liveTask()),
      updateTask: vi.fn(),
      logEntry: vi.fn(),
      recordRunAuditEvent: vi.fn(),
    };

    expect(classifyExternalObstacle(reason)).toBeUndefined();
    expect(detectRepairableObstacleHint(reason)).toBe("missing-tooling");
    await expect(parkExternalSessionObstacle(
      { store: store as never, getRunContextFor: () => undefined },
      "FN-209",
      reason,
    )).resolves.toBe(false);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("leaves internal failures for the existing terminal self-repair path", async () => {
    const store = {
      getTask: vi.fn(async () => liveTask()),
      updateTask: vi.fn(),
      logEntry: vi.fn(),
      recordRunAuditEvent: vi.fn(),
    };
    await expect(parkExternalSessionObstacle({ store: store as never, getRunContextFor: () => undefined }, "FN-209", "tests failed: expected 2 to equal 3")).resolves.toBe(false);
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
