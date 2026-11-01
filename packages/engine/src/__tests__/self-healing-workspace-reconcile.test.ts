/*
 * Surface enumeration (docs/testing.md checklist): engine reconcile arm + separate-process CLI and
 * HTTP surfaces are covered by their own suites (task-reconcile.test.ts,
 * routes-task-retry-stale-merge-status.test.ts); no desktop/mobile UI renders this refusal, and no
 * streaming/agent provider path is involved — this file owns the engine arm's behavior only.
 *
 * FNXC:WorkspaceLandedReconcile 2026-11-01-08:41 (RUFU-357):
 * The RUFU-357 symptom: the saneca production board carried 16 `in-review` cards parked by the
 * engine's own `in-review-stall-deadlock` disposition whose summed unique commits across
 * root + 2 sub-repos measured 0 — and `fn task reconcile` refused every one with the bare word
 * `workspace`. These cases are the five measurements named in the spec: A discharge (incl. the
 * RUFU-390 root-repository identity), B refusal naming every repo with its count, C the fence still
 * refusing real operator holds, D merge-confirmed workspace cards untouched, E hostile audit sinks
 * never altering or delaying finalization. The git/git-equivalent seams are faked at their module
 * boundary so the REAL predicates (`evaluateWorkspaceReconcileDischarge`, the ancestry probe, the
 * real stall-park classifier) run over scripted answers; the merge lane's commit-free unit semantics
 * are proven in workspace-commit-free-delivery.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { SelfHealingManager } from "../self-healing.js";
import { COMMIT_FREE_DELIVERY_REASON } from "../merge/workspace-commit-free-delivery.js";

/*
Scripted per-repo answers. `tip` = the branch tip `rev-parse --verify` resolves ("" = gone),
`ancestor` = whether `merge-base --is-ancestor tip base` succeeds, `ahead` = the canonical
rev-list count, `landed` = the sha findProvenLandedCommit proves, `membership` = the RUFU-390
identity answer, `diffShortstat` = the ahead-diagnosis git answer (diagnosis never discharges).
*/
type RepoScript = {
  tip?: string;
  ancestor?: boolean;
  ahead?: number | null;
  landed?: string;
  membership?: "own-repository" | "workspace-root-repository" | "unknown";
  missingDir?: boolean;
  /** `git diff --shortstat base...branch` answer for the ahead-diagnosis (empty = net-zero). */
  diffShortstat?: string;
};

const git = vi.hoisted(() => ({
  repos: new Map<string, RepoScript>(),
  /** Live temp workspace root; the arm only measures directories that exist on disk. */
  root: "",
  reset() { git.repos.clear(); },
}));

function scriptRepo(repo: string, script: RepoScript) {
  git.repos.set(repo, script);
}

/** Maps a probe cwd back to the scripted repository key (probes run with cwd = join(rootDir, repo)). */
function repoForCwd(cwd: string | undefined): RepoScript | undefined {
  if (!cwd || !git.root) return undefined;
  for (const [repo, script] of git.repos) {
    if (cwd === `${git.root}/${repo}` || cwd.startsWith(`${git.root}/${repo}/`)) return script;
  }
  return undefined;
}

/** A real on-disk workspace root with the three member directories the arm stats. */
function createWorkspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rufu-357-"));
  for (const repo of ["saneca", "lager-manager", "lager-2026"]) mkdirSync(join(root, repo), { recursive: true });
  git.root = root;
  return root;
}

vi.mock("../worktree/workspace-root-member.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worktree/workspace-root-member.js")>()),
  resolveWorkspaceRootMembership: vi.fn(async (dir: string) => {
    const script = repoForCwd(dir);
    if (!script || script.membership === "unknown") return { kind: "unknown" };
    if (script.membership === "workspace-root-repository") return { kind: "workspace-root-repository", toplevel: git.root };
    return { kind: "own-repository" };
  }),
}));

vi.mock("../worktree/worktree-backend.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worktree/worktree-backend.js")>()),
  measureAheadCommitCount: vi.fn(async (input: { repoDir: string }) => {
    const script = repoForCwd(input.repoDir);
    return script && "ahead" in script ? script.ahead : null;
  }),
}));

vi.mock("../merge/workspace-land-predicate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../merge/workspace-land-predicate.js")>()),
  findProvenLandedCommit: vi.fn(async (repoRootDir: string) => {
    const script = repoForCwd(repoRootDir);
    return script?.landed;
  }),
}));

vi.mock("../worktree/workspace-base-branch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worktree/workspace-base-branch.js")>()),
  resolveWorkspaceRepoBaseBranch: vi.fn(async () => ({ branch: "main", source: "recorded" })),
  recordWorkspaceBaseBranchDecision: vi.fn(async () => undefined),
}));

/*
The REAL ahead-diagnosis classifier runs over a scripted `execEmptyLandGit` (its git seam), so the
refusal vocabulary (`reverted` only for a PROVEN net-zero, `ahead` with the canonical count)
is exercised as production wiring, not as a mock echo. Diagnosis never discharges.
*/
vi.mock("../merge/empty-land-evidence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../merge/empty-land-evidence.js")>()),
  execEmptyLandGit: vi.fn((rootDir: string) => async (args: string[]) => {
    const script = repoForCwd(rootDir) ?? {};
    if (args[0] === "rev-parse") {
      return script.tip ? { ok: true, stdout: script.tip, exitCode: 0 } : { ok: false, stdout: "", exitCode: 1 };
    }
    if (args[0] === "merge-base") {
      return script.ancestor ? { ok: true, stdout: "", exitCode: 0 } : { ok: false, stdout: "", exitCode: 1 };
    }
    if (args[0] === "rev-list") {
      return { ok: true, stdout: `${script.ahead ?? 0}\n`, exitCode: 0 };
    }
    if (args[0] === "diff") {
      return { ok: true, stdout: script.diffShortstat ?? " 1 file changed, 1 insertion(+)", exitCode: 0 };
    }
    throw new Error(`unexpected empty-land git command: ${args.join(" ")}`);
  }),
}));

/*
The ancestry probe's only git seam is `execAsync("git …", { cwd })` built by the arm's gitText
runner; this fake answers exactly the two commands `createTipAncestryProbe` issues and rejects on
anything else, so an unexpected command fails the test loudly instead of silently succeeding.
*/
vi.mock("../self-healing-git-evidence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../self-healing-git-evidence.js")>()),
  execAsync: vi.fn(async (cmd: string, opts: { cwd?: string }) => {
    const script = repoForCwd(opts.cwd);
    if (!script) throw new Error(`unexpected git cwd ${opts.cwd}`);
    // The arm's gitText quotes EVERY token via shellQuote.
    const revParse = cmd.match(/^git 'rev-parse' '--verify' 'refs\/heads\/([^']+)'$/);
    if (revParse) {
      if (!script.tip) throw new Error(`no such ref: ${revParse[1]}`);
      return { stdout: script.tip, stderr: "" };
    }
    if (/^git 'merge-base' '--is-ancestor' '[0-9a-f]+' 'main'$/.test(cmd)) {
      if (!script.ancestor) throw new Error("not an ancestor");
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected git command: ${cmd}`);
  }),
}));

const baseSettings = {
  globalPause: false,
  enginePaused: false,
  autoMerge: true,
  taskStuckTimeoutMs: 60_000,
} as Settings;

const STALL_ERROR = "In-review stall deadlock: completed-review-status-none repeated 3× without progress. Manual action required.";

/** The SANE-454 shape: engine-parked, zero-unique-commit workspace card in the review lane. */
function parkedWorkspaceCard(overrides: Partial<Task> = {}): Task {
  return {
    id: "SANE-454",
    title: "Workspace card with zero unique commits",
    description: "RUFU-357 symptom card",
    column: "in-review",
    status: "failed",
    error: STALL_ERROR,
    paused: true,
    pausedReason: "in-review-stall-deadlock",
    branch: "fusion/sane-454",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceWorktrees: {
      saneca: { worktreePath: ".worktrees/sane", branch: "fusion/sane-454", baseBranch: "main" },
      "lager-manager": { worktreePath: ".worktrees/sane", branch: "fusion/sane-454", baseBranch: "main" },
      "lager-2026": { worktreePath: ".worktrees/sane", branch: "fusion/sane-454", baseBranch: "main" },
    },
    repositoryScope: { state: "confirmed", repositories: ["saneca", "lager-manager", "lager-2026"] },
    ...overrides,
  } as Task;
}

function zeroCommittedScope() {
  scriptRepo("saneca", { tip: "a11d1111a11d1111", ancestor: true, ahead: 0, membership: "workspace-root-repository" });
  scriptRepo("lager-manager", { tip: "b22c2222b22c2222", ancestor: true, ahead: 0, membership: "own-repository" });
  scriptRepo("lager-2026", { landed: "c33b3333c33b3333", membership: "own-repository" });
}

type TestStore = TaskStore & {
  row: Task;
  updateTask: ReturnType<typeof vi.fn>;
  updateTaskAtomic: ReturnType<typeof vi.fn>;
  moveTask: ReturnType<typeof vi.fn>;
  recordRunAuditEvent?: ReturnType<typeof vi.fn>;
  auditRows: Array<{ mutationType: string; metadata: Record<string, unknown> }>;
};

function storeFor(
  initial: Task,
  options: {
    audit?: "present" | "absent" | "throw" | "reject" | "hang";
    beforeAtomic?: (row: Task) => Task;
  } = {},
): TestStore {
  const auditRows: Array<{ mutationType: string; metadata: Record<string, unknown> }> = [];
  const record = options.audit === "absent"
    ? undefined
    : vi.fn(async (input: { mutationType: string; metadata: Record<string, unknown> }) => {
        if (options.audit === "throw") throw new Error("sink exploded");
        if (options.audit === "reject") return await Promise.reject(new Error("sink rejected"));
        if (options.audit === "hang") return await new Promise<never>(() => undefined);
        auditRows.push({ mutationType: input.mutationType, metadata: input.metadata });
      });
  const store = {
    row: initial,
    getTask: vi.fn(async () => store.row),
    getSettings: vi.fn(async () => baseSettings),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => (!column || store.row.column === column ? [store.row] : [])),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      store.row = { ...store.row, ...patch } as Task;
      return store.row;
    }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Task) => Partial<Task> | null) => {
      const current = options.beforeAtomic ? options.beforeAtomic(store.row) : store.row;
      const patch = updater(current);
      if (!patch) return null;
      store.row = { ...current, ...patch } as Task;
      return store.row;
    }),
    ...(record ? { recordRunAuditEvent: record } : {}),
    auditRows,
    logEntry: vi.fn(async () => undefined),
    moveTask: vi.fn(async (_id: string, column: string) => {
      store.row = { ...store.row, column } as Task;
      return store.row;
    }),
  } as unknown as TestStore;
  return store;
}

function makeManager(store: TestStore) {
  const manager = new SelfHealingManager(store, { rootDir: git.root });
  const internal = manager as unknown as Record<string, unknown>;
  internal.emitTaskMerged = vi.fn();
  internal.probeRepoBranch = vi.fn(async (dir: string) => {
    const script = repoForCwd(dir);
    return script?.tip === undefined || script.tip === "" ? "absent" : "present";
  });
  return manager;
}

function reconcile(manager: SelfHealingManager) {
  return manager.reconcileLandedReviewTask("SANE-454", { source: "manual", requireAutoMergeEligible: false });
}

afterEach(() => {
  git.reset();
  if (git.root) rmSync(git.root, { recursive: true, force: true });
  git.root = "";
  const lease = executingTaskLock.claim("SANE-454");
  if (lease) void executingTaskLock.invalidate(lease);
  for (const path of activeSessionRegistry.pathsForTask("SANE-454")) activeSessionRegistry.unregisterPath(path);
});

describe("reconcileLandedReviewTask workspace discharge (RUFU-357)", () => {
  it("Case A discharges a parked zero-commit workspace card without authoring a commit", async () => {
    createWorkspaceRoot();
    zeroCommittedScope();
    const store = storeFor(parkedWorkspaceCard());
    const manager = makeManager(store);

    const result = await reconcile(manager);

    expect(result).toMatchObject({ outcome: "workspace-discharged", repoCount: 3, dischargedCount: 3 });
    // The red state, the engine-authored park, and the branch pointer are cleared in one write…
    expect(store.row.mergeDetails).toMatchObject({
      mergeConfirmed: true,
      noOpMerge: true,
      noOpReason: COMMIT_FREE_DELIVERY_REASON,
    });
    // …with NO invented commitSha: a tip SHA is branch evidence, not a landing this card authored.
    expect(store.row.mergeDetails?.commitSha).toBeUndefined();
    // RUFU-504's persisted vocabulary: the basis map covers the COMMIT-FREE probe claims only (a
    // landed repository is proven by its own canonical sha, so it gets no probe-basis row), tips are
    // recorded for zero-ahead repos, and landed shas are the `findProvenLandedCommit` answers.
    expect(store.row.mergeDetails?.workspaceCommitFreeBasis).toEqual({
      saneca: "zero-ahead",
      "lager-manager": "zero-ahead",
    });
    expect(store.row.mergeDetails?.workspaceCommitFreeBranchTipShas).toEqual({
      saneca: "a11d1111a11d1111",
      "lager-manager": "b22c2222b22c2222",
    });
    expect(store.row.mergeDetails?.workspaceLandedShas).toEqual({ "lager-2026": "c33b3333c33b3333" });
    expect(store.row.status).toBeNull();
    expect(store.row.error).toBeNull();
    expect(store.row.paused).toBe(false);
    expect(store.row.pausedReason).toBeNull();
    // The card moves through the shared complete-lane moveTask…
    expect(store.moveTask).toHaveBeenCalledWith("SANE-454", expect.any(String));
    // …and exactly ONE bounded audit row names the discharge with ids/counts/fixed bases only.
    const rows = store.auditRows.filter((row) => row.mutationType === "task:reconcile-workspace-landed-review");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      taskId: "SANE-454",
      source: "manual",
      repoCount: 3,
      dischargedCount: 3,
      outcome: "discharged",
      repoBasis: { saneca: "zero-ahead", "lager-manager": "zero-ahead", "lager-2026": "landed" },
    });
    // The RUFU-390 identity is reported as the root repository, never as a separate member.
    const logged = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[1]));
    expect(logged.some((line) => line.includes("resolves to the workspace ROOT repository") && line.includes("saneca"))).toBe(true);
  });

  it("Case B refuses an ahead repository naming EVERY repo with its basis and count", async () => {
    createWorkspaceRoot();
    zeroCommittedScope();
    scriptRepo("lager-2026", { tip: "d44d4444d44d4444", ancestor: false, ahead: 3, membership: "own-repository" });
    const store = storeFor(parkedWorkspaceCard());
    const manager = makeManager(store);

    const result = await reconcile(manager);

    expect(result).toMatchObject({ outcome: "ineligible", reason: "workspace" });
    const eligible = result as Extract<typeof result, { repos?: unknown }>;
    expect(eligible.repos).toEqual([
      { repo: "saneca", basis: "zero-ahead", uniqueCommitCount: 0, measuredAsRootRepository: true },
      { repo: "lager-manager", basis: "zero-ahead", uniqueCommitCount: 0 },
      { repo: "lager-2026", basis: "ahead", uniqueCommitCount: 3 },
    ]);
    // A refusal writes NOTHING: no mergeDetails, no lane move, no audit row, no card log.
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.auditRows.filter((row) => row.mutationType === "task:reconcile-workspace-landed-review")).toEqual([]);
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(store.row.mergeDetails?.mergeConfirmed).toBeUndefined();
  });

  it("Case B2 names the reverted shape but NEVER discharges on diagnosis", async () => {
    createWorkspaceRoot();
    zeroCommittedScope();
    // Proven net-zero: ahead of base while contributing nothing (commits+revert). The diagnosis
    // NAMES it `reverted`; the zero-ahead BAR (tip ancestor + count 0) is not met, so no discharge.
    scriptRepo("lager-2026", { tip: "e55e5555e55e5555", ancestor: false, ahead: 2, diffShortstat: "", membership: "own-repository" });
    const store = storeFor(parkedWorkspaceCard());
    const manager = makeManager(store);

    const result = await reconcile(manager);

    expect(result).toMatchObject({ outcome: "ineligible", reason: "workspace" });
    const held = (result as Extract<typeof result, { repos?: unknown }>).repos as Array<{ repo: string; basis: string; uniqueCommitCount: number | null }>;
    expect(held.find((repo) => repo.repo === "lager-2026")).toEqual({ repo: "lager-2026", basis: "reverted", uniqueCommitCount: 2 });
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });

  it.each([
    ["engine stall park with a user hold underneath", { userPaused: true }, "paused"],
    ["user pause with no engine park", { paused: false, pausedReason: null, error: null, userPaused: true }, "user-paused"],
    ["paused with a different (non-stall) reason", { pausedReason: "operator-hold", error: "Unrelated failure." }, "paused"],
  ] as const)("Case C (%s) is refused while the row stays untouched", async (_name, overrides, reason) => {
    createWorkspaceRoot();
    zeroCommittedScope();
    const store = storeFor(parkedWorkspaceCard(overrides));
    const manager = makeManager(store);

    await expect(reconcile(manager)).resolves.toMatchObject({ outcome: "ineligible", reason });
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("Case D leaves a merge-confirmed workspace card to the post-merge lane, untouched and unaudited", async () => {
    createWorkspaceRoot();
    zeroCommittedScope();
    const store = storeFor(parkedWorkspaceCard({
      mergeDetails: { mergedAt: new Date().toISOString(), mergeConfirmed: true, commitSha: "f66f6666f66f6666" },
    }));
    const manager = makeManager(store);

    await expect(reconcile(manager)).resolves.toEqual({ outcome: "ineligible", reason: "workspace" });
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.auditRows.filter((row) => row.mutationType === "task:reconcile-workspace-landed-review")).toEqual([]);
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("Case E hostile audit sinks cannot alter or wedge the finalization", async () => {
    for (const audit of ["throw", "reject", "absent"] as const) {
      git.reset();
      createWorkspaceRoot();
      zeroCommittedScope();
      const store = storeFor(parkedWorkspaceCard(), { audit });
      const manager = makeManager(store);
      await expect(reconcile(manager)).resolves.toMatchObject({ outcome: "workspace-discharged", dischargedCount: 3 });
      expect(store.moveTask).toHaveBeenCalled();
      expect(store.row.paused).toBe(false);
      if (git.root) rmSync(git.root, { recursive: true, force: true });
      git.root = "";
    }
    // A hanging sink is bounded by the FN-9175 seam's own timeout, not by this card's patience.
    git.reset();
    createWorkspaceRoot();
    zeroCommittedScope();
    const hanging = storeFor(parkedWorkspaceCard(), { audit: "hang" });
    await expect(reconcile(makeManager(hanging))).resolves.toMatchObject({ outcome: "workspace-discharged" });
    expect(hanging.moveTask).toHaveBeenCalled();
  }, 15_000);

  it("refuses a workspace card whose scope is not confirmed", async () => {
    createWorkspaceRoot();
    zeroCommittedScope();
    const store = storeFor(parkedWorkspaceCard({ repositoryScope: undefined }));
    await expect(reconcile(makeManager(store))).resolves.toEqual({ outcome: "ineligible", reason: "workspace-scope-unresolved" });
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("refuses a confirmed-but-empty obligation set instead of discharging on nothing", async () => {
    createWorkspaceRoot();
    const store = storeFor(parkedWorkspaceCard({ repositoryScope: { state: "confirmed", repositories: [] } as Task["repositoryScope"] }));
    await expect(reconcile(makeManager(store))).resolves.toEqual({ outcome: "ineligible", reason: "workspace-obligations-empty" });
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("refuses on an unknown membership answer rather than guessing identity", async () => {
    createWorkspaceRoot();
    zeroCommittedScope();
    scriptRepo("lager-manager", { tip: "b22c2222b22c2222", ancestor: true, ahead: 0, membership: "unknown" });
    const store = storeFor(parkedWorkspaceCard());
    const result = await reconcile(makeManager(store));
    expect(result).toMatchObject({ outcome: "ineligible", reason: "workspace-probe-unavailable" });
    expect((result as Extract<typeof result, { repos?: unknown }>).repos).toEqual([
      { repo: "lager-manager", basis: "probe-unavailable", uniqueCommitCount: null },
    ]);
  });

  it("CAS-refuses when workspaceWorktrees drift between proof and write", async () => {
    createWorkspaceRoot();
    zeroCommittedScope();
    const store = storeFor(parkedWorkspaceCard(), {
      beforeAtomic: (row) => ({
        ...row,
        workspaceWorktrees: { ...row.workspaceWorktrees, "lager-2026": { worktreePath: "/elsewhere", branch: "fusion/replaced" } },
      }),
    });
    await expect(reconcile(makeManager(store))).resolves.toEqual({ outcome: "raced", reason: "task-state-changed" });
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.auditRows.filter((row) => row.mutationType === "task:reconcile-workspace-landed-review")).toEqual([]);
  });

  it("CAS-refuses when a different park replaces the stall admission mid-proof", async () => {
    createWorkspaceRoot();
    zeroCommittedScope();
    const store = storeFor(parkedWorkspaceCard(), {
      beforeAtomic: (row) => ({ ...row, pausedReason: "some-other-park" }),
    });
    await expect(reconcile(makeManager(store))).resolves.toEqual({ outcome: "raced", reason: "task-state-changed" });
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("refuses a shared-branch-group member outright (its landing needs member-landing semantics)", async () => {
    createWorkspaceRoot();
    zeroCommittedScope();
    const store = storeFor(parkedWorkspaceCard({
      branchContext: { assignmentMode: "shared", groupId: "group-1", branch: "fusion/shared" } as Task["branchContext"],
    }));
    await expect(reconcile(makeManager(store))).resolves.toEqual({ outcome: "ineligible", reason: "shared-branch-group" });
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });
});
