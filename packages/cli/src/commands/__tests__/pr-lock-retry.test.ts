/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Regression coverage for FN-7738 — `fn pr *` must retry through a
 * momentarily-locked SQLite board database instead of surfacing a raw
 * `database is locked` error or hanging, and must always close the resolved
 * `TaskStore` (cached AND the uncached CWD-fallback branch) so the CLI
 * process exits promptly. Mirrors the FN-7731 `task-lock-retry.test.ts`
 * pattern: mocked-store lock exhaustion/not-found/teardown coverage (fast,
 * fake-timer based, no real waits per FN-5048).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@fusion/core/gh-cli", () => ({
  classifyGhError: vi.fn((err: unknown) => ({ message: String(err) })),
  getGhErrorMessage: vi.fn((err: unknown) => String(err)),
  getCurrentRepo: vi.fn(() => ({ owner: "acme", repo: "widgets" })),
  isGhAuthenticated: vi.fn(() => true),
  isGhAvailable: vi.fn(() => true),
}));
vi.mock("@fusion/engine", () => ({
  releaseHeldTaskByEvent: vi.fn(async () => ({ released: true, toColumn: "done" })),
}));
vi.mock("@fusion/dashboard", () => ({
  generatePrMetadata: vi.fn(),
  GitHubClient: vi.fn(function GitHubClient() {
    return { createPr: vi.fn() };
  }),
}));

const BASE_ENTITY = {
  id: "PR-1",
  sourceType: "task",
  sourceId: "FN-1",
  repo: "acme/widgets",
  headBranch: "fusion/fn-1",
  baseBranch: "main",
  state: "open" as const,
  prNumber: 5,
  prUrl: "https://example/pr/5",
  mergeable: "mergeable" as const,
  reviewDecision: null,
  checksRollup: null,
  autoMerge: false,
  responseRounds: 0,
};

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    getPrEntity: vi.fn(() => BASE_ENTITY),
    listActivePrEntities: vi.fn(() => [BASE_ENTITY]),
    listPrThreadStates: vi.fn(() => []),
    updatePrEntity: vi.fn((id: string, patch: Record<string, unknown>) => ({ ...BASE_ENTITY, ...patch })),
    reconcileLegacyAutoMergeStamps: vi.fn(async () => []),
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
  const mod = await import("../pr.js");
  return { mod, closeProjectStore, resolveProject };
}

describe("fn pr * — lock retry, leak/close, and not-found teardown (FN-7738)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../project-context.js");
    vi.restoreAllMocks();
    delete process.env.FUSION_CLI_LOCK_RETRY_MS;
  });

  it("runPrList: succeeds on first attempt (no lock contention) and closes the store once", async () => {
    const store = makeStore();
    const { mod, closeProjectStore } = await loadWithMockedStore(store);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mod.runPrList();

    expect(store.listActivePrEntities).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("runPrList: retries through a transient lock error and succeeds once it clears, then closes the store", async () => {
    vi.useFakeTimers();
    try {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
      const lockError = new Error("database is locked");
      const listActivePrEntities = vi.fn().mockImplementationOnce(() => {
        throw lockError;
      }).mockImplementation(() => [BASE_ENTITY]);
      const store = makeStore({ listActivePrEntities });
      const { mod, closeProjectStore } = await loadWithMockedStore(store);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const promise = mod.runPrList();
      for (let i = 0; i < 10 && listActivePrEntities.mock.calls.length < 2; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await promise;

      expect(listActivePrEntities.mock.calls.length).toBeGreaterThan(1);
      expect(closeProjectStore).toHaveBeenCalled();
      logSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runPrAutomerge: bounded exhaustion across many fast lock retries fails clearly and closes the store", async () => {
    vi.useFakeTimers();
    try {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
      const updatePrEntity = vi.fn().mockImplementation(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      });
      const store = makeStore({ updatePrEntity });
      const { mod, closeProjectStore } = await loadWithMockedStore(store);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const promise = mod.runPrAutomerge("PR-1", true);
      const assertion = expect(promise).rejects.toThrow(/process\.exit\(1\)/);
      for (let i = 0; i < 10 && updatePrEntity.mock.calls.length < 2; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      expect(updatePrEntity.mock.calls.length).toBeGreaterThan(1);
      const printed = errorSpy.mock.calls.flat().join("\n");
      expect(printed).toMatch(/locked|FUSION_CLI_LOCK_RETRY_MS/i);
      expect(closeProjectStore).toHaveBeenCalled();

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runPrShow: a not-found PR entity does not retry-loop and closes the store before exiting", async () => {
    process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
    const getPrEntity = vi.fn().mockReturnValue(null);
    const store = makeStore({ getPrEntity });
    const { mod, closeProjectStore } = await loadWithMockedStore(store);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(mod.runPrShow("PR-404")).rejects.toThrow(/process\.exit\(1\)/);

    expect(getPrEntity).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("PR-404");

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("runPrMerge: a terminal PR entity (already merged) exits cleanly and closes the store, without releasing", async () => {
    const { releaseHeldTaskByEvent } = await import("@fusion/engine");
    const store = makeStore({ getPrEntity: vi.fn(() => ({ ...BASE_ENTITY, state: "merged" })) });
    const { mod, closeProjectStore } = await loadWithMockedStore(store);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(mod.runPrMerge("PR-1")).rejects.toThrow(/process\.exit\(1\)/);

    expect(releaseHeldTaskByEvent).not.toHaveBeenCalled();
    expect(closeProjectStore).toHaveBeenCalled();

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("runPrList (uncached CWD-fallback): resolves via asLocalProjectContext and still closes the store", async () => {
    const store = makeStore();
    const { mod, closeProjectStore } = await loadWithMockedStore(store, { cached: false });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mod.runPrList();

    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("runPrAutomergeCleanup: the happy path adds no retry latency and closes the store once", async () => {
    const store = makeStore();
    const { mod, closeProjectStore } = await loadWithMockedStore(store);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mod.runPrAutomergeCleanup({});

    expect(store.reconcileLegacyAutoMergeStamps).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });
});
