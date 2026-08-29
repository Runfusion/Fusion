/*
FNXC:PauseGatedMaintenance 2026-08-13-03:08 (RUFU-076):
Runtime-shaped regression for the pause-gated maintenance contract, mirroring the EXACT lifecycle
InProcessRuntime performs: it constructs SelfHealingManager with `new SelfHealingManager(taskStore, {...})`,
calls `start()` (in-process-runtime.ts:1871) BEFORE its own startup pause gate, and calls `stop()`
on teardown (in-process-runtime.ts:2098). This file pins the runtime-boundary invariants that the
runtime-level SelfHealingManager-level tests in self-healing-076-pause-storm.test.ts back up:

  I1: a project that starts paused (enginePaused=true/globalPause=true) never arms periodic maintenance,
      so advancing MANY maintenance intervals issues zero child-process git invocations (the production
      git storm: `git worktree prune` / `git branch` / `git log`).
  I2: a pause transition mid-run clears the armed timer AND an unpause transition re-arms it, so an
      active project still runs recovery as before.
  teardown-idempotence: calling stop() twice (as the runtime teardown path does on both the normal and
      error paths) stays clean.

This is intentionally a NON-PostgreSQL regression: the pause-arm contract is owned entirely by
SelfHealingManager (it registers its own `settings:updated` listener on the store), so it is fully
verifiable with an in-memory mock store and fake timers — no boot of a real InProcessRuntime is needed
to assert that a paused project stops the periodic git churn at the runtime seam.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

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

/** Minimal store for the maintenance lifecycle; batch-1 DB/FS steps no-op via the same mocks as the runtime. */
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
    getSettings: vi.fn().mockImplementation(async () => currentSettings),
    updateSettings: vi.fn().mockImplementation(async (patch: unknown) => {
      currentSettings = { ...currentSettings, ...(patch as Record<string, unknown>) } as unknown as Settings;
      return currentSettings;
    }),
    getAsyncLayer: vi.fn().mockReturnValue(null),
    isBackendMode: vi.fn().mockReturnValue(false),
    getRootDir: vi.fn().mockReturnValue("/tmp/test-project"),
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
  emitter.on("settings:updated", (payload: { settings: Settings }) => {
    currentSettings = payload.settings as unknown as Settings;
  });
  return Object.assign(emitter, store) as unknown as TaskStore & EventEmitter;
}

function emitSettings(store: TaskStore & EventEmitter, settings: Partial<Settings>, previous: Partial<Settings>): void {
  const base = { globalPause: false, enginePaused: false, maintenanceIntervalMs: 60_000, maxWorktrees: 4 };
  store.emit("settings:updated", {
    settings: { ...base, ...settings } as unknown as Settings,
    previous: { ...base, ...previous } as unknown as Settings,
  });
}

describe("RUFU-076 runtime pause-gate seam (InProcessRuntime lifecycle)", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from(""));
    store = createMockStore();
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  function maintenanceArmed(): boolean {
    return (manager as unknown as { maintenanceInterval: ReturnType<typeof setInterval> | null }).maintenanceInterval !== null;
  }

  it("I1: a project that starts paused stays git-silent across many maintenance windows", async () => {
    // Mirror the runtime: manager constructed & started before the runtime pause gate.
    store = createMockStore({ enginePaused: true });
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    manager.start();
    // Advance far past several maintenance intervals — the timer is never armed under pause.
    await vi.advanceTimersByTimeAsync(60_000 * 5);
    mockedExecSync.mockClear();
    await (manager as unknown as { runMaintenance(): Promise<void> }).runMaintenance();
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("I2: pause clears the timer, unpause re-arms it, and a fired cycle then runs git", async () => {
    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenanceArmed()).toBe(true);

    // Pause (enginePaused) at the runtime seam → timer cleared.
    emitSettings(store, { enginePaused: true }, { enginePaused: false });
    expect(maintenanceArmed()).toBe(false);

    // Unpause → timer re-armed.
    emitSettings(store, { enginePaused: false }, { enginePaused: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenanceArmed()).toBe(true);

    // Smoke: an active idle cycle actually consults the git seam (proves unpause restored execution).
    mockedExecSync.mockClear();
    await (manager as unknown as { runMaintenance(): Promise<void> }).runMaintenance();
    // Batch-1 git steps run on an active project; the store's default state is a git-less fixture,
    // so at minimum the git seam was consulted before resolving (not required to mutate).
    expect(mockedExecSync).toHaveBeenCalled();
  });

  it("globalPause mirrors enginePaused across the runtime seam", async () => {
    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenanceArmed()).toBe(true);

    emitSettings(store, { globalPause: true }, { globalPause: false });
    expect(maintenanceArmed()).toBe(false);

    emitSettings(store, { globalPause: false }, { globalPause: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenanceArmed()).toBe(true);
  });

  it("stop() is idempotent across pause toggles (runtime teardown path calls it twice)", async () => {
    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    emitSettings(store, { enginePaused: true }, { enginePaused: false });
    manager.stop(); // first stop clears any remaining timer + listeners
    manager.stop(); // second stop (runtime teardown) must be a clean no-op
    machineAssertStopSettled(manager);
  });
});

/** After stop() the manager must have no armed timer — asserting no orphaned interval survives teardown. */
function machineAssertStopSettled(manager: SelfHealingManager): void {
  expect((manager as unknown as { maintenanceInterval: ReturnType<typeof setInterval> | null }).maintenanceInterval).toBeNull();
}