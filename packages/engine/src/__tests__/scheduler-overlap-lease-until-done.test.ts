import { describe, expect, it } from "vitest";
import { fileScopeLeaseBlocksCandidate, type Task } from "@fusion/core";
import { classifyFileScopeLease } from "../scheduler.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "task",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

describe("classifyFileScopeLease", () => {
  it("keeps failed, paused, and user-paused review cards active while they own a worktree", () => {
    expect(classifyFileScopeLease(makeTask({ column: "in-review", worktree: "/wt/a", status: "failed" }), [])).toMatchObject({ kind: "active" });
    expect(classifyFileScopeLease(makeTask({ column: "in-review", worktree: "/wt/a", paused: true }), [])).toMatchObject({ kind: "active" });
    expect(classifyFileScopeLease(makeTask({ column: "in-review", worktree: "/wt/a", userPaused: true }), [])).toMatchObject({ kind: "active" });
  });

  it("releases a review lease after its worktree is gone", () => {
    expect(classifyFileScopeLease(makeTask({ column: "in-review" }), [])).toMatchObject({ kind: "none" });
  });

  it("keeps workspace review and dormant leases until every repository checkout is removed", () => {
    const workspaceWorktrees = { "repo-a": { worktreePath: "/wt/fn-1/repo-a" } } as Task["workspaceWorktrees"];
    const review = makeTask({ column: "signoff", workspaceWorktrees });
    const hold = makeTask({ column: "backlog", workspaceWorktrees });

    expect(classifyFileScopeLease(review, [], {
      isWipColumn: false,
      isReviewColumn: true,
      isTerminalColumn: false,
    })).toMatchObject({ kind: "active" });
    expect(classifyFileScopeLease(hold, [], {
      isWipColumn: false,
      isReviewColumn: false,
      isTerminalColumn: false,
    })).toMatchObject({ kind: "dormant" });
    expect(classifyFileScopeLease(makeTask({ column: "done", workspaceWorktrees }), [], {
      isTerminalColumn: true,
    })).toMatchObject({ kind: "none" });
    expect(classifyFileScopeLease(makeTask({ column: "signoff", deletedAt: "2026-01-02T00:00:00.000Z", workspaceWorktrees }), [], {
      isReviewColumn: true,
    })).toMatchObject({ kind: "none" });
    expect(classifyFileScopeLease(makeTask({ column: "signoff", workspaceWorktrees: {} }), [], {
      isReviewColumn: true,
    })).toMatchObject({ kind: "none" });
  });

  it("keeps WIP work active despite failure and before worktree acquisition", () => {
    expect(classifyFileScopeLease(makeTask({ column: "in-progress", worktree: "/wt/a", status: "failed" }), [])).toMatchObject({ kind: "active" });
    expect(classifyFileScopeLease(makeTask({ column: "in-progress", paused: true }), [])).toMatchObject({ kind: "active" });
  });

  it("waives a WIP lease only for the holder's unmet scheduling dependencies", () => {
    const dependency = makeTask({ id: "FN-DEP", column: "todo" });
    const holder = makeTask({ id: "FN-HOLDER", column: "in-progress", dependencies: [dependency.id] });
    const unrelated = makeTask({ id: "FN-OTHER", column: "todo" });
    const classification = classifyFileScopeLease(holder, [holder, dependency, unrelated]);

    expect(classification).toMatchObject({ kind: "active", waivedForTaskIds: [dependency.id] });
    expect(fileScopeLeaseBlocksCandidate(holder, dependency, classification)).toBe(false);
    expect(fileScopeLeaseBlocksCandidate(holder, unrelated, classification)).toBe(true);
  });

  it("makes preserved worktrees dormant outside WIP and review", () => {
    expect(classifyFileScopeLease(makeTask({ column: "todo", worktree: "/wt/a" }), [])).toMatchObject({ kind: "dormant" });
    expect(classifyFileScopeLease(makeTask({ column: "triage", worktree: "/wt/a" }), [])).toMatchObject({ kind: "dormant" });
    expect(classifyFileScopeLease(makeTask({ column: "todo" }), [])).toMatchObject({ kind: "none" });
  });

  it("releases terminal and soft-deleted cards before considering their lane", () => {
    expect(classifyFileScopeLease(makeTask({ column: "done", worktree: "/wt/a" }), [])).toMatchObject({ kind: "none" });
    expect(classifyFileScopeLease(makeTask({ column: "in-progress", deletedAt: "2026-01-02T00:00:00.000Z" }), [])).toMatchObject({ kind: "none" });
  });

  it("uses resolved terminal and lane traits for renamed boards", () => {
    const complete = makeTask({ column: "shipped", worktree: "/wt/a" });
    const custom = makeTask({ column: "awaiting-merge", worktree: "/wt/a" });

    expect(classifyFileScopeLease(complete, [], { isTerminalColumn: true })).toMatchObject({ kind: "none" });
    expect(classifyFileScopeLease(custom, [], { isWipColumn: false, isReviewColumn: false, isTerminalColumn: false })).toMatchObject({ kind: "dormant" });
  });

  it("keeps the accepted-handoff exception limited to review cards", () => {
    const review = makeTask({ column: "in-review", worktree: "/wt/a" });
    const wip = makeTask({ column: "in-progress", worktree: "/wt/a" });

    expect(classifyFileScopeLease(review, [], {
      mergeRequestContractShadowEnabled: true,
      handoffAccepted: true,
    })).toMatchObject({ kind: "none" });
    expect(classifyFileScopeLease(review, [], {
      mergeRequestContractShadowEnabled: false,
      handoffAccepted: true,
    })).toMatchObject({ kind: "active" });
    expect(classifyFileScopeLease(wip, [], {
      mergeRequestContractShadowEnabled: true,
      handoffAccepted: true,
    })).toMatchObject({ kind: "active" });
  });
});
