import { describe, expect, it } from "vitest";
import type { Task } from "../types.js";
import {
  EXTERNAL_BLOCK_PAUSE_REASON,
  buildTaskExternalBlockClearPatch,
  buildTaskExternalBlockPatch,
  formatTaskExternalBlockReason,
  isTaskExternallyBlocked,
  type TaskExternalBlock,
} from "../tasks/task-external-block.js";

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "FN-209",
  description: "external obstacle",
  column: "in-progress",
  dependencies: [],
  steps: [{ name: "Testing & Verification", status: "in-progress" }],
  currentStep: 0,
  createdAt: "2026-08-28T03:48:00.000Z",
  updatedAt: "2026-08-28T03:48:00.000Z",
  ...overrides,
});

const block = (overrides: Partial<TaskExternalBlock> = {}): TaskExternalBlock => ({
  origin: "host-environment",
  code: "ENOSPC",
  message: "no space left on device, write",
  source: "agent-declaration",
  blockedAt: "2026-08-28T03:48:00.000Z",
  resume: {
    column: "in-progress",
    nodeId: "steps#0:step-execute",
    currentStep: 0,
    worktree: "/worktrees/fn-209",
    branch: "fn/fn-209",
  },
  ...overrides,
});

describe("task external block", () => {
  it("builds a freeze patch without mutating execution location or user pause state", () => {
    const patch = buildTaskExternalBlockPatch(block());

    expect(patch).toMatchObject({
      status: "blocked",
      paused: true,
      pausedReason: EXTERNAL_BLOCK_PAUSE_REASON,
      pausedByAgentId: null,
      externalBlock: block(),
      error: "BLOCKED: host-environment/ENOSPC: no space left on device, write",
    });
    for (const key of ["column", "steps", "currentStep", "worktree", "branch", "userPaused"]) {
      expect(patch).not.toHaveProperty(key);
    }
  });

  it("builds a clear patch for only the durable freeze fields", () => {
    expect(buildTaskExternalBlockClearPatch()).toEqual({
      status: null,
      error: null,
      paused: false,
      pausedReason: null,
      pausedByAgentId: null,
      externalBlock: null,
    });
  });

  it("does not classify ordinary pauses or failures as externally blocked", () => {
    expect(isTaskExternallyBlocked(task({ paused: true }))).toBe(false);
    expect(isTaskExternallyBlocked(task({ status: "failed", externalBlock: block() }))).toBe(false);
    expect(isTaskExternallyBlocked(task({ status: "blocked", externalBlock: block() }))).toBe(true);
  });

  it.each([
    { code: "", message: "disk unavailable" },
    { code: "ENOSPC", message: "" },
    { code: "", message: "" },
  ])("formats a non-empty reason when fields are empty: %o", ({ code, message }) => {
    expect(formatTaskExternalBlockReason(block({ code, message }))).toMatch(/^BLOCKED: .+\/.+: .+$/);
  });
});
