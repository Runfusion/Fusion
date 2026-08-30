import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { getTaskMergeBlocker } from "@fusion/core";
import { getTaskExecutionLivenessSignal, isTaskExecutionLive, isTaskMergeInFlight } from "../merge/merge-execution-exclusion.js";

function registry(paths: string[] = [], active = new Set(paths)) {
  return {
    pathsForTask: () => paths,
    isPathActive: (path: string) => active.has(path),
  };
}

describe("merge execution exclusion", () => {
  it("refuses an active session independently of review state", () => {
    const deps = { activeSessionRegistry: registry(["/worktree"]), executingTaskLock: { has: () => false } };
    expect(getTaskExecutionLivenessSignal("FN-180", deps)).toBe("active-session");
    expect(isTaskExecutionLive("FN-180", deps)).toBe(true);
  });

  it("recognizes the lock and task-active fallbacks", () => {
    expect(getTaskExecutionLivenessSignal("FN-180", {
      activeSessionRegistry: registry(), executingTaskLock: { has: () => true },
    })).toBe("executing-lock");
    expect(getTaskExecutionLivenessSignal("FN-180", {
      activeSessionRegistry: registry(), executingTaskLock: { has: () => false }, isTaskActive: () => true,
    })).toBe("task-active");
  });

  it("allows admission after every execution signal clears", () => {
    expect(isTaskExecutionLive("FN-180", {
      activeSessionRegistry: registry(), executingTaskLock: { has: () => false }, isTaskActive: () => false,
    })).toBe(false);
  });

  it("blocks the converse while any merge ownership signal remains", () => {
    expect(isTaskMergeInFlight("FN-180", { activeMergeTaskId: "FN-180" })).toBe(true);
    expect(isTaskMergeInFlight("FN-180", { mergeActive: new Set(["FN-180"]) })).toBe(true);
    expect(isTaskMergeInFlight("FN-180", { mergeQueue: ["FN-180"] })).toBe(true);
    expect(isTaskMergeInFlight("FN-180", { mergeQueue: [] })).toBe(false);
  });

  it("keeps live-execution refusal independent from an otherwise approving review", () => {
    const task = {
      id: "FN-180", column: "in-review", steps: [], enabledWorkflowSteps: ["code-review"],
      workflowStepResults: [{ workflowStepId: "code-review", status: "passed", verdict: "APPROVE", reviewInputFingerprint: "current" }],
    } as unknown as Task;
    expect(getTaskMergeBlocker(task, {
      requiredPreMergeStepIds: new Set(["code-review"]),
      mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } },
    })).toBeUndefined();
    expect(isTaskExecutionLive(task.id, {
      activeSessionRegistry: registry(["/worktree"]), executingTaskLock: { has: () => false },
    })).toBe(true);
  });

  it("wires both merge admission and execution claim seams to the exclusion contract", async () => {
    const { readFile } = await import("node:fs/promises");
    const [projectEngine, implementation] = await Promise.all([
      readFile(new URL("../project-engine.ts", import.meta.url), "utf8"),
      readFile(new URL("../executor/run-implementation.ts", import.meta.url), "utf8"),
    ]);
    expect(projectEngine).toContain("isTaskExecutionLive(task.id");
    expect(implementation).toContain("isTaskMergeInFlight");
  });
});
