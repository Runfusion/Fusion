/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Regression coverage for FN-7739 — `fn backup *` must retry the discrete
 * `getSettings()` board read through a momentarily-locked SQLite board
 * database instead of surfacing a raw `database is locked` error, and must
 * always close the resolved `TaskStore` (cached AND the uncached
 * CWD-fallback branch) so the CLI process exits promptly. Mirrors the
 * FN-7731/FN-7738 `*-lock-retry.test.ts` pattern: mocked-store lock
 * exhaustion/not-found/teardown coverage (fast, fake-timer based, no real
 * waits per FN-5048).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@fusion/core", async (importActual) => {
  const actual = await importActual<typeof import("@fusion/core")>();
  return {
    ...actual,
    // FNXC:PostgresCutover 2026-07-10: PG startup factory consulted before legacy TaskStore; null keeps the legacy mock path.
    createTaskStoreForBackend: vi.fn(async () => null),
    createBackupManager: vi.fn(),
    runBackupCommand: vi.fn(async () => ({ success: true, output: "backup created" })),
  };
});

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    getSettings: vi.fn(async () => ({ autoBackupDir: ".fusion/backups" })),
    fusionDir: "/proj/.fusion",
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function loadWithMockedStore(store: Record<string, unknown>, opts?: { cached?: boolean }) {
  const cached = opts?.cached ?? true;
  const closeProjectStore = vi.fn(async (context: { store: { close?: () => Promise<void> } }) => {
    await context.store.close?.().catch(() => {});
  });
  const context = {
    projectId: cached ? "proj_test" : process.cwd(),
    projectPath: cached ? "/proj" : process.cwd(),
    projectName: "proj",
    isRegistered: cached,
    store,
  };
  const resolveProject = cached
    ? vi.fn().mockResolvedValue(context)
    : vi.fn().mockRejectedValue(new Error("no registered project"));
  const asLocalProjectContext = vi.fn(() => context);
  vi.doMock("../../project-context.js", () => ({ resolveProject, closeProjectStore, asLocalProjectContext, createLocalStore: vi.fn(async () => store as never) }));
  const mod = await import("../backup.js");
  const { createBackupManager } = await import("@fusion/core");
  return { mod, closeProjectStore, resolveProject, createBackupManager };
}

describe("fn backup * — lock retry, leak/close, and not-found teardown (FN-7739)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../project-context.js");
    vi.restoreAllMocks();
    delete process.env.FUSION_CLI_LOCK_RETRY_MS;
  });

  it("runBackupList: succeeds on first attempt (no lock contention) and closes the store once", async () => {
    const store = makeStore();
    const { mod, closeProjectStore, createBackupManager } = await loadWithMockedStore(store);
    (createBackupManager as ReturnType<typeof vi.fn>).mockReturnValue({ listBackupPairs: vi.fn(async () => []) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mod.runBackupList();

    expect(store.getSettings).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("runBackupList (uncached CWD-fallback): resolves via asLocalProjectContext and still closes the store", async () => {
    const store = makeStore();
    const { mod, closeProjectStore, createBackupManager } = await loadWithMockedStore(store, { cached: false });
    (createBackupManager as ReturnType<typeof vi.fn>).mockReturnValue({ listBackupPairs: vi.fn(async () => []) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mod.runBackupList();

    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("runBackupList: retries through a transient lock error on getSettings and succeeds once it clears, then closes the store", async () => {
    vi.useFakeTimers();
    try {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
      const lockError = new Error("database is locked");
      const getSettings = vi.fn().mockImplementationOnce(() => {
        throw lockError;
      }).mockImplementation(async () => ({ autoBackupDir: ".fusion/backups" }));
      const store = makeStore({ getSettings });
      const { mod, closeProjectStore, createBackupManager } = await loadWithMockedStore(store);
      (createBackupManager as ReturnType<typeof vi.fn>).mockReturnValue({ listBackupPairs: vi.fn(async () => []) });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const promise = mod.runBackupList();
      for (let i = 0; i < 10 && getSettings.mock.calls.length < 2; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await promise;

      expect(getSettings.mock.calls.length).toBeGreaterThan(1);
      expect(closeProjectStore).toHaveBeenCalled();
      logSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runBackupCleanup: bounded exhaustion on a persistently locked getSettings fails clearly and closes the store", async () => {
    vi.useFakeTimers();
    try {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
      const getSettings = vi.fn().mockImplementation(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      });
      const store = makeStore({ getSettings });
      const { mod, closeProjectStore } = await loadWithMockedStore(store);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const promise = mod.runBackupCleanup();
      const assertion = expect(promise).rejects.toThrow(/process\.exit\(1\)/);
      for (let i = 0; i < 10 && getSettings.mock.calls.length < 2; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      expect(getSettings.mock.calls.length).toBeGreaterThan(1);
      const printed = errorSpy.mock.calls.flat().join("\n");
      expect(printed).toMatch(/locked|FUSION_CLI_LOCK_RETRY_MS/i);
      expect(closeProjectStore).toHaveBeenCalled();

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runBackupRestore: a restore failure closes the store before exiting non-zero", async () => {
    const store = makeStore();
    const { mod, closeProjectStore, createBackupManager } = await loadWithMockedStore(store);
    (createBackupManager as ReturnType<typeof vi.fn>).mockReturnValue({
      restoreBackup: vi.fn().mockRejectedValue(new Error("bad backup file")),
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(mod.runBackupRestore("missing.db")).rejects.toThrow(/process\.exit\(1\)/);

    expect(closeProjectStore).toHaveBeenCalled();

    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("runBackupCreate: closes the store before process.exit on both success and failure", async () => {
    const store = makeStore();
    const { mod, closeProjectStore } = await loadWithMockedStore(store);
    const { runBackupCommand } = await import("@fusion/core");
    (runBackupCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, output: "ok" });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(mod.runBackupCreate()).rejects.toThrow(/process\.exit\(0\)/);
    expect(closeProjectStore).toHaveBeenCalled();

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("runBackupCreate: a non-lock exception from runBackupCommand itself still closes the store (FN-7739 review fix)", async () => {
    const store = makeStore();
    const { mod, closeProjectStore } = await loadWithMockedStore(store);
    const { runBackupCommand } = await import("@fusion/core");
    (runBackupCommand as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("disk full"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(mod.runBackupCreate()).rejects.toThrow(/disk full/);
    expect(closeProjectStore).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });
});
