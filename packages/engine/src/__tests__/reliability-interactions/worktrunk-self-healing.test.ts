import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { RunAuditEventInput, Settings, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

const { execSpy, execSyncSpy, resolveBackendSpy, scanIdleSpy, readdirSpy, existsSpy, inspectBranchConflictSpy } = vi.hoisted(() => ({
  execSpy: vi.fn(),
  execSyncSpy: vi.fn(),
  resolveBackendSpy: vi.fn(),
  scanIdleSpy: vi.fn(),
  readdirSpy: vi.fn(),
  existsSpy: vi.fn().mockReturnValue(false),
  inspectBranchConflictSpy: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: execSpy,
    execSync: execSyncSpy,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: readdirSpy,
    existsSync: existsSpy,
  };
});

vi.mock("../../worktree/worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../../worktree-pool.js");
  return {
    ...actual,
    resolveWorktreeBackend: resolveBackendSpy,
    scanIdleWorktrees: scanIdleSpy,
    isUsableTaskWorktree: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../../execution/branch-conflicts.js", async () => {
  const actual = await vi.importActual<any>("../../branch-conflicts.js");
  return {
    ...actual,
    inspectBranchConflict: inspectBranchConflictSpy,
  };
});

function makeStore(settings: Settings, events: RunAuditEventInput[] = []): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async ({ column }: any = {}) => {
      if (column === "todo") {
        return [{
          id: "FN-4628",
          title: "FN-4628",
          column: "todo",
          status: "branch-conflict-unrecoverable",
          paused: false,
          branch: "fusion/fn-4628",
          worktree: "/tmp/fn-4628",
          baseCommitSha: "base",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }];
      }
      return [];
    }),
    updateTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async (event: RunAuditEventInput) => {
      events.push(event);
    }),
  }) as unknown as TaskStore & EventEmitter;
}

function wireExecSuccess() {
  execSpy.mockImplementation((command: string, opts: unknown, callback: (...args: any[]) => void) => {
    const cb = typeof opts === "function" ? opts : callback;
    cb(null, "", "");
  });
}

describe("reliability interactions: worktrunk x self-healing", () => {
  beforeEach(() => {
    execSpy.mockReset();
    execSyncSpy.mockReset();
    resolveBackendSpy.mockReset();
    scanIdleSpy.mockReset();
    readdirSpy.mockReset();
    existsSpy.mockReset();
    existsSpy.mockReturnValue(false);
    inspectBranchConflictSpy.mockReset();
  });
  it("periodic maintenance delegates prune to worktrunk and skips native git prune", async () => {
    wireExecSuccess();
    const prune = vi.fn().mockResolvedValue(undefined);
    resolveBackendSpy.mockReturnValue({ kind: "worktrunk", prune });

    const store = makeStore({ maintenanceIntervalMs: 0, worktrunk: { enabled: true, onFailure: "fail" } } as Settings);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/project" });

    await (manager as any).runMaintenance();

    expect(prune).toHaveBeenCalledWith({ rootDir: "/tmp/project" });
    expect(execSpy).not.toHaveBeenCalledWith(expect.stringContaining("git worktree prune"), expect.anything(), expect.anything());
  });

  it.each([
    { onFailure: "fail", shouldFallback: false },
    { onFailure: "fallback-native", shouldFallback: true },
  ] as const)("records audit on worktrunk prune failure (%s)", async ({ onFailure, shouldFallback }) => {
    wireExecSuccess();
    const events: RunAuditEventInput[] = [];
    const prune = vi.fn().mockRejectedValue(new Error("boom"));
    resolveBackendSpy.mockReturnValue({ kind: "worktrunk", prune });

    const store = makeStore({ maintenanceIntervalMs: 0, worktrunk: { enabled: true, onFailure } } as Settings, events);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/project" });

    await (manager as any).pruneWorktrees();

    const failureEvent = events.find((event) => event.mutationType === "worktree:worktrunk-prune");
    expect(failureEvent).toBeDefined();
    expect((failureEvent?.metadata as Record<string, unknown>)?.success).toBe(false);

    const nativePruneCalled = execSpy.mock.calls.some((call) => String(call[0]).includes("git worktree prune"));
    expect(nativePruneCalled).toBe(shouldFallback);
  });

  it("enforceWorktreeCap short-circuits to backend prune with worktrunk enabled", async () => {
    wireExecSuccess();
    const prune = vi.fn().mockResolvedValue(undefined);
    resolveBackendSpy.mockReturnValue({ kind: "worktrunk", prune });
    scanIdleSpy.mockResolvedValue(["/tmp/project/.worktrees/idle"]);

    const store = makeStore({ maintenanceIntervalMs: 0, worktrunk: { enabled: true, onFailure: "fail" } } as Settings);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/project" });

    await (manager as any).enforceWorktreeCap();

    expect(prune).toHaveBeenCalledWith({ rootDir: "/tmp/project" });
    expect(scanIdleSpy).not.toHaveBeenCalled();
    expect(readdirSpy).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalledWith(expect.stringContaining("git worktree remove"), expect.anything(), expect.anything());
  });

  it("branch-conflict reclaim remains active and keeps git worktree prune plumbing", async () => {
    wireExecSuccess();
    resolveBackendSpy.mockReturnValue({ kind: "worktrunk", prune: vi.fn() });
    inspectBranchConflictSpy.mockResolvedValue({
      kind: "tip-already-merged",
      livePath: null,
      tipSha: "abc123456789",
      integrationRef: "main",
    });

    const store = makeStore({ maintenanceIntervalMs: 0, worktrunk: { enabled: true, onFailure: "fail" } } as Settings);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/project" });
    // FNXC:SelfHealingReclaim 2026-07-07-08:45:
    // FN-7486 (commit 138d6447f) hardened tip-already-merged reclaim so an
    // unverifiable commit tip short-circuits BEFORE native `git worktree prune`
    // (previously a null ownership fell through to the prune). Here `exec` is
    // mocked, so `promisify(exec)` loses Node's custom promisify symbol and
    // resolves to the raw stdout string, which makes `readCommitTaskOwnership`
    // throw on its `{ stdout }` destructure — ownership is unverifiable, so the
    // reclaim now skips the prune. This test's invariant is the prune PLUMBING
    // (branch-level reclaim stays native in worktrunk mode), not ownership
    // verification, so attribute the tip to this task and let the reclaim reach
    // the native prune (mirrors how inspectBranchConflict is stubbed above).
    const reclaimInternals = manager as unknown as {
      readCommitTaskOwnership: (sha: string, taskId: string, lineageId?: string) => Promise<unknown>;
    };
    vi.spyOn(reclaimInternals, "readCommitTaskOwnership").mockResolvedValue({
      owned: true,
      proof: "task-trailer",
      ownerTaskId: "FN-4628",
    });

    await manager.reclaimSelfOwnedBranchConflicts();

    expect(inspectBranchConflictSpy).toHaveBeenCalled();
    const nativePruneCalled = execSpy.mock.calls.some((call) => String(call[0]).includes("git worktree prune"));
    expect(nativePruneCalled).toBe(true);
  });

  it("cleanupOrphans defers in both recycleWorktrees branches when worktrunk is enabled", async () => {
    wireExecSuccess();
    const prune = vi.fn().mockResolvedValue(undefined);
    resolveBackendSpy.mockReturnValue({ kind: "worktrunk", prune });

    const settingsVariants = [
      { maintenanceIntervalMs: 0, recycleWorktrees: false, worktrunk: { enabled: true, onFailure: "fail" } },
      { maintenanceIntervalMs: 0, recycleWorktrees: true, worktrunk: { enabled: true, onFailure: "fail" } },
    ] as Settings[];

    for (const settings of settingsVariants) {
      const store = makeStore(settings);
      const manager = new SelfHealingManager(store, { rootDir: "/tmp/project" });
      await (manager as any).cleanupOrphans();
    }

    expect(prune).toHaveBeenCalledTimes(2);
    expect(scanIdleSpy).not.toHaveBeenCalled();
  });

  it("uses merged store settings for worktrunk-on vs off behavior", async () => {
    wireExecSuccess();
    const prune = vi.fn().mockResolvedValue(undefined);
    resolveBackendSpy.mockReturnValue({ kind: "worktrunk", prune });

    const worktrunkOnStore = makeStore({ maintenanceIntervalMs: 0, worktrunk: { enabled: true, onFailure: "fail" } } as Settings);
    const onManager = new SelfHealingManager(worktrunkOnStore, { rootDir: "/tmp/project" });
    await (onManager as any).pruneWorktrees();

    const worktrunkOffStore = makeStore({ maintenanceIntervalMs: 0, worktrunk: { enabled: false, onFailure: "fail" } } as Settings);
    const offManager = new SelfHealingManager(worktrunkOffStore, { rootDir: "/tmp/project" });
    await (offManager as any).pruneWorktrees();

    expect(prune).toHaveBeenCalledTimes(1);
    const nativePruneCalls = execSpy.mock.calls.filter((call) => String(call[0]).includes("git worktree prune"));
    expect(nativePruneCalls.length).toBeGreaterThanOrEqual(1);
  });
});
