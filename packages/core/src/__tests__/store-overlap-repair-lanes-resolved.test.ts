/*
FNXC:WorkflowLifecycleColumns 2026-07-31-01:10 (batch-core feed: store.ts 11 → 0):

THE INVARIANT: the overlap-blocker repair reads the board's own lanes at every step.

The repair was inert END TO END on a renamed board, and each step failed the same way:

  - the repairable-state gate refused a card sitting in the board's own hold lane
    ("not a repairable todo state");
  - the blocker's active-lease check saw no lease, so a live blocker read as stale;
  - the dependency check never saw a finished dependency as resolved, so the repair re-blocked the
    card it had just unblocked;
  - the reroute search found no active holders and no queued candidates.

A repair that declines everything is indistinguishable in the logs from a board with nothing to
repair, which is why this file drives the REAL method rather than the extracted predicate alone.

`repairOverlapBlocker` is invoked with `.call()` on a minimal `this` supplying exactly what the body
touches — the same shape `project-engine-merge-lane-resolved.test.ts` uses. `ProjectEngine`-style
construction of a whole TaskStore is not something a unit test should do, and the body under test is
the shipped one, not a copy.

WHY THE HOLD GATE REFUSES RATHER THAN DEFAULTS when a workflow resolves with no hold lane: that is an
ANSWER (this board has nowhere repairable), not a missing one. Substituting "todo" there would point
the operator at a column the board does not have — the phantom-lane bug greptile caught on #2775.

REVERT PROOF, measured: restore the literals and 4 of the 9 cases fail. The default-board cases keep
passing, so they do not pin the fix on their own.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../types.js";
import { classifyRepairFileScopeLease, holdsRepairFileScopeLease, TaskStore } from "../store.js";

/** A board whose hold lane is `backlog`, wip `building`, review `signoff`, complete `shipped`. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

/** Multiple membership lanes exercise the distinction between a move target and a role set. */
const MULTI_LEASE_IR = {
  version: "v2", id: "wf-multi-lease", name: "multi lease", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "building-primary", name: "Building primary", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "building-secondary", name: "Building secondary", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff-primary", name: "Sign-off primary", traits: [{ trait: "merge" }] },
    { id: "signoff-secondary", name: "Sign-off secondary", traits: [{ trait: "merge" }] },
    { id: "shipped-primary", name: "Shipped primary", traits: [{ trait: "complete" }] },
    { id: "shipped-secondary", name: "Shipped secondary", traits: [{ trait: "complete" }] },
  ],
};

/** Same board with the hold trait removed — resolvable, but with nowhere repairable. */
const NO_HOLD_IR = {
  ...RENAMED_IR,
  columns: RENAMED_IR.columns.map((c) =>
    c.id === "backlog" ? { ...c, traits: [{ trait: "intake" }] } : c,
  ),
};

function card(id: string, column: string, extra: Record<string, unknown> = {}): Task {
  return {
    id, column, dependencies: [], steps: [], overlapBlockedBy: null, status: null,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...extra,
  } as unknown as Task;
}

function harness(tasks: Task[], ir: unknown, subject: Task, scopes: Record<string, string[]> = {}) {
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  let irReads = 0;
  const updates: Array<Record<string, unknown>> = [];
  const self = {
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? subject),
    listTasks: vi.fn(async () => tasks),
    getSettings: vi.fn(async () => ({ overlapIgnorePaths: [] })),
    parseFileScopeFromPrompt: vi.fn(async (taskId: string) => scopes[taskId] ?? ["src/shared.ts"]),
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (t: Task) => unknown) => {
      const patch = mutate(subject);
      if (patch) updates.push(patch as Record<string, unknown>);
      return { ...subject, ...(patch as object) };
    }),
    getTaskWorkflowSelection: () => (ir ? selection : undefined),
    getTaskWorkflowSelectionAsync: async () => (ir ? selection : undefined),
    getWorkflowDefinition: async () => {
      irReads += 1;
      return ir ? { ir } : undefined;
    },
    logEntry: vi.fn(async () => undefined),
    emit: vi.fn(),
    isWatching: false,
    taskCache: new Map(),
    findCurrentOverlapBlockerForRepair: TaskStore.prototype["findCurrentOverlapBlockerForRepair" as keyof TaskStore],
  };

  const run = () =>
    (TaskStore.prototype as unknown as {
      repairOverlapBlocker: (this: unknown, id: string, o?: unknown) => Promise<{ reason?: string; repaired?: boolean; message?: string; currentOverlapBlockedBy?: string | null }>;
    }).repairOverlapBlocker.call(self, subject.id, {});

  return { run, updates, irReads: () => irReads };
}

describe("holdsRepairFileScopeLease resolves the candidate's own lanes", () => {
  it("recognises a RENAMED wip lane", () => {
    expect(holdsRepairFileScopeLease(card("FN-1", "building"), { wip: "building", review: "signoff" })).toBe(true);
  });

  it("requires a worktree in the review lane, as the scheduler's copy does", () => {
    // The two copies of this predicate must keep agreeing; this pins the review half's extra clause.
    expect(holdsRepairFileScopeLease(card("FN-1", "signoff"), { wip: "building", review: "signoff" })).toBe(false);
    expect(holdsRepairFileScopeLease(card("FN-1", "signoff", { worktree: "/wt" }), { wip: "building", review: "signoff" })).toBe(true);
  });

  it("keeps the legacy literals when the workflow cannot be resolved", () => {
    expect(holdsRepairFileScopeLease(card("FN-1", "in-progress"), undefined)).toBe(true);
    expect(holdsRepairFileScopeLease(card("FN-1", "building"), undefined)).toBe(false);
  });

  it("answers false for a half a resolved board does not declare, rather than substituting one", () => {
    expect(holdsRepairFileScopeLease(card("FN-1", "in-progress"), { wip: undefined, review: "signoff" })).toBe(false);
  });
});

describe("classifyRepairFileScopeLease", () => {
  const lanes = {
    wip: "building",
    review: "signoff",
    terminal: new Set(["shipped", "vault"]),
  };

  it("keeps failed review and worktree-less WIP work leased while releasing terminal and cleaned review cards", () => {
    expect(classifyRepairFileScopeLease(card("FN-1", "signoff", { status: "failed", worktree: "/wt" }), lanes)).toBe("active");
    expect(classifyRepairFileScopeLease(card("FN-1", "building"), lanes)).toBe("active");
    expect(classifyRepairFileScopeLease(card("FN-1", "signoff"), lanes)).toBe("none");
    expect(classifyRepairFileScopeLease(card("FN-1", "backlog", { worktree: "/wt" }), lanes)).toBe("dormant");
    expect(classifyRepairFileScopeLease(card("FN-1", "shipped", { worktree: "/wt" }), lanes)).toBe("none");
  });
});

describe("repairOverlapBlocker resolves the board's own lanes", () => {
  it("accepts a card sitting in a RENAMED hold lane", async () => {
    // Pre-fix: `backlog` !== "todo" → "not a repairable todo state", and the repair stopped here.
    const subject = card("FN-1", "backlog", { overlapBlockedBy: "FN-2" });
    const { run } = harness([subject, card("FN-2", "shipped")], RENAMED_IR, subject);

    const result = await run();

    expect(result.reason).not.toBe("not-repairable-state");
  });

  it("refuses WITHOUT naming a phantom lane when the workflow declares no hold lane", async () => {
    // A resolved workflow with no hold lane is an ANSWER. Substituting "todo" would name a column
    // this board does not have — the phantom-lane defect caught on #2775.
    const subject = card("FN-1", "backlog", { overlapBlockedBy: "FN-2" });
    const { run } = harness([subject, card("FN-2", "shipped")], NO_HOLD_IR, subject);

    const result = await run();

    expect(result.reason).toBe("not-repairable-state");
    expect(result.message).toContain("no hold lane");
    expect(result.message).not.toContain("not a repairable todo");
  });

  it("refuses repair while a failed review blocker still owns a worktree", async () => {
    const subject = card("FN-1", "backlog", { overlapBlockedBy: "FN-2" });
    const { run } = harness(
      [subject, card("FN-2", "signoff", { status: "failed", worktree: "/wt/fn-2" })],
      RENAMED_IR,
      subject,
    );

    const result = await run();

    expect(result.reason).toBe("scopes-still-overlap");
  });

  it("retains a workspace review blocker while any repository checkout exists", async () => {
    const subject = card("FN-1", "backlog", { overlapBlockedBy: "FN-2" });
    const { run } = harness(
      [
        subject,
        card("FN-2", "signoff", {
          status: "failed",
          workspaceWorktrees: { "repo-a": { worktreePath: "/wt/fn-2/repo-a" } },
        }),
      ],
      RENAMED_IR,
      subject,
    );

    await expect(run()).resolves.toMatchObject({ reason: "scopes-still-overlap" });
  });

  it("matches a workspace blocker's unprefixed scope against the candidate's qualified repository path", async () => {
    const subject = card("FN-1", "backlog", { overlapBlockedBy: "FN-2" });
    const { run } = harness(
      [
        subject,
        card("FN-2", "signoff", {
          status: "failed",
          workspaceWorktrees: { "repo-a": { worktreePath: "/wt/fn-2/repo-a" } },
        }),
      ],
      RENAMED_IR,
      subject,
      { "FN-1": ["repo-a/src/shared.ts"], "FN-2": ["src/shared.ts"] },
    );

    await expect(run()).resolves.toMatchObject({ reason: "scopes-still-overlap" });
  });

  it("clears a workspace review blocker after its repository checkouts are removed", async () => {
    const subject = card("FN-1", "backlog", { overlapBlockedBy: "FN-2" });
    const { run } = harness(
      [subject, card("FN-2", "signoff", { status: "failed", workspaceWorktrees: {} })],
      RENAMED_IR,
      subject,
    );

    await expect(run()).resolves.toMatchObject({ repaired: true, reason: "repaired" });
  });

  it("repairs a terminal blocker and a review blocker whose worktree is gone", async () => {
    for (const blocker of [
      card("FN-2", "shipped", { worktree: "/wt/fn-2" }),
      card("FN-2", "signoff", { status: "failed" }),
    ]) {
      const subject = card("FN-1", "backlog", { overlapBlockedBy: blocker.id });
      const { run } = harness([subject, blocker], RENAMED_IR, subject);

      const result = await run();

      expect(result.repaired).toBe(true);
      expect(result.reason).not.toBe("scopes-still-overlap");
    }
  });

  it.each([
    ["a secondary WIP lane without a worktree", card("FN-2", "building-secondary"), "scopes-still-overlap"],
    ["a secondary review lane with a worktree", card("FN-2", "signoff-secondary", { worktree: "/wt/fn-2", priority: "low" }), "scopes-still-overlap"],
    ["a secondary terminal lane", card("FN-2", "shipped-secondary", { worktree: "/wt/fn-2", priority: "urgent" }), "repaired"],
  ])("uses every selected-workflow role lane for overlap repair: %s", async (_description, blocker, expectedReason) => {
    const subject = card("FN-1", "backlog", { overlapBlockedBy: blocker.id });
    const { run } = harness([subject, blocker], MULTI_LEASE_IR, subject);

    const result = await run();

    expect(result.reason).toBe(expectedReason);
  });

  it("reroutes a stale blocker to a secondary WIP holder", async () => {
    const subject = card("FN-1", "backlog", { overlapBlockedBy: "FN-2", status: "queued" });
    const { run, updates } = harness(
      [
        subject,
        card("FN-2", "shipped-primary"),
        card("FN-3", "building-secondary"),
      ],
      MULTI_LEASE_IR,
      subject,
    );

    await run();

    expect(updates[updates.length - 1]).toMatchObject({ overlapBlockedBy: "FN-3" });
  });

  it("counts a dependency in a RENAMED complete lane as resolved", async () => {
    // Pre-fix: `shipped` is neither "done" nor "archived", so the repair re-blocked on a finished
    // dependency immediately after clearing the overlap blocker.
    const subject = card("FN-1", "backlog", { overlapBlockedBy: "FN-2", dependencies: ["FN-3"], status: "queued" });
    const { run, updates } = harness(
      [subject, card("FN-2", "shipped"), card("FN-3", "shipped")],
      RENAMED_IR,
      subject,
    );

    await run();

    expect(updates[updates.length - 1]).toMatchObject({ overlapBlockedBy: null });
    expect(updates[updates.length - 1]).not.toHaveProperty("blockedBy");
  });

  it("reroutes to a paused WIP blocker because it retains its file-scope lease", async () => {
    const subject = card("FN-1", "backlog", { overlapBlockedBy: "FN-2", dependencies: ["FN-3"], status: "queued" });
    const { run, updates } = harness(
      [subject, card("FN-2", "shipped"), card("FN-3", "building", { paused: true })],
      RENAMED_IR,
      subject,
    );

    await run();

    expect(updates[updates.length - 1]).toMatchObject({ overlapBlockedBy: "FN-3" });
  });
});
