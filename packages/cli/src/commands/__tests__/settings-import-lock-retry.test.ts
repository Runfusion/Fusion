/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Regression coverage for FN-7740's `settings-import.ts` fix:
 * `runSettingsImport` must close its uncached `TaskStore` BEFORE every
 * `process.exit()` call (per project memory: a pending `finally` never
 * runs after `process.exit()`), and retry the `importSettings` board
 * mutation through a momentary `database is locked` instead of failing the
 * import outright. Uses a mocked `TaskStore`/`importSettings` (per FN-5048
 * — no real long waits / real SQLite I/O entangled with fake timers) with
 * `retryOnLock`'s real bounded-backoff implementation exercised end to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";

function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
  const mock = vi.fn(function () {});
  const originalMockImplementation = mock.mockImplementation.bind(mock);
  const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
    return nextImpl(...args);
  };
  mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
  if (impl) {
    mock.mockImplementation(impl);
  }
  return mock;
}

const { mockStoreInit, mockStoreClose, mockImportSettings } = vi.hoisted(() => ({
  mockStoreInit: vi.fn().mockResolvedValue(undefined),
  mockStoreClose: vi.fn().mockResolvedValue(undefined),
  mockImportSettings: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("@fusion/core", () => ({
  // FNXC:PostgresCutover 2026-07-10: PG startup factory consulted before legacy TaskStore; null keeps the legacy mock path.
  createTaskStoreForBackend: vi.fn(async () => ({
    taskStore: { init: mockStoreInit, close: mockStoreClose },
    shutdown: vi.fn(async () => mockStoreClose()),
  })),
  TaskStore: makeConstructibleMock(() => ({
    init: mockStoreInit,
    close: mockStoreClose,
  })),
  importSettings: mockImportSettings,
  readExportFile: vi.fn(),
  validateImportData: vi.fn(),
  isSqliteLockError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return /database is locked|SQLITE_BUSY/i.test(message);
  },
}));

vi.mock("../../project-context.js", () => ({
  // FNXC:PostgresCutover 2026-07-10: branch cwd-fallbacks boot via createLocalStore (PG startup factory); reuse the same mocked TaskStore shape.
  createLocalStore: vi.fn(async () => { const { TaskStore } = await import("@fusion/core"); const store = new (TaskStore as any)(process.cwd()); await store.init?.(); return store; }),
  resolveProjectPathOnly: vi.fn(async () => undefined),
  asLocalProjectContext: (store: unknown) => ({
    projectId: "cwd",
    projectPath: "cwd",
    projectName: "cwd",
    isRegistered: false,
    store,
  }),
  closeProjectStore: async (context: { store: { close: () => Promise<void> } }) => {
    await context.store.close().catch(() => {});
  },
}));

import { runSettingsImport } from "../settings-import.js";
import { readExportFile, validateImportData } from "@fusion/core";

describe("fn settings import — leak/lock reproduction (FN-7740)", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    if ((code ?? 0) === 0) return undefined as never;
    throw new Error(`process.exit:${code ?? 0}`);
  });
  const originalRetryMs = process.env.FUSION_CLI_LOCK_RETRY_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readExportFile).mockResolvedValue({
      version: 1,
      exportedAt: "2026-07-09T00:00:00.000Z",
      global: { ntfyEnabled: true },
      project: {},
    } as any);
    vi.mocked(validateImportData).mockReturnValue([]);
    mockImportSettings.mockResolvedValue({ success: true, globalCount: 1, projectCount: 0 });
  });

  afterEach(() => {
    if (originalRetryMs === undefined) {
      delete process.env.FUSION_CLI_LOCK_RETRY_MS;
    } else {
      process.env.FUSION_CLI_LOCK_RETRY_MS = originalRetryMs;
    }
    vi.clearAllMocks();
  });

  it("closes the uncached TaskStore on a successful import (process.exit(0))", async () => {
    await runSettingsImport("./settings.json", { yes: true });

    expect(mockStoreClose).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("  ✓ Settings imported successfully");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("closes the uncached TaskStore before process.exit(1) on a not-found file (no retry-looping)", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    await expect(runSettingsImport("./missing.json", { yes: true })).rejects.toThrow("process.exit:1");

    expect(mockStoreClose).toHaveBeenCalled();
    expect(mockImportSettings).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("File not found"));
  });

  it("retries importSettings through a transient database-is-locked error and succeeds once it clears", async () => {
    const lockError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    mockImportSettings
      .mockRejectedValueOnce(lockError)
      .mockRejectedValueOnce(lockError)
      .mockResolvedValueOnce({ success: true, globalCount: 1, projectCount: 0 });

    process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
    vi.useFakeTimers();
    try {
      const promise = runSettingsImport("./settings.json", { yes: true });
      for (let i = 0; i < 10 && mockImportSettings.mock.calls.length < 3; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await promise;
    } finally {
      vi.useRealTimers();
    }

    expect(mockImportSettings).toHaveBeenCalledTimes(3);
    expect(mockStoreClose).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("  ✓ Settings imported successfully");
  });

  it("fails fast with a clear non-zero-exit error (and closes the store) when the lock never clears within the bound", async () => {
    const lockError = Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });
    mockImportSettings.mockRejectedValue(lockError);

    process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
    vi.useFakeTimers();
    try {
      const promise = runSettingsImport("./settings.json", { yes: true });
      const assertion = expect(promise).rejects.toThrow("process.exit:1");
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    expect(mockStoreClose).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("board database stayed contended"));
  });

  it("propagates a non-lock importSettings failure immediately without retrying", async () => {
    mockImportSettings.mockResolvedValue({ success: false, globalCount: 0, projectCount: 0, error: "schema mismatch" });

    await expect(runSettingsImport("./settings.json", { yes: true })).rejects.toThrow("process.exit:1");

    expect(mockImportSettings).toHaveBeenCalledTimes(1);
    expect(mockStoreClose).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("Error: Import failed: schema mismatch");
  });
});
