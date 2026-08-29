/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Regression coverage for FN-7731 — `fn task show`/`fn task move` must
 * retry through a momentarily-locked SQLite board database instead of
 * surfacing a raw `database is locked` error or hanging, and must always
 * close the resolved `TaskStore` so the CLI process exits promptly.
 *
 * Unit-level and CLI-boundary mocked-store coverage use fake timers to prove
 * the bounded-backoff/fast-fail/non-lock-passthrough contract without a
 * database-specific writer lock.
 *
 * FNXC:CliTests 2026-07-16-07:49:
 * FN-8081 removes the obsolete spawned `DatabaseSync` writer-lock helper.
 * PostgreSQL has no portable whole-database writer lock; the retained fake-timer
 * and mocked-store tests cover retry, error, and close-on-every-exit behavior.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { retryOnLock, LockRetryExhaustedError, DEFAULT_CLI_LOCK_RETRY_MS } from "../../lock-retry.js";

describe("retryOnLock", () => {
  it("retries PostgreSQL serialization failures", async () => {
    vi.useFakeTimers();
    try {
      const op = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("could not serialize access"), { code: "40001" }))
        .mockResolvedValue("ok");
      const pending = retryOnLock(op, { id: "FN-PG", action: "move task" }, 1_000);
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBe("ok");
      expect(op).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("returns immediately on first-try success (no added latency)", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const result = await retryOnLock(op, { id: "FN-1", action: "read task" });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries through a transient lock error and succeeds once it clears", async () => {
    vi.useFakeTimers();
    try {
      const lockError = new Error("database is locked");
      const op = vi
        .fn()
        .mockRejectedValueOnce(lockError)
        .mockRejectedValueOnce(lockError)
        .mockResolvedValueOnce("recovered");

      const promise = retryOnLock(op, { id: "FN-2", action: "move task" }, 5_000);
      // Drain backoff timers as they're scheduled without a fixed count,
      // since exact intervals are an implementation detail.
      for (let i = 0; i < 10 && op.mock.calls.length < 3; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }

      const result = await promise;
      expect(result).toBe("recovered");
      expect(op).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails fast with an actionable error when the lock never clears within the bound", async () => {
    vi.useFakeTimers();
    try {
      const lockError = new Error("SQLITE_BUSY: database is locked");
      const op = vi.fn().mockRejectedValue(lockError);

      const promise = retryOnLock(op, { id: "FN-3", action: "move task" }, 1_000);
      const assertion = expect(promise).rejects.toBeInstanceOf(LockRetryExhaustedError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;

      await expect(promise).rejects.toThrow(/FN-3/);
      await expect(promise).rejects.toThrow(/move task/);
      await expect(promise).rejects.toThrow(/FUSION_CLI_LOCK_RETRY_MS/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a non-lock error immediately without retrying", async () => {
    const notFound = new Error("Task FN-4 not found");
    const op = vi.fn().mockRejectedValue(notFound);

    await expect(retryOnLock(op, { id: "FN-4", action: "read task" }, 10_000)).rejects.toThrow(
      "Task FN-4 not found",
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("uses the default deadline when no override is supplied", () => {
    expect(DEFAULT_CLI_LOCK_RETRY_MS).toBeGreaterThan(0);
  });
});

/*
 * FNXC:PostgresCutover 2026-07-10:
 * Upstream's "real locked-store reproduction" describe held a REAL write lock
 * on a sqlite fusion.db file to reproduce `database is locked` (FN-7731). The
 * sqlite runtime is removed on this branch and PostgreSQL has no equivalent
 * whole-database writer lock, so the real-file reproduction is not portable.
 * The CLI-layer retry/teardown contract stays covered by the mocked-store
 * describes below (lock exhaustion, not-found, close-on-every-exit-path).
 *
 * FNXC:CliTests 2026-07-24-08:25:
 * Full Suite shard 4 timed out the first runTaskShow exhaustion case at the
 * default 5s budget (run 30096660913): each test re-imported task.js under
 * fake timers, and the cold engine/dashboard graph transform alone consumed
 * most of that budget on contended CI workers, leaving unhandled
 * store.getTask / process.exit races after the timeout. Load task.js once
 * per describe under real timers via a mutable store holder, and enable fake
 * timers only around the retry/backoff body — never around the import.
 */
describe("runTaskShow / runTaskMove — mocked-store lock exhaustion, not-found, and teardown (FN-7731)", () => {
  let mod: typeof import("../task.js");
  let closeProjectStore: ReturnType<typeof vi.fn>;
  /** Mutable store surface returned by the mocked project-context helpers. */
  let storeHolder: Record<string, unknown>;

  beforeAll(async () => {
    // FNXC:CliBoardMutation 2026-07-19-18:20: mcp-lock-retry installs a
    // per-test @fusion/core factory. Clear it before importing task.js so
    // concurrent CLI test files cannot supply its secrets-store double here.
    vi.doUnmock("@fusion/core");
    vi.resetModules();
    storeHolder = {};
    closeProjectStore = vi.fn(async (context: { store: { close?: () => Promise<void> } }) => {
      await context.store.close?.().catch(() => {});
    });
    const resolveProject = vi.fn(async () => ({
      projectId: "proj_test",
      projectPath: "/proj",
      projectName: "proj",
      isRegistered: true,
      store: storeHolder,
    }));
    vi.doMock("../../project-context.js", () => ({
      resolveProject,
      closeProjectStore,
      createLocalStore: vi.fn(async () => storeHolder as never),
    }));
    // Real timers only: the task.js graph pulls engine + dashboard and must
    // not share the fake-timer clock used for lock backoff below.
    mod = await import("../task.js");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.FUSION_CLI_LOCK_RETRY_MS;
    for (const key of Object.keys(storeHolder)) {
      delete storeHolder[key];
    }
    closeProjectStore.mockClear();
  });

  afterAll(() => {
    vi.doUnmock("../../project-context.js");
    vi.doUnmock("@fusion/core");
    vi.resetModules();
  });

  function assignStore(methods: Record<string, unknown>) {
    for (const [key, value] of Object.entries(methods)) {
      storeHolder[key] = value;
    }
    if (typeof storeHolder.close !== "function") {
      storeHolder.close = vi.fn().mockResolvedValue(undefined);
    }
  }

  it("runTaskShow: bounded exhaustion across many fast lock retries fails clearly and closes the store", async () => {
    process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
    const getTask = vi.fn().mockRejectedValue(new Error("database is locked"));
    assignStore({ getTask });

    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const promise = mod.runTaskShow("FN-9");
    const assertion = expect(promise).rejects.toThrow(/process\.exit\(1\)/);
    for (let i = 0; i < 10 && getTask.mock.calls.length < 2; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    expect(getTask.mock.calls.length).toBeGreaterThan(1);
    const printed = errorSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("FN-9");
    expect(printed).toMatch(/locked|FUSION_CLI_LOCK_RETRY_MS/i);
    expect(closeProjectStore).toHaveBeenCalled();

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("runTaskMove: bounded exhaustion across many fast lock retries fails clearly and closes the store", async () => {
    process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
    const moveTask = vi.fn().mockRejectedValue(new Error("SQLITE_BUSY: database is locked"));
    assignStore({ moveTask });

    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const promise = mod.runTaskMove("FN-10", "done");
    const assertion = expect(promise).rejects.toThrow(/process\.exit\(1\)/);
    for (let i = 0; i < 10 && moveTask.mock.calls.length < 2; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    expect(moveTask.mock.calls.length).toBeGreaterThan(1);
    const printed = errorSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("FN-10");
    expect(printed).toMatch(/locked|FUSION_CLI_LOCK_RETRY_MS/i);
    expect(closeProjectStore).toHaveBeenCalled();

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("runTaskShow: a not-found error does not retry-loop and propagates clearly, store still closed", async () => {
    process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
    const getTask = vi.fn().mockRejectedValue(new Error("Task FN-404 not found"));
    assignStore({ getTask });

    await expect(mod.runTaskShow("FN-404")).rejects.toThrow("Task FN-404 not found");
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalled();
  });

  it("runTaskMove: a move-to-same-column no-op succeeds on the first attempt and closes the store", async () => {
    const moveTask = vi.fn().mockResolvedValue({ id: "FN-5", column: "todo" });
    assignStore({ moveTask });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mod.runTaskMove("FN-5", "todo");

    expect(moveTask).toHaveBeenCalledTimes(1);
    /*
    FNXC:ToolPermissionGates 2026-07-30-14:05:
    A CLI move IS a user action, so it now carries `moveSource: "user"` — the store's move pipeline
    applies user-move semantics (and the dashboard move route already did this). Asserting the bare
    two-arg call pinned the pre-hardening shape.
    */
    expect(moveTask).toHaveBeenCalledWith("FN-5", "todo", { moveSource: "user" });
    expect(closeProjectStore).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("runTaskShow: the happy path (no lock contention) adds no retry latency and closes the store once", async () => {
    const getTask = vi.fn().mockResolvedValue({
      id: "FN-6",
      description: "d",
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assignStore({ getTask });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mod.runTaskShow("FN-6");

    expect(getTask).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });
});

// ── FN-7734: generalized coverage across the remaining `fn task` subcommands ──
//
// FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734):
// Extends the FN-7731 pattern proven above for `runTaskShow`/`runTaskMove` to
// representative commands from each Step-1-audit class: `runTaskUpdate`
// (single-call board-mutation via `withBoardWrite`), `runTaskComments`
// (single-call board-read via `withBoardWrite`), and `runTaskDelete`
// (MULTI-STEP mutation via `resolveBoardContext`/`retryBoardCall` — existence
// check, interactive confirm, terminal delete). Reproduces the Symptom
// Verification invariant: (1) a lock released within the window succeeds
// without surfacing `database is locked`; (2) a lock that never clears fails
// fast with a clear, actionable, non-zero-exit error within a short bound
// (fake timers, no real long waits per FN-5048); (3) a not-found error does
// NOT retry-loop; (4) the resolved store is closed/evicted from
// `storeCache` on success, not-found, and exhaustion paths, for BOTH the
// cached (`resolveProject` mock below models a registered/cached store) and
// the uncached CWD-fallback branch (`resolveProject` rejects, so
// `getBoardCommandContext` falls through to the `asLocalProjectContext`
// wrapper around a fresh, uncached `TaskStore`).
describe("FN-7734: generalized retry+teardown across representative fn task subcommands", () => {
  /*
   * FNXC:CliTests 2026-07-24-08:25:
   * Cached-store cases share one task.js import (same cold-graph budget as
   * FN-7731). Uncached CWD-fallback cases still re-import because they need a
   * distinct project-context + @fusion/core TaskStore double.
   */
  describe("cached store resolution", () => {
    let mod: typeof import("../task.js");
    let closeProjectStore: ReturnType<typeof vi.fn>;
    let storeHolder: Record<string, unknown>;

    beforeAll(async () => {
      vi.doUnmock("@fusion/core");
      vi.resetModules();
      storeHolder = {};
      closeProjectStore = vi.fn(async (context: { store: { close?: () => Promise<void> } }) => {
        await context.store.close?.().catch(() => {});
      });
      const resolveProject = vi.fn(async () => ({
        projectId: "proj_test",
        projectPath: "/proj",
        projectName: "proj",
        isRegistered: true,
        store: storeHolder,
      }));
      vi.doMock("../../project-context.js", () => ({
        resolveProject,
        closeProjectStore,
        createLocalStore: vi.fn(async () => storeHolder as never),
      }));
      mod = await import("../task.js");
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      delete process.env.FUSION_CLI_LOCK_RETRY_MS;
      for (const key of Object.keys(storeHolder)) {
        delete storeHolder[key];
      }
      closeProjectStore.mockClear();
    });

    afterAll(() => {
      vi.doUnmock("../../project-context.js");
      vi.doUnmock("@fusion/core");
      vi.resetModules();
    });

    function assignStore(methods: Record<string, unknown>) {
      for (const [key, value] of Object.entries(methods)) {
        storeHolder[key] = value;
      }
      if (typeof storeHolder.close !== "function") {
        storeHolder.close = vi.fn().mockResolvedValue(undefined);
      }
    }

    describe("runTaskUpdate (single-call board-mutation)", () => {
      it("retries through a transient lock and succeeds once it clears, closing the store", async () => {
        process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
        const lockError = new Error("database is locked");
        const updateStep = vi
          .fn()
          .mockRejectedValueOnce(lockError)
          .mockResolvedValueOnce({ id: "FN-20", steps: [{ name: "step0", status: "done" }] });
        assignStore({ updateStep });
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

        vi.useFakeTimers();
        const promise = mod.runTaskUpdate("FN-20", "0", "done");
        for (let i = 0; i < 10 && updateStep.mock.calls.length < 2; i++) {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        await promise;

        expect(updateStep).toHaveBeenCalledTimes(2);
        expect(closeProjectStore).toHaveBeenCalled();
        logSpy.mockRestore();
      });

      it("fails fast on lock-exhaustion with an actionable error, non-zero exit, and closes the store", async () => {
        process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
        const updateStep = vi.fn().mockRejectedValue(new Error("database is locked"));
        assignStore({ updateStep });

        vi.useFakeTimers();
        const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
          throw new Error(`process.exit(${code})`);
        }) as never);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const promise = mod.runTaskUpdate("FN-21", "0", "done");
        const assertion = expect(promise).rejects.toThrow(/process\.exit\(1\)/);
        for (let i = 0; i < 10 && updateStep.mock.calls.length < 2; i++) {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        await vi.advanceTimersByTimeAsync(1_000);
        await assertion;

        expect(updateStep.mock.calls.length).toBeGreaterThan(1);
        const printed = errorSpy.mock.calls.flat().join("\n");
        expect(printed).not.toMatch(/^\s*database is locked\s*$/im);
        expect(printed).toMatch(/locked|FUSION_CLI_LOCK_RETRY_MS/i);
        expect(closeProjectStore).toHaveBeenCalled();

        exitSpy.mockRestore();
        errorSpy.mockRestore();
      });
    });

    describe("runTaskComments (single-call board-read)", () => {
      it("retries through a transient lock and succeeds once it clears, closing the store", async () => {
        process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
        const lockError = new Error("SQLITE_BUSY: database is locked");
        const getTask = vi
          .fn()
          .mockRejectedValueOnce(lockError)
          .mockResolvedValueOnce({ id: "FN-23", comments: [{ id: "c1", author: "user", text: "hi", createdAt: new Date().toISOString() }] });
        assignStore({ getTask });
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

        vi.useFakeTimers();
        const promise = mod.runTaskComments("FN-23");
        for (let i = 0; i < 10 && getTask.mock.calls.length < 2; i++) {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        await promise;

        expect(getTask).toHaveBeenCalledTimes(2);
        expect(closeProjectStore).toHaveBeenCalled();
        logSpy.mockRestore();
      });
    });

    describe("runTaskDelete (MULTI-STEP mutation: existence check + confirm + terminal delete)", () => {
      it("retries the terminal delete write through a transient lock without redoing the existence check, and closes the store", async () => {
        process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
        const getTask = vi.fn().mockResolvedValue({ id: "FN-25" });
        const lockError = new Error("database is locked");
        const deleteTask = vi.fn().mockRejectedValueOnce(lockError).mockResolvedValueOnce(undefined);
        assignStore({ getTask, deleteTask });
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

        vi.useFakeTimers();
        const promise = mod.runTaskDelete("FN-25", true);
        for (let i = 0; i < 10 && deleteTask.mock.calls.length < 2; i++) {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        await promise;

        // Existence check ran exactly once — a LATER step's lock error must not
        // redo an earlier, already-succeeded step.
        expect(getTask).toHaveBeenCalledTimes(1);
        expect(deleteTask).toHaveBeenCalledTimes(2);
        expect(closeProjectStore).toHaveBeenCalled();
        logSpy.mockRestore();
      });

      it("fails fast on lock-exhaustion during the terminal delete with an actionable error, non-zero exit, and closes the store", async () => {
        process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
        const getTask = vi.fn().mockResolvedValue({ id: "FN-26" });
        const deleteTask = vi.fn().mockRejectedValue(new Error("database is locked"));
        assignStore({ getTask, deleteTask });

        vi.useFakeTimers();
        const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
          throw new Error(`process.exit(${code})`);
        }) as never);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const promise = mod.runTaskDelete("FN-26", true);
        const assertion = expect(promise).rejects.toThrow(/process\.exit\(1\)/);
        for (let i = 0; i < 10 && deleteTask.mock.calls.length < 2; i++) {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        await vi.advanceTimersByTimeAsync(1_000);
        await assertion;

        expect(deleteTask.mock.calls.length).toBeGreaterThan(1);
        expect(closeProjectStore).toHaveBeenCalled();

        exitSpy.mockRestore();
        errorSpy.mockRestore();
      });
    });
  });

  describe("uncached CWD-fallback store resolution", () => {
    afterEach(() => {
      vi.doUnmock("../../project-context.js");
      vi.doUnmock("@fusion/core");
      vi.restoreAllMocks();
      delete process.env.FUSION_CLI_LOCK_RETRY_MS;
    });

    /** Uncached CWD-fallback: `resolveProject` rejects, forcing `getBoardCommandContext`'s createLocalStore branch. */
    async function loadWithUncachedFallbackStore(store: Record<string, unknown>) {
      vi.doUnmock("@fusion/core");
      vi.resetModules();
      const closeProjectStore = vi.fn(async (context: { store: { close?: () => Promise<void> } }) => {
        await context.store.close?.().catch(() => {});
      });
      const resolveProject = vi.fn().mockRejectedValue(new Error("no registered project"));
      vi.doMock("../../project-context.js", () => ({
        resolveProject,
        closeProjectStore,
        // FNXC:PostgresCutover 2026-07-10: the branch's cwd fallback boots via
        // createLocalStore; hand back the same proxied mock store.
        createLocalStore: vi.fn(async () => {
          const proxied = new Proxy(store, {
            get(target, prop) {
              if (prop === "init") return async () => {};
              return (target as Record<string, unknown>)[prop as string];
            },
          });
          return proxied as never;
        }),
      }));
      vi.doMock("@fusion/core", async () => {
        const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
        return {
          ...actual,
          TaskStore: class {
            async init() {}
            async close() {
              await (store.close as (() => Promise<void>) | undefined)?.();
            }
            constructor() {
              return new Proxy(store, {
                get(target, prop) {
                  if (prop === "init") return async () => {};
                  return (target as Record<string, unknown>)[prop as string];
                },
              });
            }
          },
        };
      });
      const mod = await import("../task.js");
      return { mod, closeProjectStore, resolveProject };
    }

    it("runTaskUpdate: a not-found error does not retry-loop and closes the store (uncached CWD-fallback branch)", async () => {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
      const updateStep = vi.fn().mockRejectedValue(new Error("Task FN-22 not found"));
      const store = { updateStep, close: vi.fn().mockResolvedValue(undefined) };
      const { mod, closeProjectStore } = await loadWithUncachedFallbackStore(store);

      await expect(mod.runTaskUpdate("FN-22", "0", "done")).rejects.toThrow("Task FN-22 not found");
      expect(updateStep).toHaveBeenCalledTimes(1);
      expect(closeProjectStore).toHaveBeenCalled();
    });

    it("runTaskComments: the happy path (no lock contention, uncached CWD-fallback branch) adds no retry latency and closes the store once", async () => {
      const getTask = vi.fn().mockResolvedValue({ id: "FN-24", comments: [] });
      const store = { getTask, close: vi.fn().mockResolvedValue(undefined) };
      const { mod, closeProjectStore } = await loadWithUncachedFallbackStore(store);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await mod.runTaskComments("FN-24");

      expect(getTask).toHaveBeenCalledTimes(1);
      expect(closeProjectStore).toHaveBeenCalledTimes(1);
      logSpy.mockRestore();
    });

    it("runTaskDelete: a not-found error at the existence-check step does not retry-loop, and closes the store (uncached CWD-fallback branch)", async () => {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
      const getTask = vi.fn().mockRejectedValue(new Error("Task FN-27 not found"));
      const deleteTask = vi.fn();
      const store = { getTask, deleteTask, close: vi.fn().mockResolvedValue(undefined) };
      const { mod, closeProjectStore } = await loadWithUncachedFallbackStore(store);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(mod.runTaskDelete("FN-27", true)).rejects.toThrow(/process\.exit\(1\)/);

      expect(getTask).toHaveBeenCalledTimes(1);
      expect(deleteTask).not.toHaveBeenCalled();
      expect(closeProjectStore).toHaveBeenCalled();

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});
