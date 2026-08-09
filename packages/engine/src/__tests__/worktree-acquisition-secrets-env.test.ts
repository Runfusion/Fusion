import { dirname } from "node:path";

import { describe, it, expect, vi, beforeEach } from "vitest";

const { writeSecretsEnvFile, reconcileSecretsEnvFingerprint, refreshReusedWorktreeBase } = vi.hoisted(() => ({
  writeSecretsEnvFile: vi.fn(),
  reconcileSecretsEnvFingerprint: vi.fn(),
  refreshReusedWorktreeBase: vi.fn(),
}));

vi.mock("../worktree/secrets-env-writer.js", () => ({
  writeSecretsEnvFile,
  reconcileSecretsEnvFingerprint,
}));

vi.mock("../worktree-base-refresh.js", () => ({
  refreshReusedWorktreeBase,
}));

vi.mock("../worktree/worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../worktree/worktree-pool.js");
  return {
    ...actual,
    classifyTaskWorktree: vi.fn().mockResolvedValue({ ok: true }),
    isInsideWorktreesDir: vi.fn().mockReturnValue(true),
  };
});

vi.mock("../worktree/worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 0, documentsCopied: 0, artifactsCopied: 0 }),
}));

/*
FNXC:EngineTests 2026-07-21-00:10:
Pool unit tests use non-git temp paths; identity guard would throw and fall through to fresh.
*/
vi.mock("../worktree/worktree-hooks.js", async () => {
  const actual = await vi.importActual<any>("../worktree/worktree-hooks.js");
  return {
    ...actual,
    installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined),
  };
});

import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";
import { classifyTaskWorktree } from "../worktree/worktree-pool.js";

describe("worktree-acquisition secrets env hook", () => {
  const task = { id: "FN-1", title: "t", description: "d", branch: null, worktree: null } as any;
  let store: any;

  beforeEach(() => {
    writeSecretsEnvFile.mockReset().mockResolvedValue({ outcome: "skipped", filename: ".env", reason: "disabled" });
    reconcileSecretsEnvFingerprint.mockReset().mockResolvedValue({ executionSafe: true, outcome: "clean" });
    refreshReusedWorktreeBase.mockReset().mockResolvedValue({ kind: "up-to-date", executionSafe: true });
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
    store = { updateTask: vi.fn().mockResolvedValue(undefined), logEntry: vi.fn().mockResolvedValue(undefined) };
  });

  it("calls writer on pool", async () => {
    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { recycleWorktrees: true, secretsEnv: { enabled: true } } as any,
      pool: {
        acquire: () => "/tmp/pool",
        prepareForTask: vi.fn().mockResolvedValue({ branch: "fusion/fn-1", worktreePath: "/tmp/pool", reclaimed: false }),
        release: vi.fn(),
      } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fresh-fallback", branch: "fusion/fn-1" }),
      secretsStore: undefined,
    });
    expect(writeSecretsEnvFile).toHaveBeenCalledWith(expect.objectContaining({ worktreeSource: "pool", secretsStore: undefined }));
  });

  it("calls writer on fresh", async () => {
    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { secretsEnv: { enabled: true } } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fresh", branch: "fusion/fn-1" }),
      secretsStore: undefined,
    });
    expect(writeSecretsEnvFile).toHaveBeenCalledWith(expect.objectContaining({ worktreeSource: "fresh" }));
  });

  it("does not call writer for existing resume", async () => {
    const existingWorktree = process.cwd();
    const projectRoot = dirname(existingWorktree);

    await acquireTaskWorktree({
      task: { ...task, branch: "fusion/fn-1", worktree: existingWorktree },
      rootDir: projectRoot,
      store,
      settings: { secretsEnv: { enabled: true } } as any,
      createWorktree: vi.fn(),
    });
    expect(writeSecretsEnvFile).not.toHaveBeenCalled();
  });

  it("reconciles a pinned planning sidecar before its refresh-enabled execution handoff", async () => {
    const existingWorktree = process.cwd();
    const projectRoot = dirname(existingWorktree);
    reconcileSecretsEnvFingerprint.mockResolvedValueOnce({ executionSafe: true, outcome: "adopted-legacy" });

    await expect(acquireTaskWorktree({
      task: { ...task, branch: "fusion/fn-1", worktree: existingWorktree },
      rootDir: projectRoot,
      store,
      settings: { secretsEnv: { enabled: true } } as any,
      refreshStaleBase: true,
      createWorktree: vi.fn(),
    })).resolves.toMatchObject({ source: "existing", isResume: true });

    // FNXC:SecretsEnvMaterialization 2026-08-08-03:30: Execution handoff must reconcile the planning-era root record before strict refresh sees porcelain.
    expect(reconcileSecretsEnvFingerprint).toHaveBeenCalledWith(existingWorktree);
    expect(refreshReusedWorktreeBase).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: existingWorktree }));
    expect(reconcileSecretsEnvFingerprint.mock.invocationCallOrder[0]).toBeLessThan(refreshReusedWorktreeBase.mock.invocationCallOrder[0]);
  });

  it("fails closed with a redacted fixed audit outcome when reconciliation rejects", async () => {
    const existingWorktree = process.cwd();
    const projectRoot = dirname(existingWorktree);
    const git = vi.fn();
    reconcileSecretsEnvFingerprint.mockRejectedValueOnce(new Error("secret-derived resolver detail"));

    await expect(acquireTaskWorktree({
      task: { ...task, branch: "fusion/fn-1", worktree: existingWorktree },
      rootDir: projectRoot,
      store,
      settings: { secretsEnv: { enabled: true } } as any,
      refreshStaleBase: true,
      audit: { git },
      createWorktree: vi.fn(),
    })).rejects.toMatchObject({
      name: "WorktreeBaseRefreshError",
      refresh: { kind: "base-reconciliation-required", detail: "git-dir-unavailable" },
    });
    expect(refreshReusedWorktreeBase).not.toHaveBeenCalled();
    expect(git).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:base-refresh-blocked",
      target: "FN-1",
      metadata: { taskId: "FN-1", outcome: "base-reconciliation-required", reconciliationOutcome: "git-dir-unavailable" },
    }));
    expect(JSON.stringify(git.mock.calls)).not.toContain("secret-derived resolver detail");
    expect(JSON.stringify(git.mock.calls)).not.toContain(existingWorktree);
  });

  it("isolates writer failures", async () => {
    writeSecretsEnvFile.mockRejectedValueOnce(new Error("boom"));
    await expect(acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { secretsEnv: { enabled: true } } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fresh", branch: "fusion/fn-1" }),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })).resolves.toMatchObject({ source: "fresh" });
  });
});
