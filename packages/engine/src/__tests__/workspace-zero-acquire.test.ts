import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { classifyWorkspaceZeroAcquire } from "../executor/workspace-zero-acquire.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-ZERO",
    title: "coordination",
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "complete", status: "done" }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

const coordinationPrompt = `# Task: coordination
## Review Level: 1 Plan Only
## Mission
Coordinate routing. Do not change product source.
## File Scope
- task documents`;

const promptDerived = `# Task: audit
## Review Level: 1 Plan Only
## Mission
Audit evidence; no source changes expected.
## File Scope
- task documents`;

describe("classifyWorkspaceZeroAcquire", () => {
  it("is not applicable outside workspace mode or after one or more repos were acquired", () => {
    expect(classifyWorkspaceZeroAcquire(task(), { workspaceMode: false })).toEqual({ kind: "not-applicable" });
    expect(classifyWorkspaceZeroAcquire(task({ workspaceWorktrees: { a: { worktreePath: "/a", branch: "fusion/fn-zero" } } as any }), { workspaceMode: true })).toEqual({ kind: "not-applicable" });
    expect(classifyWorkspaceZeroAcquire(task({ workspaceWorktrees: {
      a: { worktreePath: "/a", branch: "fusion/fn-zero" }, b: { worktreePath: "/b", branch: "fusion/fn-zero" },
    } as any }), { workspaceMode: true })).toEqual({ kind: "not-applicable" });
  });

  it.each([undefined, {}])("treats %j workspace worktrees as the same unproven zero-acquire state", (workspaceWorktrees) => {
    expect(classifyWorkspaceZeroAcquire(task({ workspaceWorktrees } as Partial<Task>), { workspaceMode: true }))
      .toEqual({ kind: "unproven" });
  });

  it("accepts every established commit-free eligibility source", () => {
    expect(classifyWorkspaceZeroAcquire(task({ noCommitsExpected: true }), { workspaceMode: true }))
      .toEqual({ kind: "commit-free-eligible", reason: "explicit noCommitsExpected=true" });
    expect(classifyWorkspaceZeroAcquire(task({ prompt: coordinationPrompt }), { workspaceMode: true }))
      .toEqual({ kind: "commit-free-eligible", reason: "prompt-derived coordination-only no-source scope" });
    expect(classifyWorkspaceZeroAcquire(task({ title: "audit", prompt: promptDerived, description: "Operational routing evidence" }), { workspaceMode: true }))
      .toEqual({ kind: "commit-free-eligible", reason: "prompt/source metadata derived operational no-commit contract" });
    expect(classifyWorkspaceZeroAcquire(task(), { workspaceMode: true, noOpCompletion: true, noOpCompletionReason: "verified PREMISE STALE completion sentinel" }))
      .toEqual({ kind: "commit-free-eligible", reason: "verified PREMISE STALE completion sentinel" });
  });
});
