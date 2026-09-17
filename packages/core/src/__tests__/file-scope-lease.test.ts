import { describe, expect, it } from "vitest";
import {
  fileScopeLeaseBlocksCandidate,
  normalizeOverlapScopeForTask,
  taskHoldsUnmergedCheckout,
  type FileScopeLeaseClassification,
  type Task,
} from "../index.js";
import { classifyRepairFileScopeLease } from "../store.js";

const active: FileScopeLeaseClassification = { kind: "active", waivedForTaskIds: [] };
const none: FileScopeLeaseClassification = { kind: "none", waivedForTaskIds: [] };
const dormant: FileScopeLeaseClassification = { kind: "dormant", waivedForTaskIds: [] };

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509 removed the priority argument from this fixture with the priority system. A dormant holder is
now chosen by the shared queue order, so the fixture carries the stay identity the comparator reads
(`column`/`columnMovedAt`) plus the optional durable Boost instead of a level.
*/
function task(
  id: string,
  createdAt = "2026-01-01T00:00:00.000Z",
  queueBoost?: Task["queueBoost"],
) {
  return { id, createdAt, column: "todo", columnMovedAt: createdAt, ...(queueBoost ? { queueBoost } : {}) };
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

  it("orders dormant holders by the shared queue order: Boost, then age, then numeric task id", () => {
    const candidate = task("FN-100", "2026-01-02T00:00:00.000Z");

    // Older holder blocks; newer holder does not.
    expect(fileScopeLeaseBlocksCandidate(task("FN-001", "2026-01-01T00:00:00.000Z"), candidate, dormant)).toBe(true);
    expect(fileScopeLeaseBlocksCandidate(task("FN-001", "2026-01-03T00:00:00.000Z"), candidate, dormant)).toBe(false);

    // Equal ages fall back to the numeric id, deterministically and in one direction only, so the
    // pair cannot both yield and deadlock.
    expect(fileScopeLeaseBlocksCandidate(
      task("FN-001", candidate.createdAt),
      task("FN-002", candidate.createdAt),
      dormant,
    )).toBe(true);
    expect(fileScopeLeaseBlocksCandidate(
      task("FN-002", candidate.createdAt),
      task("FN-001", candidate.createdAt),
      dormant,
    )).toBe(false);

    // An effective Boost moves a NEWER dormant holder ahead of the candidate.
    const boostedNewer = task("FN-900", "2026-01-03T00:00:00.000Z", {
      sequence: "5",
      workflowId: "builtin:coding",
      column: "todo",
      columnEntryAt: "2026-01-03T00:00:00.000Z",
      requestId: "req-1",
    });
    expect(fileScopeLeaseBlocksCandidate(boostedNewer, candidate, dormant)).toBe(true);

    // A legacy priority value has no effect at all.
    const legacyUrgentNewer = { ...task("FN-901", "2026-01-03T00:00:00.000Z"), priority: "urgent" } as unknown as ReturnType<typeof task>;
    expect(fileScopeLeaseBlocksCandidate(legacyUrgentNewer, candidate, dormant)).toBe(false);
  });

  it("never blocks when no lease exists", () => {
    expect(fileScopeLeaseBlocksCandidate(task("FN-001"), task("FN-002"), none)).toBe(false);
  });
});

describe("planning checkout evidence", () => {
  const lanes = {
    wip: new Set(["building"]),
    review: new Set(["reviewing"]),
    terminal: new Set(["shipped", "filed"]),
  };

  it("classifies a checkout-free planning card as no repair lease", () => {
    expect(classifyRepairFileScopeLease({ column: "drafting" }, lanes)).toBe("none");
  });

  it("keeps a replanned hold card with a retained checkout as a dormant repair lease", () => {
    expect(classifyRepairFileScopeLease({ column: "drafting", worktree: "/worktrees/FN-282" }, lanes)).toBe("dormant");
    expect(classifyRepairFileScopeLease({
      column: "drafting",
      workspaceWorktrees: { repo: { worktreePath: "/worktrees/FN-282/repo", branch: "fusion/fn-282" } },
    }, lanes)).toBe("dormant");
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
