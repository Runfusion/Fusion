/*
FNXC:MergeRebuild0919 2026-09-19-21:45:
Both lines added this file with the same three cases; only the mock surface differs, so the merge is a union keyed to
what the MERGED `../task.js` actually imports. Ours owns the `@fusion/engine` list (canonical still names
`installBaselineArchiveWorktreeDisposer`, whose call site this line's archive retirement removed), and canonical's
extra module stubs (`createLocalStore` on project-context, `../../output.js`, `../node.js`) stay so module load can
never reach real output formatting or node-lookup code.
*/
import { afterEach, describe, expect, it, vi } from "vitest";

const reconcile = vi.hoisted(() => vi.fn());
const close = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@fusion/core", () => ({
  COLUMNS: [], COLUMN_LABELS: {}, MAX_TASK_MESSAGE_LENGTH: 10_000,
  TaskStore: vi.fn(), CentralCore: vi.fn(),
}));
vi.mock("@fusion/engine", () => ({
  SelfHealingManager: class {
    reconcileLandedReviewTask = reconcile;
  },
  admitTaskToWip: vi.fn(),
  isFirstPlanningToWipAdmission: vi.fn(),
  isInReviewMissingWorktreeSessionStartFailure: vi.fn(),
  planTaskWorktreePath: vi.fn(),
  isFailedNoVerdictPreMergeReviewResult: vi.fn(() => false),
  runAiMerge: vi.fn(),
  landWorkspaceTask: vi.fn(),
  withWorkspaceMergeDispatchLease: vi.fn(),
  clearOwnedMergeStamp: vi.fn(),
  reconcileUnownedStaleMergeStamp: vi.fn(),
}));
vi.mock("../../project-context.js", () => ({
  resolveProject: vi.fn(async () => ({ store: {}, projectPath: "/project" })),
  createLocalStore: vi.fn(),
  closeProjectStore: close,
}));
vi.mock("../../lock-retry.js", () => ({ retryOnLock: async (body: () => unknown) => body(), LockRetryExhaustedError: class extends Error {} }));
vi.mock("../../output.js", () => ({ promptOutputStream: vi.fn(), result: vi.fn() }));
vi.mock("../node.js", () => ({ findNodeByNameOrId: vi.fn() }));
vi.mock("@fusion/dashboard", () => ({}));
vi.mock("@fusion/dashboard/planning", () => ({}));
vi.mock("@fusion/core/gh-cli", () => ({}));
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));
vi.mock("node:fs", () => ({ watchFile: vi.fn(), unwatchFile: vi.fn(), statSync: vi.fn(), existsSync: vi.fn(), readFileSync: vi.fn() }));

import { runTaskReconcile } from "../task.js";

describe("runTaskReconcile", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);

  afterEach(() => {
    reconcile.mockReset(); close.mockClear(); log.mockClear(); error.mockClear(); exit.mockClear();
  });

  it("uses the shared manual reconciliation fence and reports landing", async () => {
    reconcile.mockResolvedValue({ outcome: "reconciled", sha: "abc123", strategy: "trailer", baseBranch: "main" });
    await runTaskReconcile("FN-9304", "project");
    expect(reconcile).toHaveBeenCalledWith("FN-9304", { source: "manual", requireAutoMergeEligible: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("abc123"));
  });

  it("reports a resumed post-merge gate as successful recovery", async () => {
    reconcile.mockResolvedValue({ outcome: "resumed", gateId: "post-merge-verification" });
    await expect(runTaskReconcile("FN-9442", "project")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("post-merge-verification"));
    expect(exit).not.toHaveBeenCalled();
  });

  it("reports an already-complete card as a successful no-op", async () => {
    reconcile.mockResolvedValue({ outcome: "already-complete" });
    await expect(runTaskReconcile("FN-9304", "project")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("already complete"));
    expect(exit).not.toHaveBeenCalled();
  });

  /*
  FNXC:WorkspaceLandedReconcile 2026-11-01-08:27 (RUFU-357):
  The commit-free discharge must read differently from the singular success: no SHA claim, every
  repository named with its basis and base, and "no commit authored" stated — the operator needs to
  know the card completed without anything ever being merged.
  */
  it("renders the workspace discharge without claiming a commit", async () => {
    reconcile.mockResolvedValue({
      outcome: "workspace-discharged",
      repoCount: 3,
      dischargedCount: 3,
      repos: [
        { repo: "saneca", basis: "zero-ahead", baseBranch: "main", branchTipSha: "aaaa1111aaaa1111" },
        { repo: "lager-manager", basis: "zero-ahead", baseBranch: "main", branchTipSha: "bbbb2222bbbb2222" },
        { repo: "lager-2026", basis: "landed", baseBranch: "main", landedSha: "cccc3333cccc3333" },
      ],
    });
    await expect(runTaskReconcile("SANE-454", "project")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("3/3 repositories proven commit-free"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("lager-2026 landed at cccc3333 on main"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no commit authored"));
    expect(exit).not.toHaveBeenCalled();
  });

  /*
  FNXC:WorkspaceLandedReconcile 2026-11-01-08:27 (RUFU-357):
  The RUFU-357 defect verbatim: the refusal could only ever say `workspace`. The unconfirmed refusal
  now names every repository with its basis and — where git counted them — its unique commits, while
  the mergeConfirmed class keeps the bare sentence byte-identically.
  */
  it("names every repository in the widened workspace refusal", async () => {
    reconcile.mockResolvedValue({
      outcome: "ineligible",
      reason: "workspace",
      repos: [
        { repo: "lager-2026", basis: "ahead", uniqueCommitCount: 1 },
        { repo: "lager-manager", basis: "zero-ahead", uniqueCommitCount: 0 },
      ],
    });
    await expect(runTaskReconcile("SANE-463", "project")).rejects.toThrow("exit:1");
    expect(error).toHaveBeenCalledWith("Cannot reconcile SANE-463: workspace (lager-2026 ahead 1; lager-manager zero-ahead).");
    expect(close).toHaveBeenCalled();
  });

  it("keeps the merge-confirmed workspace refusal sentence bare", async () => {
    reconcile.mockResolvedValue({ outcome: "ineligible", reason: "workspace" });
    await expect(runTaskReconcile("SANE-452", "project")).rejects.toThrow("exit:1");
    expect(error).toHaveBeenCalledWith("Cannot reconcile SANE-452: workspace.");
  });

  it.each([
    [{ outcome: "not-landed", baseBranch: "main" }, "never fabricates an approval"],
    [{ outcome: "raced", reason: "task-state-changed" }, "changed while reconciling"],
    [{ outcome: "ineligible", reason: "checkout-leased" }, "something is still working"],
  ])("refuses unsafe result %# without mutating", async (result, message) => {
    reconcile.mockResolvedValue(result);
    await expect(runTaskReconcile("FN-9304", "project")).rejects.toThrow("exit:1");
    expect(error).toHaveBeenCalledWith(expect.stringContaining(message as string));
    expect(close).toHaveBeenCalled();
  });
});
