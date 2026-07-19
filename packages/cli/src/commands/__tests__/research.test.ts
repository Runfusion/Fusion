import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runResearchCancel, runResearchCreate, runResearchExport, runResearchList, runResearchRetry, runResearchShow } from "../research.js";

function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
  const mock = vi.fn(function () {});
  const originalMockImplementation = mock.mockImplementation.bind(mock);
  const originalMockImplementationOnce = mock.mockImplementationOnce.bind(mock);
  const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
    return nextImpl(...args);
  };
  mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
  mock.mockImplementationOnce = ((nextImpl: T) => originalMockImplementationOnce(wrap(nextImpl))) as typeof mock.mockImplementationOnce;
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

/*
FNXC:PostgresCutover 2026-07-10: the branch's getSyncResearchStore gates the
research CLI on `instanceof ResearchStore`; give the mock store that prototype
so the mocked class check passes.
*/
const { MockResearchStore } = vi.hoisted(() => ({ MockResearchStore: class MockResearchStore {} }));
const researchStoreMock = Object.assign(Object.create(MockResearchStore.prototype), {
  getRun: vi.fn(() => mockRun),
  listRuns: vi.fn(() => [mockRun]),
  createExport: vi.fn(),
  updateRun: vi.fn(),
});

const storeMock = {
  init: vi.fn(),
  close: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({ researchSettings: { enabled: true }, researchGlobalWebSearchProvider: "tavily", researchGlobalTavilyApiKey: "x" })),
  getResearchStore: vi.fn(() => researchStoreMock),
};

const orchestratorMock = {
  createRun: vi.fn(() => "RR-002"),
  startRun: vi.fn(async () => ({ ...mockRun, id: "RR-002", status: "running" })),
  cancelRun: vi.fn(() => true),
  retryRun: vi.fn(() => "RR-003"),
};

const { resolveResearchSettingsMock, providerRegistryMock, writeFileMock } = vi.hoisted(() => ({
  resolveResearchSettingsMock: vi.fn(() => ({ enabled: true, limits: { maxConcurrentRuns: 2, maxSourcesPerRun: 5, requestTimeoutMs: 1000, maxDurationMs: 5000 } })),
  providerRegistryMock: makeConstructibleMock(function () { return { getAvailableProviders: () => ["tavily"], getProvider: () => ({ type: "tavily" }) }; }),
  writeFileMock: vi.fn(async () => undefined),
}));

// FN-7740: `research.ts` now imports `retryOnLock` (which imports
// `isSqliteLockError` from @fusion/core), so a fully-mocked @fusion/core
// module must stub it (project memory pitfall). `storeMock.close` above
// backs the close-on-every-exit-path discipline, including queued non-wait
// creation in `runResearchCreate`.
vi.mock("@fusion/core", () => ({
  TaskStore: makeConstructibleMock(() => storeMock),
  // FNXC:PostgresCutover 2026-07-10: getStore() consults the PG startup factory
  // first; null routes the test through the legacy `new TaskStore` mock path.
  createTaskStoreForBackend: vi.fn(async () => ({ taskStore: storeMock, shutdown: async () => storeMock.close() })),
  ResearchStore: MockResearchStore,
  resolveResearchSettings: resolveResearchSettingsMock,
  RESEARCH_RUN_STATUSES: ["queued", "running", "cancelling", "retry_waiting", "completed", "failed", "cancelled", "timed_out", "retry_exhausted"],
  RESEARCH_EXPORT_FORMATS: ["json", "markdown", "pdf"],
  isSqliteLockError: vi.fn(() => false),
}));

vi.mock("@fusion/engine", () => ({
  ResearchProviderRegistry: providerRegistryMock,
  ResearchStepRunner: vi.fn(),
  ResearchOrchestrator: makeConstructibleMock(() => orchestratorMock),
}));

// FN-7740: `getStore` now resolves a name→path via `resolveProjectPathOnly`
// instead of using `resolveProject`'s `.store` directly — stub both exports
// (none of these tests pass `projectName`, so `resolveProjectPathOnly` is
// unused at runtime here, but it must exist on the mock module).
vi.mock("../../project-context.js", () => ({
  asLocalProjectContext: vi.fn((store: unknown) => ({
    projectId: process.cwd(),
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    store,
  })),
  closeProjectStore: vi.fn(async (context: { store?: { close?: () => unknown } }) => {
    try {
      await context?.store?.close?.();
    } catch {
      // best-effort
    }
  }),
  resolveProject: vi.fn(async () => undefined),
  resolveProjectPathOnly: vi.fn(async () => undefined),
}));
vi.mock("node:fs/promises", () => ({ writeFile: writeFileMock }));

describe("research commands", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const originalExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exit = vi.fn(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit);
    resolveResearchSettingsMock.mockReturnValue({ enabled: true, limits: { maxConcurrentRuns: 2, maxSourcesPerRun: 5, requestTimeoutMs: 1000, maxDurationMs: 5000 } });
    providerRegistryMock.mockImplementation(function () { return { getAvailableProviders: () => ["tavily"], getProvider: () => ({ type: "tavily" }) }; });
    researchStoreMock.getRun.mockReturnValue(mockRun);
    researchStoreMock.listRuns.mockReturnValue([mockRun]);
    orchestratorMock.retryRun.mockReturnValue("RR-003");
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("creates a run", async () => {
    await runResearchCreate({ query: "hello" });
    expect(orchestratorMock.createRun).toHaveBeenCalled();
    expect(researchStoreMock.updateRun).toHaveBeenCalledWith("RR-002", { query: "hello" });
    expect(orchestratorMock.startRun).not.toHaveBeenCalled();
    expect(storeMock.close).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Created cited-research run"));
  });

  it("creates a run when provider is unset by defaulting to builtin", async () => {
    storeMock.getSettings.mockResolvedValueOnce({ researchSettings: { enabled: true } });
    resolveResearchSettingsMock.mockReturnValueOnce({
      enabled: true,
      searchProvider: "builtin",
      limits: { maxConcurrentRuns: 2, maxSourcesPerRun: 5, requestTimeoutMs: 1000, maxDurationMs: 5000 },
    });
    providerRegistryMock.mockImplementationOnce(function () { return { getAvailableProviders: () => ["web-search"], getProvider: () => ({ type: "web-search" }) }; });

    await runResearchCreate({ query: "hello builtin" });

    expect(orchestratorMock.createRun).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("lists runs as json", async () => {
    await runResearchList({ json: true, status: "completed", limit: 3 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"runs"'));
    expect(researchStoreMock.listRuns).toHaveBeenCalledWith({ status: "completed", limit: 3 });
  });

  /*
  FNXC:ResearchCliPostgres 2026-07-13-22:38:
  The CLI must accept the PostgreSQL-backed research store's promise-returning API instead of requiring the legacy ResearchStore prototype. Awaiting both backends preserves the synchronous test path while proving PG list results reach the operator.
  */
  it("lists runs through an async PostgreSQL research store", async () => {
    const asyncStore = {
      getRun: vi.fn(async () => mockRun),
      listRuns: vi.fn(async () => [mockRun]),
      createExport: vi.fn(async () => undefined),
    };
    storeMock.getResearchStore.mockReturnValueOnce(asyncStore as never);

    await runResearchList({ json: true, status: "completed", limit: 3 });

    expect(asyncStore.listRuns).toHaveBeenCalledWith({ status: "completed", limit: 3 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"runs"'));
  });

  it("rejects invalid list status", async () => {
    await expect(runResearchList({ status: "wat" })).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Error: Invalid status: wat");
  });

  it("shows one run", async () => {
    await runResearchShow("RR-001");
    expect(logSpy).toHaveBeenCalledWith("Run:       RR-001");
  });

  it("fails show on missing run", async () => {
    researchStoreMock.getRun.mockReturnValue(undefined);
    await expect(runResearchShow("RR-404")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Error: Cited-research run not found: RR-404");
  });

  it("exports with explicit output path", async () => {
    await runResearchExport({ runId: "RR-001", format: "json", output: "./out.json" });
    const writeArgs = writeFileMock.mock.calls[0]!;
    expect(String(writeArgs[0])).toContain("out.json");
    expect(String(writeArgs[1])).toContain('"id": "RR-001"');
    expect(String(writeArgs[1])).toContain('"status": "running"');
    expect(String(writeArgs[1])).toContain('"query": "test query"');
    expect(researchStoreMock.createExport).toHaveBeenCalledWith("RR-001", "json", expect.stringContaining('"id": "RR-001"'));
  });

  it("exports markdown to generated path", async () => {
    await runResearchExport({ runId: "RR-001", format: "markdown" });
    expect(writeFileMock).toHaveBeenCalledWith(expect.stringContaining("research-rr-001.md"), expect.stringContaining("## Summary"), "utf8");
  });

  it("cancels a run", async () => {
    await runResearchCancel("RR-001", { json: true });
    expect(orchestratorMock.cancelRun).toHaveBeenCalledWith("RR-001");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"cancelled"'));
  });

  it("retries a run", async () => {
    researchStoreMock.getRun.mockImplementation((id: string) => (id === "RR-003" ? { ...mockRun, id: "RR-003", status: "queued" } : { ...mockRun, status: "failed" }));
    await runResearchRetry("RR-001", { json: true });
    expect(orchestratorMock.retryRun).toHaveBeenCalledWith("RR-001");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"retryOf"'));
  });

  it("errors when research is disabled", async () => {
    resolveResearchSettingsMock.mockReturnValue({ enabled: false, limits: { maxConcurrentRuns: 2, maxSourcesPerRun: 5, requestTimeoutMs: 1000, maxDurationMs: 5000 } });
    await expect(runResearchCreate({ query: "hello" })).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Error: feature-disabled: Research is disabled in settings.");
  });

  it("errors when providers are unavailable", async () => {
    providerRegistryMock.mockImplementation(function () { return { getAvailableProviders: () => [], getProvider: () => undefined }; });
    await expect(runResearchCreate({ query: "hello" })).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("provider-unavailable"));
  });

  it("errors when provider credentials are missing", async () => {
    storeMock.getSettings.mockResolvedValueOnce({ researchSettings: { enabled: true }, researchGlobalWebSearchProvider: "tavily" });
    await expect(runResearchCreate({ query: "hello" })).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("missing-credentials"));
  });

  it("errors on cancel for terminal runs", async () => {
    researchStoreMock.getRun.mockReturnValueOnce({ ...mockRun, status: "completed" });
    await expect(runResearchCancel("RR-001")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("invalid-transition"));
  });

  it("errors on retry exhausted runs", async () => {
    researchStoreMock.getRun.mockReturnValueOnce({ ...mockRun, status: "retry_exhausted", lifecycle: { errorCode: "RETRY_EXHAUSTED" } });
    await expect(runResearchRetry("RR-001")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("retry-exhausted"));
  });

  it("errors on invalid export format", async () => {
    await expect(runResearchExport({ runId: "RR-001", format: "xml" })).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Error: Unsupported export format: xml");
  });

  it("errors on write failure", async () => {
    writeFileMock.mockRejectedValueOnce(new Error("disk full"));
    await expect(runResearchExport({ runId: "RR-001", format: "json", output: "./x.json" })).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Error: disk full");
  });
});
