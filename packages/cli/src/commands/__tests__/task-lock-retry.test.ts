/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Regression coverage for FN-7731 — `fn task show`/`fn task move` must
 * retry through a momentarily-locked SQLite board database instead of
 * surfacing a raw `database is locked` error or hanging, and must always
 * close the resolved `TaskStore` so the CLI process exits promptly.
 *
 * Two layers of coverage:
 *  1. Unit-level tests against `retryOnLock` itself (fake timers, no real
 *     waits) proving the bounded-backoff/fast-fail/non-lock-passthrough
 *     contract in isolation.
 *  2. An integration-level reproduction against a REAL `TaskStore`/SQLite
 *     database with a genuine external writer lock (a spawned Node
 *     subprocess holding `BEGIN IMMEDIATE`), driving `runTaskShow`/
 *     `runTaskMove` exactly as the CLI would, proving the original
 *     `database is locked` symptom is gone end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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

// ── Real-store integration reproduction ──────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-task-lock-retry-test-"));
}

/**
 * Spawn a subprocess that opens the given SQLite file, takes a real
 * `BEGIN IMMEDIATE` writer lock, and holds it until told to release (or
 * until `holdMs` elapses in timer mode). Mirrors the pattern used by
 * `packages/core/src/__tests__/store-concurrent-writes.test.ts`.
 */
async function holdWriteLock(
  dbPath: string,
  options?: { holdMs?: number },
): Promise<{ child: ChildProcessWithoutNullStreams; release: () => Promise<void> }> {
  const holdMs = options?.holdMs;
  const releaseMode = holdMs !== undefined ? "timer" : "manual";
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("LOCKED\\n");
    const release = () => {
      try { db.exec("COMMIT"); } catch {}
      try { db.close(); } catch {}
      process.exit(0);
    };
    if (${JSON.stringify(releaseMode)} === "timer") {
      const signal = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(signal, 0, 0, ${holdMs ?? 0});
      release();
    } else {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        if (chunk.includes("RELEASE")) release();
      });
    }
  `;

  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });

  const ready = new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("LOCKED")) resolve();
    });
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Lock helper exited early (${code}): ${stderr || "no stderr"}`));
    });
    child.once("error", reject);
  });

  await ready;

  return {
    child,
    release: async () => {
      if (child.exitCode !== null || child.killed) return;
      if (releaseMode === "timer") {
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        return;
      }
      child.stdin.write("RELEASE\n");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  };
}

/*
 * FNXC:PostgresCutover 2026-07-10:
 * Upstream's "real locked-store reproduction" describe held a REAL write lock
 * on a sqlite fusion.db file to reproduce `database is locked` (FN-7731). The
 * sqlite runtime is removed on this branch and PostgreSQL has no equivalent
 * whole-database writer lock, so the real-file reproduction is not portable.
 * The CLI-layer retry/teardown contract stays covered by the mocked-store
 * describes below (lock exhaustion, not-found, close-on-every-exit-path).
 */
describe("runTaskShow / runTaskMove — mocked-store lock exhaustion, not-found, and teardown (FN-7731)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../project-context.js");
    vi.restoreAllMocks();
    delete process.env.FUSION_CLI_LOCK_RETRY_MS;
  });

  async function loadWithMockedStore(store: Record<string, unknown>) {
    const closeProjectStore = vi.fn(async (context: { store: { close?: () => Promise<void> } }) => {
      await context.store.close?.().catch(() => {});
    });
    const resolveProject = vi.fn().mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/proj",
      projectName: "proj",
      isRegistered: true,
      store,
    });
    vi.doMock("../../project-context.js", () => ({ resolveProject, closeProjectStore, createLocalStore: vi.fn(async () => store as never) }));
    const mod = await import("../task.js");
    return { mod, closeProjectStore, resolveProject };
  }

  it("runTaskShow: bounded exhaustion across many fast lock retries fails clearly and closes the store", async () => {
    vi.useFakeTimers();
    try {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
      const getTask = vi.fn().mockRejectedValue(new Error("database is locked"));
      const store = { getTask, close: vi.fn().mockResolvedValue(undefined) };
      const { mod, closeProjectStore } = await loadWithMockedStore(store);

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
    } finally {
      vi.useRealTimers();
    }
  });

  it("runTaskMove: bounded exhaustion across many fast lock retries fails clearly and closes the store", async () => {
    vi.useFakeTimers();
    try {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
      const moveTask = vi.fn().mockRejectedValue(new Error("SQLITE_BUSY: database is locked"));
      const store = { moveTask, close: vi.fn().mockResolvedValue(undefined) };
      const { mod, closeProjectStore } = await loadWithMockedStore(store);

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
    } finally {
      vi.useRealTimers();
    }
  });

  it("runTaskShow: a not-found error does not retry-loop and propagates clearly, store still closed", async () => {
    process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
    const getTask = vi.fn().mockRejectedValue(new Error("Task FN-404 not found"));
    const store = { getTask, close: vi.fn().mockResolvedValue(undefined) };
    const { mod, closeProjectStore } = await loadWithMockedStore(store);

    await expect(mod.runTaskShow("FN-404")).rejects.toThrow("Task FN-404 not found");
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalled();
  });

  it("runTaskMove: a move-to-same-column no-op succeeds on the first attempt and closes the store", async () => {
    const moveTask = vi.fn().mockResolvedValue({ id: "FN-5", column: "todo" });
    const store = { moveTask, close: vi.fn().mockResolvedValue(undefined) };
    const { mod, closeProjectStore } = await loadWithMockedStore(store);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mod.runTaskMove("FN-5", "todo");

    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(moveTask).toHaveBeenCalledWith("FN-5", "todo");
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
    const store = { getTask, close: vi.fn().mockResolvedValue(undefined) };
    const { mod, closeProjectStore } = await loadWithMockedStore(store);
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
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../project-context.js");
    vi.restoreAllMocks();
    delete process.env.FUSION_CLI_LOCK_RETRY_MS;
  });

  /** Cached/registered-project store resolution branch (mirrors the existing mocked-store helper above). */
  async function loadWithCachedStore(store: Record<string, unknown>) {
    const closeProjectStore = vi.fn(async (context: { store: { close?: () => Promise<void> } }) => {
      await context.store.close?.().catch(() => {});
    });
    const resolveProject = vi.fn().mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/proj",
      projectName: "proj",
      isRegistered: true,
      store,
    });
    vi.doMock("../../project-context.js", () => ({ resolveProject, closeProjectStore, createLocalStore: vi.fn(async () => store as never) }));
    const mod = await import("../task.js");
    return { mod, closeProjectStore, resolveProject };
  }

  /** Uncached CWD-fallback store resolution branch: `resolveProject` rejects for both the explicit-name and default-project paths, forcing `getBoardCommandContext`'s catch branch (`asLocalProjectContext` wrapping a fresh store). */
  async function loadWithUncachedFallbackStore(store: Record<string, unknown>) {
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
            await store.close?.();
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

  describe("runTaskUpdate (single-call board-mutation)", () => {
    it("retries through a transient lock and succeeds once it clears, closing the store", async () => {
      vi.useFakeTimers();
      try {
        process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
        const lockError = new Error("database is locked");
        const updateStep = vi
          .fn()
          .mockRejectedValueOnce(lockError)
          .mockResolvedValueOnce({ id: "FN-20", steps: [{ name: "step0", status: "done" }] });
        const store = { updateStep, close: vi.fn().mockResolvedValue(undefined) };
        const { mod, closeProjectStore } = await loadWithCachedStore(store);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

        const promise = mod.runTaskUpdate("FN-20", "0", "done");
        for (let i = 0; i < 10 && updateStep.mock.calls.length < 2; i++) {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        await promise;

        expect(updateStep).toHaveBeenCalledTimes(2);
        expect(closeProjectStore).toHaveBeenCalled();
        logSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it("fails fast on lock-exhaustion with an actionable error, non-zero exit, and closes the store", async () => {
      vi.useFakeTimers();
      try {
        process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
        const updateStep = vi.fn().mockRejectedValue(new Error("database is locked"));
        const store = { updateStep, close: vi.fn().mockResolvedValue(undefined) };
        const { mod, closeProjectStore } = await loadWithCachedStore(store);

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
      } finally {
        vi.useRealTimers();
      }
    });

    it("a not-found error does not retry-loop and closes the store (uncached CWD-fallback branch)", async () => {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
      const updateStep = vi.fn().mockRejectedValue(new Error("Task FN-22 not found"));
      const store = { updateStep, close: vi.fn().mockResolvedValue(undefined) };
      const { mod, closeProjectStore } = await loadWithUncachedFallbackStore(store);

      await expect(mod.runTaskUpdate("FN-22", "0", "done")).rejects.toThrow("Task FN-22 not found");
      expect(updateStep).toHaveBeenCalledTimes(1);
      expect(closeProjectStore).toHaveBeenCalled();
    });
  });

  describe("runTaskComments (single-call board-read)", () => {
    it("retries through a transient lock and succeeds once it clears, closing the store", async () => {
      vi.useFakeTimers();
      try {
        process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
        const lockError = new Error("SQLITE_BUSY: database is locked");
        const getTask = vi
          .fn()
          .mockRejectedValueOnce(lockError)
          .mockResolvedValueOnce({ id: "FN-23", comments: [{ id: "c1", author: "user", text: "hi", createdAt: new Date().toISOString() }] });
        const store = { getTask, close: vi.fn().mockResolvedValue(undefined) };
        const { mod, closeProjectStore } = await loadWithCachedStore(store);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

        const promise = mod.runTaskComments("FN-23");
        for (let i = 0; i < 10 && getTask.mock.calls.length < 2; i++) {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        await promise;

        expect(getTask).toHaveBeenCalledTimes(2);
        expect(closeProjectStore).toHaveBeenCalled();
        logSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it("the happy path (no lock contention, uncached CWD-fallback branch) adds no retry latency and closes the store once", async () => {
      const getTask = vi.fn().mockResolvedValue({ id: "FN-24", comments: [] });
      const store = { getTask, close: vi.fn().mockResolvedValue(undefined) };
      const { mod, closeProjectStore } = await loadWithUncachedFallbackStore(store);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await mod.runTaskComments("FN-24");

      expect(getTask).toHaveBeenCalledTimes(1);
      expect(closeProjectStore).toHaveBeenCalledTimes(1);
      logSpy.mockRestore();
    });
  });

  describe("runTaskDelete (MULTI-STEP mutation: existence check + confirm + terminal delete)", () => {
    it("retries the terminal delete write through a transient lock without redoing the existence check, and closes the store", async () => {
      vi.useFakeTimers();
      try {
        process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
        const getTask = vi.fn().mockResolvedValue({ id: "FN-25" });
        const lockError = new Error("database is locked");
        const deleteTask = vi.fn().mockRejectedValueOnce(lockError).mockResolvedValueOnce(undefined);
        const store = { getTask, deleteTask, close: vi.fn().mockResolvedValue(undefined) };
        const { mod, closeProjectStore } = await loadWithCachedStore(store);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

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
      } finally {
        vi.useRealTimers();
      }
    });

    it("fails fast on lock-exhaustion during the terminal delete with an actionable error, non-zero exit, and closes the store", async () => {
      vi.useFakeTimers();
      try {
        process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
        const getTask = vi.fn().mockResolvedValue({ id: "FN-26" });
        const deleteTask = vi.fn().mockRejectedValue(new Error("database is locked"));
        const store = { getTask, deleteTask, close: vi.fn().mockResolvedValue(undefined) };
        const { mod, closeProjectStore } = await loadWithCachedStore(store);

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
      } finally {
        vi.useRealTimers();
      }
    });

    it("a not-found error at the existence-check step does not retry-loop, and closes the store (uncached CWD-fallback branch)", async () => {
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
