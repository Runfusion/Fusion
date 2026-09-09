// @vitest-environment node
/*
FNXC:WorktreeCapacity 2026-08-01-04:38:
The worktree-capacity ledger uses the canonical enriched live-task predicate. Renamed workflow roles
must classify active WIP/planning tasks correctly while excluding inactive retained directories and
terminal cards. This is the role-resolution half of the real scheduler regression test.
*/

import { describe, expect, it } from "vitest";
import { enrichRunningAgentTaskShape, isRunningAgentTask } from "@fusion/core";
import type { Task, WorkflowIr } from "@fusion/core";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

const task = (id: string, column: string, overrides: Partial<Task> = {}): Task => ({
  id,
  column,
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
} as Task);

const isLive = (candidate: Task): boolean =>
  isRunningAgentTask(enrichRunningAgentTaskShape(candidate, RENAMED_IR));

describe("worktree capacity follows enriched live-task roles", () => {
  it("counts active execution and planning on renamed lanes", () => {
    expect(isLive(task("FN-WIP", "building"))).toBe(true);
    expect(isLive(task("FN-PLAN", "backlog", { status: "planning" }))).toBe(true);
  });

  it("ignores an inactive retained directory", () => {
    expect(isLive(task("FN-QUEUED", "backlog", {
      status: "queued",
      worktree: "/tmp/project/.worktrees/queued",
    }))).toBe(false);
  });

  it("ignores complete cards even with stale live-looking metadata", () => {
    expect(isLive(task("FN-DONE", "shipped", { status: "planning" }))).toBe(false);
  });
});
