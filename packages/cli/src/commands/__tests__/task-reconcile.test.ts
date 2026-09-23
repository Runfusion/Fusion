import { afterEach, describe, expect, it, vi } from "vitest";

const reconcile = vi.hoisted(() => vi.fn());
const close = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@fusion/core", () => ({
  COLUMNS: [],
  COLUMN_LABELS: {},
  MAX_TASK_MESSAGE_LENGTH: 10_000,
  TaskStore: vi.fn(),
  CentralCore: vi.fn(),
}));
vi.mock("@fusion/engine", () => ({
  SelfHealingManager: class {
    reconcileLandedReviewTask = reconcile;
  },
  isInReviewMissingWorktreeSessionStartFailure: vi.fn(),
  isFailedNoVerdictPreMergeReviewResult: vi.fn(() => false),
  installBaselineArchiveWorktreeDisposer: vi.fn(),
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
vi.mock("../../lock-retry.js", () => ({
  retryOnLock: async (body: () => unknown) => body(),
  LockRetryExhaustedError: class extends Error {},
}));
vi.mock("../../output.js", () => ({
  promptOutputStream: vi.fn(),
  result: vi.fn(),
}));
vi.mock("../node.js", () => ({ findNodeByNameOrId: vi.fn() }));
vi.mock("@fusion/dashboard", () => ({}));
vi.mock("@fusion/dashboard/planning", () => ({}));
vi.mock("@fusion/core/gh-cli", () => ({}));
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));
vi.mock("node:fs", () => ({
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
  statSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { runTaskReconcile } from "../task.js";

describe("runTaskReconcile", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);

  afterEach(() => {
    reconcile.mockReset();
    close.mockClear();
    log.mockClear();
    error.mockClear();
    exit.mockClear();
  });

  it("uses the shared manual reconciliation fence and reports landing", async () => {
    reconcile.mockResolvedValue({ outcome: "reconciled", sha: "abc123", strategy: "trailer", baseBranch: "main" });
    await runTaskReconcile("FN-9304", "project");
    expect(reconcile).toHaveBeenCalledWith("FN-9304", { source: "manual", requireAutoMergeEligible: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("abc123"));
  });

  it("reports an already-complete card as a successful no-op", async () => {
    reconcile.mockResolvedValue({ outcome: "already-complete" });
    await expect(runTaskReconcile("FN-9304", "project")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("already complete"));
    expect(exit).not.toHaveBeenCalled();
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
