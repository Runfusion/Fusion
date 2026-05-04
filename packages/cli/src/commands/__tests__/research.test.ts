import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runResearchCancel, runResearchCreate, runResearchExport, runResearchList, runResearchRetry, runResearchShow } from "../research.js";

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

const researchStoreMock = {
  getRun: vi.fn(() => mockRun),
  listRuns: vi.fn(() => [mockRun]),
  createExport: vi.fn(),
};

const storeMock = {
  init: vi.fn(),
  getSettings: vi.fn(async () => ({ researchSettings: { enabled: true }, researchWebSearchProvider: "tavily", researchTavilyApiKey: "x" })),
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
  providerRegistryMock: vi.fn(() => ({ getAvailableProviders: () => ["tavily"], getProvider: () => ({ type: "tavily" }) })),
  writeFileMock: vi.fn(async () => undefined),
}));

vi.mock("@fusion/core", () => ({
  TaskStore: vi.fn(() => storeMock),
  resolveResearchSettings: resolveResearchSettingsMock,
  RESEARCH_RUN_STATUSES: ["queued", "running", "cancelling", "retry_waiting", "completed", "failed", "cancelled", "timed_out", "retry_exhausted"],
  RESEARCH_EXPORT_FORMATS: ["json", "markdown", "pdf"],
}));

vi.mock("@fusion/engine", () => ({
  ResearchProviderRegistry: providerRegistryMock,
  ResearchStepRunner: vi.fn(),
  ResearchOrchestrator: vi.fn(() => orchestratorMock),
}));

vi.mock("../../project-context.js", () => ({ resolveProject: vi.fn(async () => undefined) }));
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
    providerRegistryMock.mockReturnValue({ getAvailableProviders: () => ["tavily"], getProvider: () => ({ type: "tavily" }) });
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
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Created research run"));
  });

  it("lists runs as json", async () => {
    await runResearchList({ json: true, status: "completed", limit: 3 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"runs"'));
    expect(researchStoreMock.listRuns).toHaveBeenCalledWith({ status: "completed", limit: 3 });
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
    expect(errorSpy).toHaveBeenCalledWith("Error: Research run not found: RR-404");
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
    providerRegistryMock.mockReturnValue({ getAvailableProviders: () => [], getProvider: () => undefined });
    await expect(runResearchCreate({ query: "hello" })).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("provider-unavailable"));
  });

  it("errors when provider credentials are missing", async () => {
    storeMock.getSettings.mockResolvedValueOnce({ researchSettings: { enabled: true }, researchWebSearchProvider: "tavily" });
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
