import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import { routeGraphFailureToExecutionResume } from "../executor/route-graph-failure-to-execution-resume.js";

function blockedTask(): TaskDetail {
  return {
    id: "FN-209",
    description: "freeze",
    column: "in-progress",
    status: "blocked",
    paused: true,
    dependencies: [],
    steps: [{ name: "Testing & Verification", status: "in-progress" }],
    currentStep: 0,
    worktree: "/worktrees/fn-209",
    branch: "fusion/fn-209",
    externalBlock: {
      origin: "host-environment",
      code: "ENOSPC",
      message: "no space left on device, write",
      source: "agent-declaration",
      blockedAt: "2026-08-28T04:20:00.000Z",
      resume: { column: "in-progress", nodeId: "steps#0:step-execute", currentStep: 0, worktree: "/worktrees/fn-209", branch: "fusion/fn-209" },
    },
    createdAt: "2026-08-28T04:20:00.000Z",
    updatedAt: "2026-08-28T04:20:00.000Z",
    log: [],
  } as TaskDetail;
}

describe("external-block graph freeze contract", () => {
  it("refuses repeated graph-failure resume attempts without mutating state", async () => {
    const updateTask = vi.fn();
    const moveTask = vi.fn();
    const deps = {
      store: { updateTask, moveTask, logEntry: vi.fn() },
      getRunContextFor: vi.fn(),
      resolveResumeLanes: vi.fn(),
      clearTerminalStepFailuresForRetry: vi.fn(),
      persistTokenUsage: vi.fn(),
      isRemediationGraphNode: vi.fn(),
    };

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await expect(routeGraphFailureToExecutionResume(deps as never, blockedTask(), "steps#0:step-execute", "step-failed")).resolves.toBe(false);
    }
    expect(updateTask).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
    expect(deps.clearTerminalStepFailuresForRetry).not.toHaveBeenCalled();
  });
});
