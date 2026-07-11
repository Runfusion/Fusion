/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Regression coverage for FN-7740's `research.ts` fix: every `runResearch*`
 * command must close its resolved `TaskStore` on every exit path
 * (success/not-found/`handleError`), retry `getSettings()`/`createExport`
 * through a momentary `database is locked`, and — critically — the
 * `runResearchCreate` non-`waitForCompletion` fire-and-forget branch must
 * be exempt from the close discipline (closing it would truncate an
 * in-flight background run). Uses a mocked `TaskStore`/orchestrator (per
 * FN-5048 — no real long waits) with `retryOnLock`'s real bounded-backoff
 * implementation exercised end to end via fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runResearchCancel,
  runResearchCreate,
  runResearchExport,
  runResearchList,
  runResearchRetry,
  runResearchShow,
} from "../research.js";

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

const mockRun = {
  id: "RR-001",
  query: "test query",
  topic: "test query",
  status: "running",
  sources: [],
  events: [],
  tags: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  results: { summary: "done", findings: [], citations: [] },
};

const researchStoreMock = Object.assign(Object.create(MockResearchStore.prototype), {
  getRun: vi.fn(() => mockRun),
  listRuns: vi.fn(() => [mockRun]),
  createExport: vi.fn(),
});

const { storeMock, orchestratorMock, resolveResearchSettingsMock, providerRegistryMock, writeFileMock, MockResearchStore } = vi.hoisted(() => {
  // FNXC:PostgresCutover 2026-07-10: getSyncResearchStore gates the CLI on
  // `instanceof ResearchStore`; give the mock store that prototype.
  class MockResearchStore {}
  const researchStore = Object.assign(Object.create(MockResearchStore.prototype), {
    getRun: vi.fn(),
    listRuns: vi.fn(),
    createExport: vi.fn(),
  });
  return {
    storeMock: {
      init: vi.fn(),
      close: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ researchSettings: { enabled: true }, researchGlobalWebSearchProvider: "tavily", researchGlobalTavilyApiKey: "x" })),
      getResearchStore: vi.fn(() => researchStore),
    },
    orchestratorMock: {
      createRun: vi.fn(() => "RR-002"),
      startRun: vi.fn(async () => ({ id: "RR-002", status: "running" })),
      cancelRun: vi.fn(() => true),
      retryRun: vi.fn(() => "RR-003"),
    },
    resolveResearchSettingsMock: vi.fn(() => ({ enabled: true, limits: { maxConcurrentRuns: 2, maxSourcesPerRun: 5, requestTimeoutMs: 1000, maxDurationMs: 5000 } })),
    providerRegistryMock: makeConstructibleMock(function () { return { getAvailableProviders: () => ["tavily"], getProvider: () => ({ type: "tavily" }) }; }),
    writeFileMock: vi.fn(async () => undefined),
    MockResearchStore,
  };
});

vi.mock("@fusion/core", () => ({
  // FNXC:PostgresCutover 2026-07-10: PG startup factory consulted before legacy TaskStore; null keeps the legacy mock path; getSyncResearchStore needs the ResearchStore class for its instanceof gate.
  createTaskStoreForBackend: vi.fn(async () => null),
  ResearchStore: MockResearchStore,
  TaskStore: makeConstructibleMock(() => storeMock),
  resolveResearchSettings: resolveResearchSettingsMock,
  RESEARCH_RUN_STATUSES: ["queued", "running", "cancelling", "retry_waiting", "completed", "failed", "cancelled", "timed_out", "retry_exhausted"],
  RESEARCH_EXPORT_FORMATS: ["json", "markdown", "pdf"],
  isSqliteLockError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return /database is locked|SQLITE_BUSY/i.test(message);
  },
}));

vi.mock("@fusion/engine", () => ({
  ResearchProviderRegistry: providerRegistryMock,
  ResearchStepRunner: vi.fn(),
  ResearchOrchestrator: makeConstructibleMock(() => orchestratorMock),
}));

vi.mock("../../project-context.js", () => ({
  resolveProject: vi.fn(async () => undefined),
  resolveProjectPathOnly: vi.fn(async () => undefined),
}));
vi.mock("node:fs/promises", () => ({ writeFile: writeFileMock }));

describe("research commands — leak/lock reproduction (FN-7740)", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const originalExit = process.exit;
  const originalRetryMs = process.env.FUSION_CLI_LOCK_RETRY_MS;
  const researchStore = researchStoreMock;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exit = vi.fn(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit);
    storeMock.getSettings.mockResolvedValue({ researchSettings: { enabled: true }, researchGlobalWebSearchProvider: "tavily", researchGlobalTavilyApiKey: "x" });
    storeMock.getResearchStore.mockReturnValue(researchStore);
    resolveResearchSettingsMock.mockReturnValue({ enabled: true, limits: { maxConcurrentRuns: 2, maxSourcesPerRun: 5, requestTimeoutMs: 1000, maxDurationMs: 5000 } });
    providerRegistryMock.mockImplementation(function () { return { getAvailableProviders: () => ["tavily"], getProvider: () => ({ type: "tavily" }) }; });
    researchStore.getRun.mockReturnValue(mockRun);
    researchStore.listRuns.mockReturnValue([mockRun]);
    researchStore.createExport.mockReturnValue(undefined);
    orchestratorMock.retryRun.mockReturnValue("RR-003");
    orchestratorMock.startRun.mockResolvedValue({ ...mockRun, id: "RR-002", status: "running" });
  });

  afterEach(() => {
    process.exit = originalExit;
    if (originalRetryMs === undefined) {
      delete process.env.FUSION_CLI_LOCK_RETRY_MS;
    } else {
      process.env.FUSION_CLI_LOCK_RETRY_MS = originalRetryMs;
    }
  });

  it("closes the store on the runResearchList success path", async () => {
    await runResearchList({ json: true });
    expect(storeMock.close).toHaveBeenCalled();
  });

  it("closes the store on the runResearchShow success path", async () => {
    await runResearchShow("RR-001");
    expect(storeMock.close).toHaveBeenCalled();
  });

  it("closes the store on a not-found error path (handleError → process.exit(1))", async () => {
    researchStore.getRun.mockReturnValue(undefined);
    await expect(runResearchShow("RR-404")).rejects.toThrow("process.exit:1");
    expect(storeMock.close).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("Error: Cited-research run not found: RR-404");
  });

  it("closes the store on the runResearchExport success path", async () => {
    await runResearchExport({ runId: "RR-001", format: "json", output: "./out.json" });
    expect(storeMock.close).toHaveBeenCalled();
  });

  it("closes the store on the runResearchCancel success path", async () => {
    await runResearchCancel("RR-001", { json: true });
    expect(storeMock.close).toHaveBeenCalled();
  });

  it("closes the store on the runResearchRetry success path", async () => {
    researchStore.getRun.mockImplementation((id: string) => (id === "RR-003" ? { ...mockRun, id: "RR-003", status: "queued" } : { ...mockRun, status: "failed" }));
    await runResearchRetry("RR-001", { json: true });
    expect(storeMock.close).toHaveBeenCalled();
  });

  it("closes the store on runResearchCreate's waitForCompletion path (fully awaited)", async () => {
    orchestratorMock.startRun.mockResolvedValue({ ...mockRun, id: "RR-002", status: "completed" });
    await runResearchCreate({ query: "hello", waitForCompletion: true, maxWaitMs: 1_000 });
    expect(storeMock.close).toHaveBeenCalled();
  });

  it("does NOT close the store on runResearchCreate's non-wait fire-and-forget path (intentionally-long-lived exemption)", async () => {
    // The background run continues to read/write the same store via
    // `orchestrator.startRun` after this call returns — closing it here
    // would truncate an in-flight run. This is the ONE deliberately
    // exempted branch in the whole FN-7740 audit.
    await runResearchCreate({ query: "hello" });
    expect(storeMock.close).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Created cited-research run"));
  });

  it("retries getSettings through a transient database-is-locked error and succeeds once it clears", async () => {
    const lockError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    storeMock.getSettings
      .mockRejectedValueOnce(lockError)
      .mockRejectedValueOnce(lockError)
      .mockResolvedValueOnce({ researchSettings: { enabled: true }, researchGlobalWebSearchProvider: "tavily", researchGlobalTavilyApiKey: "x" });

    process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
    vi.useFakeTimers();
    try {
      const promise = runResearchCreate({ query: "hello" });
      for (let i = 0; i < 10 && storeMock.getSettings.mock.calls.length < 3; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await promise;
    } finally {
      vi.useRealTimers();
    }

    expect(storeMock.getSettings).toHaveBeenCalledTimes(3);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Created cited-research run"));
  });

  it("fails fast with a clear non-zero-exit error when the lock never clears within the bound (getSettings)", async () => {
    const lockError = Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });
    storeMock.getSettings.mockRejectedValue(lockError);

    process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
    vi.useFakeTimers();
    try {
      const promise = runResearchCreate({ query: "hello" });
      const assertion = expect(promise).rejects.toThrow("process.exit:1");
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("board database stayed locked"));
    expect(storeMock.close).toHaveBeenCalled();
  });

  it("retries createExport through a transient database-is-locked error and succeeds once it clears", async () => {
    const lockError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    researchStore.createExport
      .mockImplementationOnce(() => { throw lockError; })
      .mockImplementationOnce(() => { throw lockError; })
      .mockImplementationOnce(() => undefined);

    process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
    vi.useFakeTimers();
    try {
      const promise = runResearchExport({ runId: "RR-001", format: "json", output: "./out.json" });
      for (let i = 0; i < 10 && researchStore.createExport.mock.calls.length < 3; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await promise;
    } finally {
      vi.useRealTimers();
    }

    expect(researchStore.createExport).toHaveBeenCalledTimes(3);
    expect(storeMock.close).toHaveBeenCalled();
  });
});
