/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Regression coverage for FN-7738 — `fn branch-group *` must retry through a
 * momentarily-locked SQLite board database instead of surfacing a raw
 * `database is locked` error or hanging, and must always close the resolved
 * `TaskStore` (cached AND the uncached CWD-fallback branch) so the CLI
 * process exits promptly. Mirrors the FN-7731 `task-lock-retry.test.ts`
 * pattern: mocked-store lock exhaustion/not-found/teardown coverage (fast,
 * fake-timer based, no real waits per FN-5048).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@fusion/dashboard", () => ({
  GitHubClient: vi.fn(function GitHubClient() {}),
  closeGroupPullRequest: vi.fn(),
}));
vi.mock("@fusion/engine", () => ({
  promoteBranchGroup: vi.fn(),
  resolveIntegrationBranch: vi.fn(async () => "main"),
}));
vi.mock("../task-lifecycle.js", () => ({
  createGroupPrCallback: vi.fn(() => async () => ({ prNumber: 1, prUrl: "x", prState: "open" as const })),
}));

const BASE_GROUP = {
  id: "BG-1",
  sourceType: "planning",
  sourceId: "PS-1",
  branchName: "feature/shared",
  status: "open" as const,
  prState: "none" as const,
  autoMerge: false,
};

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    getBranchGroup: vi.fn(() => BASE_GROUP),
    listBranchGroups: vi.fn(() => [BASE_GROUP]),
    listTasks: vi.fn(async () => []),
    listTasksByBranchGroup: vi.fn(async () => []),
    updateBranchGroup: vi.fn((_id: string, patch: Record<string, unknown>) => ({ ...BASE_GROUP, ...patch })),
    getSettings: vi.fn(async () => ({
      autoMerge: false,
      globalPause: false,
      enginePaused: false,
      mergeStrategy: "merge",
      baseBranch: "main",
    })),
    recordRunAuditEvent: vi.fn(),
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
  const mod = await import("../branch-group.js");
  return { mod, closeProjectStore, resolveProject };
}

describe("fn branch-group * — lock retry, leak/close, and not-found teardown (FN-7738)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../project-context.js");
    vi.restoreAllMocks();
    delete process.env.FUSION_CLI_LOCK_RETRY_MS;
  });

  it("runBranchGroupShow: succeeds on first attempt (no lock contention) and closes the store once", async () => {
    const store = makeStore();
    const { mod, closeProjectStore } = await loadWithMockedStore(store);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mod.runBranchGroupShow("BG-1");

    expect(store.getBranchGroup).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("runBranchGroupShow: retries through a transient lock error and succeeds once it clears, then closes the store", async () => {
    vi.useFakeTimers();
    try {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
      const lockError = new Error("database is locked");
      const getBranchGroup = vi.fn().mockImplementationOnce(() => {
        throw lockError;
      }).mockImplementation(() => BASE_GROUP);
      const store = makeStore({ getBranchGroup });
      const { mod, closeProjectStore } = await loadWithMockedStore(store);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const promise = mod.runBranchGroupShow("BG-1");
      for (let i = 0; i < 10 && getBranchGroup.mock.calls.length < 2; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await promise;

      expect(getBranchGroup.mock.calls.length).toBeGreaterThan(1);
      expect(closeProjectStore).toHaveBeenCalled();
      logSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runBranchGroupAbandon: bounded exhaustion across many fast lock retries fails clearly and closes the store", async () => {
    vi.useFakeTimers();
    try {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
      const updateBranchGroup = vi.fn().mockImplementation(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      });
      const store = makeStore({ updateBranchGroup });
      const { mod, closeProjectStore } = await loadWithMockedStore(store);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const promise = mod.runBranchGroupAbandon("BG-1");
      const assertion = expect(promise).rejects.toThrow(/process\.exit\(1\)/);
      for (let i = 0; i < 10 && updateBranchGroup.mock.calls.length < 2; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      expect(updateBranchGroup.mock.calls.length).toBeGreaterThan(1);
      const printed = errorSpy.mock.calls.flat().join("\n");
      expect(printed).toMatch(/locked|FUSION_CLI_LOCK_RETRY_MS/i);
      expect(closeProjectStore).toHaveBeenCalled();

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runBranchGroupShow: a not-found error does not retry-loop and closes the store before exiting", async () => {
    process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
    const getBranchGroup = vi.fn().mockReturnValue(null);
    const store = makeStore({ getBranchGroup });
    const { mod, closeProjectStore } = await loadWithMockedStore(store);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(mod.runBranchGroupShow("BG-404")).rejects.toThrow(/process\.exit\(1\)/);

    expect(getBranchGroup).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("BG-404");

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("runBranchGroupAbandon: a terminal-guard input (already-abandoned) exits cleanly and closes the store, without calling update", async () => {
    const store = makeStore({ getBranchGroup: vi.fn(() => ({ ...BASE_GROUP, status: "abandoned" })) });
    const { mod, closeProjectStore } = await loadWithMockedStore(store);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(mod.runBranchGroupAbandon("BG-1")).rejects.toThrow(/process\.exit\(1\)/);

    expect(store.updateBranchGroup).not.toHaveBeenCalled();
    expect(closeProjectStore).toHaveBeenCalled();

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("runBranchGroupShow (uncached CWD-fallback): resolves via asLocalProjectContext and still closes the store", async () => {
    const store = makeStore();
    const { mod, closeProjectStore } = await loadWithMockedStore(store, { cached: false });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mod.runBranchGroupShow("BG-1");

    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("runBranchGroupList: the happy path adds no retry latency and closes the store once", async () => {
    const store = makeStore();
    const { mod, closeProjectStore } = await loadWithMockedStore(store);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mod.runBranchGroupList();

    expect(store.listBranchGroups).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });
});
