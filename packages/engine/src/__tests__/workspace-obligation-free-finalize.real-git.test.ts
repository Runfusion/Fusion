/*
FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-19:52 (RUFU-451) — the symptom, end to end:
SANE-509 was a workspace card whose entire deliverable was git-ignored board paths. Its own spec said
"no commit and no changeset", both review gates approved, every member branch sat at zero unique commits,
and the landing step refused it anyway, because the only thing it knew how to deliver was a commit. This
file drives the REAL `landWorkspaceTask` against a REAL git workspace fixture and asserts the two halves of
the fix that only real git can prove:

  1. a card that declared zero commits and provably holds nothing anywhere CLOSES, with no commit authored,
     no ref moved, no checkout created, no `merging` status written and no land intent published; and
  2. every shape that is NOT proven stays refused, unchanged, with the card sitting exactly where it was —
     including the RUFU-262 shape, where uncommitted work is sitting in a tree this finalize would walk away
     from. That tree is preserved, not cleaned.

Real git only where the invariant requires it; the AI merge/review agents are injected so no real AI call
happens, exactly as `workspace-merger.test.ts` does.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import { landWorkspaceTask } from "../merge/merger-ai.js";
import { createWorkspaceFixture, hasGit, initRepoWithCommit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

const TASK_ID = "SANE-9001";
const BRANCH = "fusion/sane-9001";

beforeEach(() => {
  vi.stubEnv("GIT_AUTHOR_NAME", "Test");
  vi.stubEnv("GIT_AUTHOR_EMAIL", "test@example.com");
  vi.stubEnv("GIT_COMMITTER_NAME", "Test");
  vi.stubEnv("GIT_COMMITTER_EMAIL", "test@example.com");
});
afterEach(() => vi.unstubAllEnvs());

let currentTask: Task | undefined;

interface RecordingStore extends EventEmitter {
  moveTaskCalls: Array<{ id: string; column: string }>;
  statusWrites: Array<string | null | undefined>;
  emitted: Array<{ event: string; payload: unknown }>;
}

function createStore(): TaskStore & RecordingStore {
  const emitter = new EventEmitter();
  const moveTaskCalls: Array<{ id: string; column: string }> = [];
  const statusWrites: Array<string | null | undefined> = [];
  const emitted: Array<{ event: string; payload: unknown }[]> = [];
  const realEmit = emitter.emit.bind(emitter);
  const store = Object.assign(emitter, {
    moveTaskCalls,
    statusWrites,
    emitted,
    getSettings: vi.fn().mockResolvedValue({ autoMerge: false }),
    getProjectId: vi.fn().mockReturnValue("test-project"),
    updateTask: vi.fn((id: string, patch: Partial<Task>) => {
      if ("status" in patch) statusWrites.push(patch.status);
      if (currentTask) Object.assign(currentTask, patch);
      return Promise.resolve(currentTask);
    }),
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (task: Task) => Partial<Task> | undefined) => {
      const current = await store.getTask(TASK_ID) as Task;
      const patch = mutate(current);
      if (patch) Object.assign(current, patch);
      return current;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn(async () => currentTask),
    getStaleReviewCallbackWaiverReceipts: vi.fn().mockResolvedValue([]),
    moveTask: vi.fn((id: string, column: string) => {
      moveTaskCalls.push({ id, column });
      if (currentTask) currentTask.column = column;
      return Promise.resolve(currentTask);
    }),
    moveTaskIf: vi.fn(async (id: string, column: string, predicate: (live: Task) => boolean | Promise<boolean>) => {
      const task = await store.getTask(id) as Task;
      if (!await predicate(task)) return { moved: false, task };
      return { moved: true, task: await store.moveTask(id, column) };
    }),
    mergeWorkspaceWorktreeEntry: vi.fn(async (_id: string, repoRel: string, patch: Record<string, unknown>, options?: { requireExistingEntry?: boolean }) => {
      const task = await store.getTask(TASK_ID) as Task;
      const entries = { ...(task.workspaceWorktrees ?? {}) } as Record<string, Record<string, unknown>>;
      if (options?.requireExistingEntry && !entries[repoRel]) return task;
      entries[repoRel] = { ...(entries[repoRel] ?? {}), ...patch };
      task.workspaceWorktrees = entries as Task["workspaceWorktrees"];
      return task;
    }),
    upsertTaskCommitAssociation: vi.fn().mockResolvedValue(undefined),
    accumulateTokenUsage: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    emit: (event: string, payload?: unknown) => {
      emitted.push({ event, payload } as { event: string; payload: unknown }[]);
      return realEmit(event, payload);
    },
  }) as unknown as TaskStore & RecordingStore;
  return store;
}

/** The source-free workspace card: an authorized contract, one declared member, nothing acquired. */
function obligationFreeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "Source-free workspace card",
    description: "",
    column: "in-review",
    branch: BRANCH,
    dependencies: [],
    steps: [{ name: "Preflight", status: "done" }],
    currentStep: 1,
    log: [],
    comments: [],
    steeringComments: [],
    enabledWorkflowSteps: [],
    noCommitsExpected: true,
    // Declared one member and acquired no checkout for it — the shape every workspace gate was blind to.
    repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 1 },
    workspaceWorktrees: {},
    modifiedFiles: [],
    createdAt: new Date("2000-01-02T00:00:00Z").toISOString(),
    updatedAt: new Date("2000-01-02T00:00:00Z").toISOString(),
    ...overrides,
  } as Task;
}

function land(store: TaskStore & RecordingStore, workspaceRootDir: string) {
  return landWorkspaceTask(store, currentTask as Task, workspaceRootDir, {}, {
    mergeAgent: { name: "test", model: "test" },
    reviewAgent: { name: "review", model: "test" },
  } as never);
}

describeIfGit("landWorkspaceTask obligation-free finalize for a source-free workspace card (RUFU-451)", () => {
  let fx: WorkspaceFixture;
  afterEach(() => {
    fx?.cleanup();
    currentTask = undefined;
  });

  it("closes the card without authoring a commit, moving a ref, or acquiring anything", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const tipBefore = fx.git("repo-a", "git rev-parse refs/heads/main");
    const commitCountBefore = fx.git("repo-a", "git rev-list --count --all");
    currentTask = obligationFreeTask();
    const store = createStore();

    const result = await land(store, fx.rootDir);

    expect(result.finalized).toBe(true);
    expect(result.allLanded).toBe(true);
    expect(result.repos).toEqual([]);
    expect(currentTask?.mergeDetails).toMatchObject({ mergeConfirmed: true, noOpMerge: true });
    expect(currentTask?.mergeDetails?.noOpReason).toContain("holds no artifact of this card");
    // Nothing delivery-shaped was invented: no representative sha, no per-repo landing map.
    expect(currentTask?.mergeDetails?.commitSha).toBeUndefined();
    expect(currentTask?.mergeDetails?.workspaceLandedShas).toBeUndefined();
    // The one record of "there was nothing here" is the basis row, and it says ABSENCE.
    expect(currentTask?.mergeDetails?.workspaceCommitFreeBasis).toEqual({ "repo-a": "absent" });

    // git is the arbiter: the member's integration ref and its whole history are untouched.
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).toBe(tipBefore);
    expect(fx.git("repo-a", "git rev-list --count --all")).toBe(commitCountBefore);
    // No checkout was created for the declared member, and no worktree was registered in it.
    expect(fx.git("repo-a", "git worktree list --porcelain")).not.toContain(TASK_ID.toLowerCase());
    // No dispatch/tenancy status write happened: the card never entered `merging`.
    expect(store.statusWrites.filter((status) => status === "merging")).toEqual([]);
    expect(store.moveTaskCalls).toEqual([{ id: TASK_ID, column: "done" }]);
  });

  it("refuses a declared member whose task branch exists — an unacquired member is not an absence", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    // The branch EXISTS in the member the card never acquired: something was named there. Whether it ever
    // carried work is exactly the question an absence read may not answer, so the card keeps its refusal.
    fx.git("repo-a", `git branch ${BRANCH} refs/heads/main`);
    currentTask = obligationFreeTask();
    const store = createStore();

    await expect(land(store, fx.rootDir)).rejects.toThrow(/operator repair/i);
    expect(currentTask?.mergeDetails?.mergeConfirmed).toBeUndefined();
    expect(store.moveTaskCalls).toEqual([]);
  });

  it("refuses a card that never made the declaration, byte-identically to before the door existed", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    currentTask = obligationFreeTask({ noCommitsExpected: undefined });
    const store = createStore();

    await expect(land(store, fx.rootDir)).rejects.toThrow(/operator repair/i);
    expect(currentTask?.mergeDetails?.mergeConfirmed).toBeUndefined();
  });

  it("holds, and preserves the tree, when uncommitted work is sitting in the tree this card owns", async () => {
    /*
    FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-19:53 (RUFU-451) — the RUFU-262 loss shape at the workspace door.
    The obligation-free close asks the shipped door the content question, and the door asks it of the tree the CARD
    owns (`task.worktree`). A workspace card that owns no tree has no content that could be lost, which is what
    makes the close legitimate; a card that DOES own a tree carrying work must be refused and its work left exactly
    where it is. That boundary is what keeps "the card declared zero commits" from ever becoming "the card's
    uncommitted work is quietly discarded" — the loss this repository already paid for once.
    */
    fx = await createWorkspaceFixture(["repo-a"]);
    const treeDir = path.join(fx.rootDir, "card-tree");
    initRepoWithCommit(treeDir);
    execSync(`git checkout -b ${BRANCH}`, { cwd: treeDir, stdio: "pipe" });
    writeFileSync(path.join(treeDir, "notes.md"), "work in progress\n", "utf-8");
    currentTask = obligationFreeTask({ worktree: treeDir, baseBranch: "main" });
    const store = createStore();

    const result = await land(store, fx.rootDir);

    // A refusal to finalize is a WAIT, not a failure: no `failed`, no move, no confirmation written.
    expect(result.finalized).toBe(false);
    expect(result.finalizeBlockedReason).toBeTruthy();
    expect(currentTask?.mergeDetails?.mergeConfirmed).not.toBe(true);
    // Nothing moved and nothing was terminalised: the card waits where it stands.
    expect(store.moveTaskCalls).toEqual([]);
    expect(store.statusWrites.filter((status) => status === "failed")).toEqual([]);
    // The work is still there — the tree this refusal exists to protect.
    expect(execSync("git status --porcelain", { cwd: treeDir, encoding: "utf-8" })).toContain("notes.md");
  });
});

/*
FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-21:20 (RUFU-451) — the card that HOLDS checkouts it never declared:
The SANE-509 row that motivated this task was not "declared nothing, acquired nothing" — it was three ACQUIRED
member entries against a confirmed scope naming zero repositories. The merge door classified that shape
obligation-free and closed it on the card-level door alone (measuring no member, no tip, no tree), while
`reconcileLandedReviewTask`, over the very same row, took the acquired set as its obligation set. These cases pin
the two doors to the one rule: what a card holds is what it owes proof about, at every door.
*/
describeIfGit("landWorkspaceTask obligation-free finalize for a card holding undeclared checkouts (RUFU-451)", () => {
  let fx: WorkspaceFixture;
  afterEach(() => {
    fx?.cleanup();
    currentTask = undefined;
  });

  /** The SANE-509 shape: authorized, a confirmed scope of zero repositories, members actually acquired. */
  function undeclaredCheckoutTask(worktrees: Task["workspaceWorktrees"]): Task {
    return obligationFreeTask({
      repositoryScope: { repositories: [], state: "confirmed", revision: 1 },
      workspaceWorktrees: worktrees,
    }) as Task;
  }

  it("proves every checkout the card holds on its own base before it closes the card", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const worktrees = {
      "repo-a": fx.createLinkedTaskWorktree("repo-a", BRANCH),
      "repo-b": fx.createLinkedTaskWorktree("repo-b", BRANCH),
    };
    const tipsBefore = {
      "repo-a": fx.git("repo-a", "git rev-parse refs/heads/main"),
      "repo-b": fx.git("repo-b", "git rev-parse refs/heads/main"),
    };
    currentTask = undeclaredCheckoutTask({
      "repo-a": { worktreePath: worktrees["repo-a"].worktreePath, branch: BRANCH, baseBranch: "main" },
      "repo-b": { worktreePath: worktrees["repo-b"].worktreePath, branch: BRANCH, baseBranch: "main" },
    });
    const store = createStore();

    const result = await land(store, fx.rootDir);

    expect(result.finalized).toBe(true);
    expect(result.repos).toEqual([]);
    expect(currentTask?.mergeDetails).toMatchObject({ mergeConfirmed: true, noOpMerge: true });
    // The claim is now an ANCESTRY claim, and it is only made because the ancestry was actually read.
    expect(currentTask?.mergeDetails?.noOpReason).toMatch(/task branch tip is an ancestor/);
    // It must also say where the obligation set came from: the row declares zero repositories while the
    // persisted basis names two, and a reader who cannot see the substitution reads a contradiction.
    expect(currentTask?.mergeDetails?.noOpReason).toContain("the card's confirmed scope named no repository");
    expect(currentTask?.mergeDetails?.workspaceCommitFreeBasis).toEqual({
      "repo-a": "zero-ahead", "repo-b": "zero-ahead",
    });
    expect(currentTask?.mergeDetails?.commitSha).toBeUndefined();
    expect(currentTask?.mergeDetails?.workspaceLandedShas).toBeUndefined();
    // Measuring is a read: both integration refs are byte-identical to before the close.
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).toBe(tipsBefore["repo-a"]);
    expect(fx.git("repo-b", "git rev-parse refs/heads/main")).toBe(tipsBefore["repo-b"]);
    expect(store.statusWrites.filter((status) => status === "merging")).toEqual([]);
    expect(store.moveTaskCalls).toEqual([{ id: TASK_ID, column: "done" }]);
  });

  it("refuses to close while a checkout it holds is ahead of its base without contributing anything", async () => {
    /*
    FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-21:30 (RUFU-451) — the shape no other read can see:
    A branch carrying a real file diff is already caught upstream, by the review-evidence out-of-scope guard (a
    later case here pins that). The gap was the ahead-and-net-zero member: `git diff base...branch` answers empty,
    so the review evidence calls it untouched, while `merge-base --is-ancestor` says the branch is NOT contained —
    work exists that the integration branch has never seen. Only the ancestry probe distinguishes the two, and
    until this rule nothing ran it for a member the declaration never named.
    */
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const worktrees = {
      "repo-a": fx.createLinkedTaskWorktree("repo-a", BRANCH),
      "repo-b": fx.createLinkedTaskWorktree("repo-b", BRANCH),
    };
    // One commit that changes nothing: the branch is ahead of `main` while its three-dot contribution is empty.
    execSync("git commit --allow-empty -m 'chore: a commit the integration branch has never seen'", {
      cwd: worktrees["repo-b"].worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(fx.git("repo-b", `git diff --name-only refs/heads/main...refs/heads/${BRANCH}`)).toBe("");
    currentTask = undeclaredCheckoutTask({
      "repo-a": { worktreePath: worktrees["repo-a"].worktreePath, branch: BRANCH, baseBranch: "main" },
      "repo-b": { worktreePath: worktrees["repo-b"].worktreePath, branch: BRANCH, baseBranch: "main" },
    });
    const store = createStore();

    const result = await land(store, fx.rootDir);

    // The close is refused, and the refusal names the repository the declaration never mentioned.
    expect(result.finalized).toBe(false);
    expect(result.finalizeBlockedReason).toContain("repo-b");
    expect(result.finalizeBlockedReason).toMatch(/not proven at zero commits ahead/);
    expect(currentTask?.mergeDetails?.mergeConfirmed).not.toBe(true);
    // A refusal spends no retry budget, terminalises nothing, and moves nothing.
    expect(store.moveTaskCalls).toEqual([]);
    expect(store.statusWrites.filter((status) => status === "failed")).toEqual([]);
    // The work survives the refusal: nothing was merged, dropped, or rewritten to make the declaration true.
    expect(fx.git("repo-b", `git rev-list --count refs/heads/main..refs/heads/${BRANCH}`)).toBe("1");
  });

  it("still refuses an undeclared member carrying a real file diff, at the guard that already caught it", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const worktrees = {
      "repo-a": fx.createLinkedTaskWorktree("repo-a", BRANCH),
      "repo-b": fx.createLinkedTaskWorktree("repo-b", BRANCH),
    };
    writeFileSync(path.join(worktrees["repo-b"].worktreePath, "shipped.rs"), "fn delivered() {}\n", "utf-8");
    execSync("git add shipped.rs && git commit -m 'feat: deliver unreferenced work'", {
      cwd: worktrees["repo-b"].worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
    });
    currentTask = undeclaredCheckoutTask({
      "repo-a": { worktreePath: worktrees["repo-a"].worktreePath, branch: BRANCH, baseBranch: "main" },
      "repo-b": { worktreePath: worktrees["repo-b"].worktreePath, branch: BRANCH, baseBranch: "main" },
    });
    const store = createStore();

    // The review-evidence guard runs first and its refusal stands unchanged: the new rule adds a measurement, it
    // never replaces a refusal that was already earned.
    await expect(land(store, fx.rootDir)).rejects.toThrow(/modified outside confirmed scope/i);
    expect(currentTask?.mergeDetails?.mergeConfirmed).not.toBe(true);
    expect(store.moveTaskCalls).toEqual([]);
  });

  it("refuses, and keeps the tree, when uncommitted work sits in a checkout the declaration never mentions", async () => {
    /*
    FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-21:25 (RUFU-451) — RUFU-262's loss class at the undeclared door:
    An ahead BRANCH is visible to a ref read; an uncommitted file is visible to nothing but a content read of the
    tree that holds it. The card-level door asks that question of `task.worktree`, which an acquired-checkout
    workspace card does not carry, so before this rule an obligation-free close could walk away from a member
    checkout holding the card's only work.
    */
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const worktrees = {
      "repo-a": fx.createLinkedTaskWorktree("repo-a", BRANCH),
      "repo-b": fx.createLinkedTaskWorktree("repo-b", BRANCH),
    };
    const dirtyFile = path.join(worktrees["repo-a"].worktreePath, "work-in-progress.md");
    writeFileSync(dirtyFile, "not committed yet\n", "utf-8");
    currentTask = undeclaredCheckoutTask({
      "repo-a": { worktreePath: worktrees["repo-a"].worktreePath, branch: BRANCH, baseBranch: "main" },
      "repo-b": { worktreePath: worktrees["repo-b"].worktreePath, branch: BRANCH, baseBranch: "main" },
    });
    const store = createStore();

    const result = await land(store, fx.rootDir);

    expect(result.finalized).toBe(false);
    expect(result.finalizeBlockedReason).toBeTruthy();
    expect(currentTask?.mergeDetails?.mergeConfirmed).not.toBe(true);
    expect(store.moveTaskCalls).toEqual([]);
    // The untracked work is exactly where it was — the tree this refusal exists to protect.
    expect(execSync("git status --porcelain", { cwd: worktrees["repo-a"].worktreePath, encoding: "utf-8" }))
      .toContain("work-in-progress.md");
  });
});
