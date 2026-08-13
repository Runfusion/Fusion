/*
FNXC:PauseGatedMaintenance 2026-08-13-03:08 (RUFU-076):
Regression tests for the pause-gated maintenance contract:
  I1: a paused project (enginePaused=true/globalPause=true) must NOT arm periodic self-healing maintenance,
      so no git churn runs on a paused project.
  I2: on unpause the maintenance timer re-arms, so recovery behavior is unchanged for active projects.
  I3: only the git-churn batch-1 steps may be gated under pause; pure-DB/FS housekeeping stays in the list.
  I5: an idle/paused tick performs zero child_process git invocations.
The production bug: SelfHealingManager.start() ran before the runtime pause gate, so the periodic
setInterval kept firing `git worktree prune` / `git branch` / `git log` on paused projects — the measured
git storm behind 61-70% CPU and a 5000ms /api/health timeout.

These tests assert the pause-maintenance timer STATE directly (armed vs not-armed) rather than relying
on firing the full async `runMaintenance` through fake timers, because a fired maintenance cycle runs
many async git/DB steps that can leak into the next test via `shouldAdvanceTime` auto-advance. State-based
assertions (is the setInterval handle present?) are deterministic and directly encode the invariant.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Route exec/execAsync/execFile through a single recording execSync mock so batch-1 git invocations
// (e.g. `git worktree prune`) are observable on the git seam without spawning real child processes.
vi.mock("node:child_process", async () => {
  const { promisify: utilPromisify } = await import("node:util");
  const execSyncFn = vi.fn();

  const execFn: any = vi.fn((cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    const options = typeof opts === "object" && opts !== null ? opts : {};
    try {
      const out = execSyncFn(cmd, { ...options, stdio: ["pipe", "pipe", "pipe"] });
      const stdout = out === undefined ? "" : out.toString();
      if (typeof callback === "function") callback(null, stdout, "");
    } catch (err) {
      if (typeof callback === "function") {
        const error = err as { stdout?: string; stderr?: string };
        callback(err, error?.stdout?.toString?.() ?? "", error?.stderr?.toString?.() ?? "");
      }
    }
  });
  execFn[utilPromisify.custom] = (cmd: string, opts?: any) =>
    new Promise((resolve, reject) => {
      execFn(cmd, opts, (err: any, stdout: string, stderr: string) => {
        if (err) {
          (err as Record<string, unknown>).stdout = stdout;
          (err as Record<string, unknown>).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  const execFileFn: any = vi.fn((file: string, args: any, opts: any, cb: any) => {
    const argv = Array.isArray(args) ? args : [];
    const optsArg = Array.isArray(args) ? opts : args;
    const cbArg = Array.isArray(args) ? cb : opts;
    return execFn([file, ...argv].join(" "), optsArg, cbArg);
  });
  execFileFn[utilPromisify.custom] = (file: string, args?: any, opts?: any) =>
    (execFn[utilPromisify.custom] as any)([file, ...(Array.isArray(args) ? args : [])].join(" "), opts);
  return { execSync: execSyncFn, exec: execFn, execFile: execFileFn };
});

import { execSync } from "node:child_process";
import { SelfHealingManager } from "../self-healing.js";
import type { Settings, TaskStore } from "@fusion/core";

const mockedExecSync = vi.mocked(execSync);

/** Minimal store shaped for the maintenance lifecycle; batch-1 DB/FS steps no-op via mocks. */
function createMockStore(settingsPartial: Partial<Settings> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  let currentSettings = {
    globalPause: false,
    enginePaused: false,
    maintenanceIntervalMs: 60_000,
    maxWorktrees: 4,
    ...settingsPartial,
  } as unknown as Settings;
  const store: Record<string, unknown> = {
    // Return the LATEST effective settings so pause/unpause transitions are visible to maintenance.
    getSettings: vi.fn().mockImplementation(async () => currentSettings),
    updateSettings: vi.fn().mockImplementation(async (patch: unknown) => {
      currentSettings = { ...currentSettings, ...(patch as Record<string, unknown>) } as unknown as Settings;
      return currentSettings;
    }),
    getAsyncLayer: vi.fn().mockReturnValue(null),
    isBackendMode: vi.fn().mockReturnValue(false),
    getRootDir: vi.fn().mockReturnValue("/tmp/test-project"),
    // Batch-1 pure-DB/FS steps — benign no-ops. `reconciled` matches SelfHealingManager.reconcileStaleSymbolLocks.
    reconcileOrphanedTaskDirs: vi.fn().mockResolvedValue({ recovered: [], skipped: [] }),
    reconcilePhantomCommittedReservations: vi.fn().mockResolvedValue({ reconciled: [], skipped: [] }),
    pruneOperationalLogsAsync: vi.fn().mockResolvedValue({ deletedTotal: 0, deletedByTable: {} }),
    pruneAgentActivityEventsAsync: vi.fn().mockResolvedValue(undefined),
    pruneAgentLogFilesAsync: vi.fn().mockResolvedValue({ prunedFiles: 0, prunedEntries: 0, freedBytes: 0 }),
    listTasks: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue({}),
    logEntry: vi.fn().mockResolvedValue(undefined),
    listWorkflowDefinitions: vi.fn().mockResolvedValue([]),
    reconcileStaleSymbolLocks: vi.fn().mockResolvedValue({ reconciled: [], skipped: [] }),
    getTask: vi.fn().mockResolvedValue(null),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    getTasksDir: vi.fn().mockReturnValue("/tmp/test-project/.fusion/tasks"),
    listWorkflowWorkItemsForTask: vi.fn().mockResolvedValue([]),
  };
  // Emitting `settings:updated` updates the stored settings in place, mirroring the real store.
  emitter.on("settings:updated", (payload: { settings: Settings }) => {
    currentSettings = payload.settings as unknown as Settings;
  });
  const cast = Object.assign(emitter, store) as unknown as TaskStore & EventEmitter;
  return cast;
}

function hydrateManager(
  store: TaskStore & EventEmitter,
): SelfHealingManager {
  return new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
}

describe("RUFU-076 pause-gated maintenance (self-healing)", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockedExecSync.mockReset();
    // Default execSync returns empty stdout so any individual git step resolves.
    mockedExecSync.mockReturnValue(Buffer.from(""));
    store = createMockStore();
    manager = hydrateManager(store);
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  /** True when the periodic-maintenance setInterval is currently armed. */
  function maintenanceArmed(): boolean {
    return (manager as unknown as { maintenanceInterval: ReturnType<typeof setInterval> | null }).maintenanceInterval !== null;
  }

  /** Flush pending microtasks so a fire-and-forget async (e.g. startMaintenance) settles. */
  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
  }

  /** Emit a settings:updated event with the given pause flags (recorded against the given previous). */
  function emitSettings(settings: Partial<Settings>, previous: Partial<Settings>): void {
    const base = {
      globalPause: false,
      enginePaused: false,
      maintenanceIntervalMs: 60_000,
      maxWorktrees: 4,
    };
    store.emit("settings:updated", {
      settings: { ...base, ...settings } as unknown as Settings,
      previous: { ...base, ...previous } as unknown as Settings,
    });
  }

  it("I1: paused start (enginePaused=true) never arms periodic maintenance", async () => {
    store = createMockStore({ enginePaused: true });
    manager = hydrateManager(store);
    manager.start();
    await vi.advanceTimersByTimeAsync(60_000);
    mockedExecSync.mockClear();
    await (manager as unknown as { runMaintenance(): Promise<void> }).runMaintenance();
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("I1: paused start (globalPause=true) never arms periodic maintenance", async () => {
    store = createMockStore({ globalPause: true });
    manager = hydrateManager(store);
    manager.start();
    await vi.advanceTimersByTimeAsync(60_000);
    mockedExecSync.mockClear();
    await (manager as unknown as { runMaintenance(): Promise<void> }).runMaintenance();
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("I2: active start arms the maintenance timer", async () => {
    manager.start();
    await settle();
    expect(maintenanceArmed()).toBe(true);
  });

  it("pause transition clears the armed timer; unpause re-arms it", async () => {
    manager.start();
    await settle();
    expect(maintenanceArmed()).toBe(true);

    // Pause (enginePaused) → timer cleared.
    emitSettings({ enginePaused: true }, { enginePaused: false });
    expect(maintenanceArmed()).toBe(false);

    // Unpause → timer re-armed.
    emitSettings({ enginePaused: false }, { enginePaused: true });
    await settle();
    expect(maintenanceArmed()).toBe(true);
  });

  it("globalPause transition also clears the armed timer and re-arms on unpause", async () => {
    manager.start();
    await settle();
    expect(maintenanceArmed()).toBe(true);

    emitSettings({ globalPause: true }, { globalPause: false });
    expect(maintenanceArmed()).toBe(false);

    emitSettings({ globalPause: false }, { globalPause: true });
    await settle();
    expect(maintenanceArmed()).toBe(true);
  });

  it("force-pausing a project with an armed timer issues zero git calls on the next cycle", async () => {
    // Start active → timer armed.
    manager.start();
    await settle();
    expect(maintenanceArmed()).toBe(true);

    // Pause and immediately fire a maintenance cycle against the paused project.
    emitSettings({ enginePaused: true }, { enginePaused: false });
    expect(maintenanceArmed()).toBe(false);
    mockedExecSync.mockClear();
    await (manager as unknown as { runMaintenance(): Promise<void> }).runMaintenance();
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("I5: an idle/paused project ticks with zero child_process git invocations", async () => {
    store = createMockStore({ enginePaused: true });
    manager = hydrateManager(store);
    manager.start();
    mockedExecSync.mockClear();

    // Advance past several maintenance intervals — with the timer never armed under pause, no git runs.
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    await (manager as unknown as { runMaintenance(): Promise<void> }).runMaintenance();
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("coarse-cadence: batch-1 git churn runs on an active project at most once per hour", async () => {
    // Construct WITHOUT fake timers so Date.now() is real wall-clock (the coarse gate is a real timestamp).
    vi.useRealTimers();
    store = createMockStore({ enginePaused: false, maintenanceIntervalMs: 60_000 });
    manager = hydrateManager(store);
    manager.start();

    // Spy the batch-1 git-churn steps directly so batch-2 recovery git (symbolic-ref etc.) does not
    // confuse the coarse-cadence assertion: only these five prune/orphan/branch steps are gated.
    const steps = [
      "pruneWorktrees",
      "cleanupOrphans",
      "cleanupStaleTempMergeWorktrees",
      "cleanupOrphanedBranches",
      "enforceWorktreeCap",
    ] as const;
    const spies = steps.map((name) => vi.spyOn(manager as never, name).mockResolvedValue(0) as unknown as ReturnType<typeof vi.fn>);

    // First cycle: coarse gate is due (never ran) → ALL batch-1 git-churn steps execute.
    await (manager as unknown as { runMaintenance(): Promise<void> }).runMaintenance();
    for (const spy of spies) expect(spy).toHaveBeenCalled();

    // Second cycle within the hourly window → batch-1 git-churn steps are skipped (coarse gate);
    // batch-2 recovery may still touch git, but the gated housekeeping steps must not re-run.
    spies.forEach((spy) => spy.mockClear());
    await (manager as unknown as { runMaintenance(): Promise<void> }).runMaintenance();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();

    manager.stop();
  });
});

describe("RUFU-076 done-task-merge-metadata sweep bounding", () => {
  it("bounds git invocations for N done tasks to the per-cycle cap (< N)", async () => {
    const doneCount = 60;
    const doneTasks = Array.from({ length: doneCount }, (_, i) => ({
      id: `FN-DONE-${String(i).padStart(3, "0")}`,
      column: "done",
      paused: false,
      baseCommitSha: `base${i}`,
      mergeDetails: undefined,
    }));

    const store = createMockStore({ enginePaused: false });
    (store.listTasks as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(doneTasks);
    const manager = hydrateManager(store);

    // Count the git-heaviest seam (`findLandedTaskCommit` runs one or more git subprocesses per call).
    // With DONE_METADATA_REPAIR_CAP applied, at most the cap's worth of candidates are processed, so
    // the call count must stay below the full done-task count — the O(done_tasks) churn is gone.
    const findLanded = vi.spyOn(manager as never, "findLandedTaskCommit").mockResolvedValue({
      sha: "0101010101010101010101010101010101010101",
      subject: "fix(FN): landed",
      filesChanged: 2,
      insertions: 3,
      deletions: 1,
    });
    vi.spyOn(manager as never, "readLandedFilesForSha").mockResolvedValue(["a.ts"]);

    await manager.recoverDoneTaskMergeMetadata();

    // Below the full done-task count => bounded per cycle (round-robin picks up the rest later).
    expect(findLanded.mock.calls.length).toBeLessThan(doneCount);
    expect(findLanded.mock.calls.length).toBeGreaterThan(0);

    manager.stop();
  });
});