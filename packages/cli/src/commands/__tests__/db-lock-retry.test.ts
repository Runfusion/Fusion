/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Regression coverage for FN-7739 — `fn db vacuum` must retry the VACUUM
 * call through a momentarily-locked SQLite board database (VACUUM requires
 * an exclusive lock — the canonical transient-lock case) instead of
 * surfacing a raw `database is locked` error, and must close the resolved
 * `TaskStore` (cached AND the uncached CWD-fallback branch) BEFORE every
 * `process.exit()` call (both success and failure paths), since a pending
 * `finally` does not run after `process.exit()`. Fast, fake-timer based, no
 * real waits per FN-5048.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@fusion/core", async (importActual) => {
  const actual = await importActual<typeof import("@fusion/core")>();
  return { ...actual };
});

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    getDatabase: vi.fn(),
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
  vi.doMock("../../project-context.js", () => ({ resolveProject, closeProjectStore, asLocalProjectContext }));
  const mod = await import("../db.js");
  return { mod, closeProjectStore, resolveProject };
}

describe("fn db vacuum — lock retry and close-before-exit teardown (FN-7739)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../project-context.js");
    vi.restoreAllMocks();
    delete process.env.FUSION_CLI_LOCK_RETRY_MS;
  });

  it("succeeds on first attempt (no lock contention) and closes the store before exit(0)", async () => {
    const vacuum = vi.fn().mockReturnValue({ beforeSize: 100, afterSize: 50, durationMs: 5 });
    const getDatabase = vi.fn(() => ({ vacuum, getPath: () => "/proj/.fusion/fusion.db" }));
    const store = makeStore({ getDatabase });
    const { mod, closeProjectStore } = await loadWithMockedStore(store);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(mod.runDbVacuum()).rejects.toThrow(/process\.exit\(0\)/);

    expect(vacuum).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("uncached CWD-fallback: resolves via asLocalProjectContext and still closes the store before exit", async () => {
    const vacuum = vi.fn().mockReturnValue({ beforeSize: 0, afterSize: 0, durationMs: 0 });
    const getDatabase = vi.fn(() => ({ vacuum, getPath: () => "/fallback/.fusion/fusion.db" }));
    const store = makeStore({ getDatabase });
    const { mod, closeProjectStore } = await loadWithMockedStore(store, { cached: false });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(mod.runDbVacuum()).rejects.toThrow(/process\.exit\(0\)/);

    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("retries VACUUM through a transient lock error and succeeds once it clears, closing the store before exit(0)", async () => {
    vi.useFakeTimers();
    try {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
      const lockError = new Error("database is locked");
      const vacuum = vi.fn().mockImplementationOnce(() => {
        throw lockError;
      }).mockReturnValue({ beforeSize: 10, afterSize: 5, durationMs: 1 });
      const getDatabase = vi.fn(() => ({ vacuum, getPath: () => "/proj/.fusion/fusion.db" }));
      const store = makeStore({ getDatabase });
      const { mod, closeProjectStore } = await loadWithMockedStore(store);
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const promise = mod.runDbVacuum();
      const assertion = expect(promise).rejects.toThrow(/process\.exit\(0\)/);
      for (let i = 0; i < 10 && vacuum.mock.calls.length < 2; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await assertion;

      expect(vacuum.mock.calls.length).toBeGreaterThan(1);
      expect(closeProjectStore).toHaveBeenCalled();
      exitSpy.mockRestore();
      logSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounded exhaustion on a persistently locked VACUUM fails clearly, closes the store, and exits 1", async () => {
    vi.useFakeTimers();
    try {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
      const vacuum = vi.fn().mockImplementation(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      });
      const getDatabase = vi.fn(() => ({ vacuum, getPath: () => "/proj/.fusion/fusion.db" }));
      const store = makeStore({ getDatabase });
      const { mod, closeProjectStore } = await loadWithMockedStore(store);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const promise = mod.runDbVacuum();
      const assertion = expect(promise).rejects.toThrow(/process\.exit\(1\)/);
      for (let i = 0; i < 10 && vacuum.mock.calls.length < 2; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      expect(vacuum.mock.calls.length).toBeGreaterThan(1);
      const printed = errorSpy.mock.calls.flat().join("\n");
      expect(printed).toMatch(/locked|FUSION_CLI_LOCK_RETRY_MS/i);
      expect(closeProjectStore).toHaveBeenCalled();

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a non-lock VACUUM error does not retry-loop and closes the store before exit(1)", async () => {
    const vacuum = vi.fn().mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    const getDatabase = vi.fn(() => ({ vacuum, getPath: () => "/proj/.fusion/fusion.db" }));
    const store = makeStore({ getDatabase });
    const { mod, closeProjectStore } = await loadWithMockedStore(store);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(mod.runDbVacuum()).rejects.toThrow(/process\.exit\(1\)/);

    expect(vacuum).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("disk I/O error");
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
