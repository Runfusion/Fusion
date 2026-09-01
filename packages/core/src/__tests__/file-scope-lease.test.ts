import { describe, expect, it } from "vitest";
import {
  fileScopeLeaseBlocksCandidate,
  normalizeOverlapScopeForTask,
  taskHoldsUnmergedCheckout,
  type FileScopeLeaseClassification,
  type Task,
} from "../index.js";

const active: FileScopeLeaseClassification = { kind: "active", waivedForTaskIds: [] };
const none: FileScopeLeaseClassification = { kind: "none", waivedForTaskIds: [] };
const dormant: FileScopeLeaseClassification = { kind: "dormant", waivedForTaskIds: [] };

function task(id: string, priority: "low" | "normal" | "high" | "urgent" = "normal", createdAt = "2026-01-01T00:00:00.000Z") {
  return { id, priority, createdAt };
}

describe("fileScopeLeaseBlocksCandidate", () => {
  it("does not let a lease block its own task", () => {
    const holder = task("FN-001");

    expect(fileScopeLeaseBlocksCandidate(holder, holder, active)).toBe(false);
  });

  it("honors targeted dependency waivers without releasing the lease to other work", () => {
    const holder = task("FN-001");
    const waived = task("FN-002");
    const unrelated = task("FN-003");
    const classification: FileScopeLeaseClassification = {
      kind: "active",
      waivedForTaskIds: [waived.id],
    };

    expect(fileScopeLeaseBlocksCandidate(holder, waived, classification)).toBe(false);
    expect(fileScopeLeaseBlocksCandidate(holder, unrelated, classification)).toBe(true);
  });

  it("orders dormant holders by priority, age, then numeric task id", () => {
    const candidate = task("FN-100", "normal", "2026-01-02T00:00:00.000Z");

    expect(fileScopeLeaseBlocksCandidate(task("FN-001", "high"), candidate, dormant)).toBe(true);
    expect(fileScopeLeaseBlocksCandidate(task("FN-001", "low"), candidate, dormant)).toBe(false);
    expect(fileScopeLeaseBlocksCandidate(task("FN-001", "normal", "2026-01-01T00:00:00.000Z"), candidate, dormant)).toBe(true);
    expect(fileScopeLeaseBlocksCandidate(
      task("FN-001", "normal", candidate.createdAt),
      task("FN-002", "normal", candidate.createdAt),
      dormant,
    )).toBe(true);
    expect(fileScopeLeaseBlocksCandidate(
      task("FN-002", "normal", candidate.createdAt),
      task("FN-001", "normal", candidate.createdAt),
      dormant,
    )).toBe(false);
  });

  it("never blocks when no lease exists", () => {
    expect(fileScopeLeaseBlocksCandidate(task("FN-001"), task("FN-002"), none)).toBe(false);
  });
});

describe("workspace checkout and overlap-scope helpers", () => {
  const workspaceTask = (workspaceWorktrees: unknown, worktree?: string) => ({
    worktree,
    workspaceWorktrees,
  }) as Pick<Task, "worktree" | "workspaceWorktrees">;

  it("keeps the singular checkout and scope behavior unchanged without workspace entries", () => {
    const singular = workspaceTask(undefined);
    const scope = ["src/b.ts", "src/a.ts"];

    expect(taskHoldsUnmergedCheckout(singular)).toBe(false);
    expect(normalizeOverlapScopeForTask(singular, scope)).toEqual(scope);
    expect(normalizeOverlapScopeForTask(workspaceTask(undefined, "/worktree"), scope)).toEqual(scope);
  });

  it("recognizes only non-empty workspace checkout paths", () => {
    expect(taskHoldsUnmergedCheckout(workspaceTask({ "repo-a": { worktreePath: "/worktrees/repo-a" } }))).toBe(true);
    expect(taskHoldsUnmergedCheckout(workspaceTask({ "repo-a": { worktreePath: "" } }))).toBe(false);
  });

  it("expands unprefixed workspace scope while preserving qualified and root declarations", () => {
    const task = workspaceTask({ "./repo-b": {}, "repo-a": {} });
    const scope = normalizeOverlapScopeForTask(task, ["repo-a/src/index.ts", "src/shared.ts", "repo-b"]);

    expect(scope).toEqual([
      "repo-a/src/index.ts",
      "repo-a/src/shared.ts",
      "repo-b",
      "repo-b/src/shared.ts",
      "src/shared.ts",
    ]);
    expect(normalizeOverlapScopeForTask(task, scope)).toEqual(scope);
  });
});
