/*
FNXC:WorkflowLifecycleColumns 2026-08-03-02:30 (this suite outlived its own source changes):

WHAT THIS FILE IS NOW. It arrived with a conversion of `github-tracking-comments.ts` and
`github-tracking-reconciler.ts`; both files were then converted independently by #2715 and #2737 while the PR
sat in the queue. Their implementations differ from mine — a literal comment KIND rather than a derived one, and
a prefetched lifecycle map rather than a bounded take — and **this suite passes against theirs unchanged**.

That is the reason to keep it rather than close it: two independent implementations satisfying the same
assertions is the strongest evidence available that the assertions describe the INVARIANT and not one author's
shape. It also adds the coverage neither PR has — the resolution-COST cases below, which fail against main today
if the bound is removed (measured: 600 resolutions for a 600-row history against a 200-row limit).

Everything below is unchanged from when it was written against my own implementation.
*/
/*
FNXC:WorkflowLifecycleColumns 2026-08-02-00:10 (fleet: the GitHub tracking subsystem on a renamed board):

THE INVARIANT: GitHub tracking recognises "started" and "finished" from the task's OWN workflow.

Both halves of this subsystem decided lifecycle by literal, and both fail QUIETLY — which is the whole
argument for converting them rather than waiting for a bug report:

  - the comment poster returned early for every move, so a tracked issue silently stopped receiving both
    its "in progress" and its "done" comment. The operator sees a linked issue that never updates.
  - the reconciler's three scan passes matched ZERO tasks, so completed work's issues were never closed
    and the pass reported a clean `scanned: 0`. The number that would have revealed the problem is the
    number the bug suppresses.

THE COMMENT POSTER NEEDED A DERIVATION, NOT A SWAP, and that is the finding worth carrying: `event.to`
was BOTH compared against the two literals AND passed into `formatTrackingComment` as its `transition`
argument (typed `"in-progress" | "done"`). One value, two meanings — a lane id and a comment kind. Eight
independent swaps would have had to keep agreeing with each other; resolving the lanes once and deriving
the kind separates them permanently.

REVERT PROOF, measured: restore either file's literals and the renamed-board cases here fail (no comment
is posted; the reconciler closes nothing).
*/
import { describe, expect, it, vi } from "vitest";
import type { TaskStore, WorkflowIr } from "@fusion/core";

const { mockCommentOnIssue, mockSetIssueState } = vi.hoisted(() => ({
  mockCommentOnIssue: vi.fn(),
  mockSetIssueState: vi.fn(),
}));

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(function () {
    return {
      commentOnIssue: (...args: unknown[]) => mockCommentOnIssue(...args),
      setIssueState: (...args: unknown[]) => mockSetIssueState(...args),
      getIssue: vi.fn().mockResolvedValue({ state: "open" }),
    };
  }),
}));

vi.mock("../github-auth.js", () => ({
  resolveGithubTrackingAuth: () => ({ ok: true, auth: { mode: "token", token: "ghp_test" } }),
}));

const { GitHubTrackingCommentService } = await import("../github-tracking-comments.js");
const { GitHubTrackingReconciler } = await import("../github-tracking-reconciler.js");

/** A board whose WIP lane is `building` and complete lane is `shipped`. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

const TRACKED = {
  githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 5 } },
};

function storeWith(tasks: Array<Record<string, unknown>>, ir: WorkflowIr | undefined): TaskStore {
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  const byId = new Map(tasks.map((t) => [t.id as string, t]));
  return {
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => byId.get(id)),
    getSettings: vi.fn(async () => ({
      githubAuthMode: "token", githubAuthToken: "ghp_test", githubCloseSourceIssueOnDone: true,
    })),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn(async () => ({})) })),
    getTaskWorkflowSelection: () => (ir ? selection : undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => (ir ? selection : undefined)),
    getWorkflowDefinition: async () => (ir ? { ir } : undefined),
    logEntry: vi.fn(async () => undefined),
    updateTask: vi.fn(async () => undefined),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

describe("tracking comments follow the board's own wip and complete lanes", () => {
  async function moveTo(column: string, ir: WorkflowIr | undefined) {
    const task = { id: "FN-1", title: "t", description: "d", column, log: [], ...TRACKED };
    const store = storeWith([task], ir);
    const poster = new GitHubTrackingCommentService(store);
    await (poster as unknown as {
      handleTaskMoved: (e: unknown) => Promise<void>;
    }).handleTaskMoved({ task, from: "backlog", to: column });
    return { store };
  }

  it("comments when a card enters the board's WIP lane", async () => {
    // Pre-fix: `building` matched neither literal, so the early return fired and no comment was posted.
    mockCommentOnIssue.mockClear();

    await moveTo("building", RENAMED_IR);

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
  });

  it("comments when a card reaches the board's COMPLETE lane", async () => {
    mockCommentOnIssue.mockClear();

    await moveTo("shipped", RENAMED_IR);

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
  });

  it("stays silent for a move into a lane that is neither", async () => {
    // The paired negative: the derivation must still return early for the review lane.
    mockCommentOnIssue.mockClear();

    await moveTo("signoff", RENAMED_IR);

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
  });

  it("behaves identically on the DEFAULT board", async () => {
    // Passes either way by design — `builtin:coding`'s lanes ARE the literals. No-change evidence.
    mockCommentOnIssue.mockClear();

    await moveTo("in-progress", undefined);

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
  });
});

describe("the reconciler scans the board's complete columns", () => {
  it("finds a renamed board's completed tasks", async () => {
    mockSetIssueState.mockClear();
    const store = storeWith([
      { id: "FN-1", column: "shipped", ...TRACKED },
      { id: "FN-2", column: "building", ...TRACKED },
    ], RENAMED_IR);

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect(result.scanned).toBe(1);
    expect(mockSetIssueState).toHaveBeenCalledTimes(1);
  });

  it("closes a completed row as completed", async () => {
    mockSetIssueState.mockClear();
    const store = storeWith([{ id: "FN-5", column: "shipped", ...TRACKED }], RENAMED_IR);

    await new GitHubTrackingReconciler().reconcile(store);

    expect(mockSetIssueState).toHaveBeenCalledWith("o", "r", 5, "closed", "completed");
  });

  it("still scans the default board's Done rows", async () => {
    mockSetIssueState.mockClear();
    const store = storeWith([
      { id: "FN-6", column: "done", ...TRACKED },
      { id: "FN-7", column: "in-progress", ...TRACKED },
    ], undefined);

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect(result.scanned).toBe(1);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-08-02-01:30 (PR #2714 review — greptile P2):

THE SCAN LIMIT MUST BOUND THE RESOLUTION, not just the result.

The literal filter this conversion replaced was free, so slicing afterwards cost nothing. Resolving a
lifecycle per row is NOT free — it is a store read per task — so resolving every candidate and slicing to
200 turned the cheapest part of the sweep into the most expensive, proportional to total task history
rather than to the configured limit.

Counting `getTask`-equivalent resolutions is the only assertion that can see this: the RESULT is identical
either way (200 rows), so any assertion about the returned set passes with the unbounded version. That is
why this case counts calls rather than checking output — the defect is invisible in the output by
construction.
*/
describe("the reconciler's scan limit bounds the lifecycle resolution", () => {
  it("does not resolve a workflow for every row in a long history", async () => {
    // 600 terminal rows, limit 200: a bounded implementation resolves ~200, an unbounded one resolves 600.
    const tasks = Array.from({ length: 600 }, (_, i) => ({
      id: `FN-${i}`, column: "shipped", ...TRACKED,
    }));
    const store = storeWith(tasks, RENAMED_IR);
    mockSetIssueState.mockClear();

    await new GitHubTrackingReconciler().reconcile(store);

    /*
    `getTaskWorkflowSelectionAsync` is the per-task read inside `resolveTaskLifecycleColumns`, so its call
    count IS the resolution count. Asserting "well under the candidate count" rather than an exact number:
    the point is proportionality to the limit, and pinning an exact count would break on any future
    change to how many rows the pass keeps.
    */
    const resolutions = (store.getTaskWorkflowSelectionAsync as unknown as { mock?: { calls: unknown[] } })
      .mock?.calls.length ?? 0;

    expect(resolutions).toBeLessThan(300);
    expect(resolutions).toBeGreaterThan(0);
  });
});
