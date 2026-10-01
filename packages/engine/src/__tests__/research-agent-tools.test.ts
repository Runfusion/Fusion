import { describe, expect, it, vi } from "vitest";
import type { ResearchRun, ResearchRunCreateInput, ResearchRunStatus, ResearchRunUpdateInput, TaskStore } from "@fusion/core";
import { createResearchTools } from "../agent-tools.js";
import { ResearchProviderRegistry } from "../research/provider-registry.js";
import { ResearchStepRunner } from "../research/research-step-runner.js";

function runFixture(overrides: Partial<ResearchRun> = {}): ResearchRun {
  const now = new Date().toISOString();
  return {
    id: "RR-TEST",
    query: "diagnose failure",
    status: "failed",
    sources: [],
    events: [],
    tags: [],
    lifecycle: {
      terminalReason: "failed",
      terminalCause: "raw secret=should-not-render",
      failureClass: "configuration",
      errorCode: "MISSING_CREDENTIALS",
      retryable: false,
      remediation: "Configure the research provider and synthesis model in Settings → Authentication, then start a new run.",
    },
    error: "provider response contains raw secret=should-not-render",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function toolsFor(runs: ResearchRun[]) {
  const researchStore = {
    getRun: vi.fn(async (id: string) => runs.find((run) => run.id === id)),
    listRuns: vi.fn(async () => runs),
  };
  const store = {
    getResearchStore: () => researchStore,
    getAsyncLayer: () => undefined,
  } as unknown as TaskStore;
  return createResearchTools({ store, rootDir: process.cwd(), getSettings: async () => ({ researchEnabled: true }) as never });
}

async function execute(tools: ReturnType<typeof createResearchTools>, name: string, params: Record<string, unknown>) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.execute("call", params as never);
}

function productionShapedTools(
  synthesisConfigured: boolean,
  search?: () => Promise<ResearchRun["sources"]>,
) {
  let sequence = 0;
  const runs = new Map<string, ResearchRun>();
  const researchStore = {
    createRun: async (input: ResearchRunCreateInput) => {
      const now = new Date().toISOString();
      const run: ResearchRun = { id: `RR-LIVE-${++sequence}`, query: input.query, status: "queued", providerConfig: input.providerConfig, sources: [], events: [], tags: [], createdAt: now, updatedAt: now };
      runs.set(run.id, run);
      return run;
    },
    getRun: async (id: string) => runs.get(id),
    listRuns: async () => [...runs.values()],
    updateRun: async (id: string, patch: ResearchRunUpdateInput) => {
      const current = runs.get(id);
      if (!current) return undefined;
      const updated = { ...current, ...patch, error: patch.error === null ? undefined : patch.error ?? current.error, lifecycle: { ...current.lifecycle, ...patch.lifecycle }, updatedAt: new Date().toISOString() } as ResearchRun;
      runs.set(id, updated);
      return updated;
    },
    updateStatus: async (id: string, status: ResearchRunStatus, extra?: Partial<ResearchRun>) => {
      const current = runs.get(id)!;
      runs.set(id, { ...current, ...extra, status, lifecycle: { ...current.lifecycle, ...extra?.lifecycle }, updatedAt: new Date().toISOString() });
    },
    updateStatusIfCurrent: async (id: string, expected: readonly ResearchRunStatus[], status: ResearchRunStatus, extra?: Partial<ResearchRun>) => {
      const current = runs.get(id)!;
      if (!expected.includes(current.status)) return false;
      runs.set(id, { ...current, ...extra, status, lifecycle: { ...current.lifecycle, ...extra?.lifecycle }, updatedAt: new Date().toISOString() });
      return true;
    },
    appendEvent: async () => ({ id: "EVT", timestamp: new Date().toISOString(), type: "info" as const, message: "event" }),
    addSource: async (id: string, source: ResearchRun["sources"][number]) => {
      const saved = { ...source, id: `SRC-${sequence}` };
      const run = runs.get(id)!;
      runs.set(id, { ...run, sources: [...run.sources, saved] });
      return saved;
    },
    updateSource: async (id: string, sourceId: string, patch: Partial<ResearchRun["sources"][number]>) => {
      const run = runs.get(id)!;
      runs.set(id, { ...run, sources: run.sources.map((source) => source.id === sourceId ? { ...source, ...patch } : source) });
    },
    setResults: async (id: string, results: NonNullable<ResearchRun["results"]>) => {
      const run = runs.get(id)!;
      runs.set(id, { ...run, results });
    },
    requestCancellation: async (id: string) => {
      const current = runs.get(id)!;
      if (["completed", "failed", "cancelled", "timed_out", "retry_exhausted"].includes(current.status)) return current;
      const updated = { ...current, status: "cancelling" as const, lifecycle: { ...current.lifecycle, cancellationRequestedAt: new Date().toISOString() } };
      runs.set(id, updated);
      return updated;
    },
    createRetryRun: async () => { throw new Error("not needed"); },
  };
  const taskStore = { getResearchStore: () => researchStore, getAsyncLayer: () => undefined } as unknown as TaskStore;
  const registry = new ResearchProviderRegistry({ defaultProvider: "mock", defaultModelId: "model" }, process.cwd());
  vi.spyOn(registry, "getAvailableProviders").mockReturnValue(["web-search", "llm-synthesis"]);
  vi.spyOn(registry, "refreshSettings").mockImplementation(() => undefined);
  vi.spyOn(registry, "createStepRunner").mockImplementation(() => new ResearchStepRunner({
    providers: [{
      type: "web-search",
      isConfigured: () => true,
      search: search ?? (async () => [{ id: "provider-source", type: "web", reference: "https://example.test", status: "completed" }]),
      fetchContent: async () => ({ content: "source content", metadata: {} }),
    }],
    ...(synthesisConfigured ? { synthesisRunner: async () => ({ output: "synthesized result", citations: ["https://example.test"] }) } : {}),
  }));
  return createResearchTools({ store: taskStore, rootDir: process.cwd(), getSettings: async () => ({ researchEnabled: true }) as never, createProviderRegistry: () => registry });
}

describe("research agent tools", () => {
  it("shows actionable sanitized diagnosis in get and list while legacy failures get a safe fallback", async () => {
    const classified = runFixture();
    const legacy = runFixture({ id: "RR-LEGACY", lifecycle: undefined, error: "token=legacy-secret" });
    const tools = toolsFor([classified, legacy]);

    const get = await execute(tools, "fn_research_get", { id: classified.id });
    expect(get.content[0]).toMatchObject({ type: "text" });
    expect((get.content[0] as { text: string }).text).toContain("MISSING_CREDENTIALS");
    expect(get.details).toMatchObject({ diagnosis: { classification: "configuration", code: "MISSING_CREDENTIALS", retryable: false } });

    const list = await execute(tools, "fn_research_list", {});
    expect((list.content[0] as { text: string }).text).toContain("MISSING_CREDENTIALS");
    expect((list.content[0] as { text: string }).text).toContain("INTERNAL_ERROR");
    expect(JSON.stringify({ get, list })).not.toContain("should-not-render");
    expect(JSON.stringify({ get, list })).not.toContain("legacy-secret");
  });

  it("leaves successful runs free of failure guidance", async () => {
    const completed = runFixture({
      id: "RR-OK",
      status: "completed",
      lifecycle: { terminalReason: "completed", retryable: false },
      error: undefined,
      results: { summary: "Useful result", findings: [], citations: [] },
    });
    const get = await execute(toolsFor([completed]), "fn_research_get", { id: completed.id });
    expect(get.details).toMatchObject({ status: "completed", error: null, diagnosis: null, summary: "Useful result" });
    expect((get.content[0] as { text: string }).text).not.toContain("Settings");
  });

  it("drives the no-network production tool path to completion when synthesis is composed", async () => {
    const result = await execute(productionShapedTools(true), "fn_research_run", { query: "q", wait_for_completion: true, max_wait_ms: 5_000 });
    expect(result.details).toMatchObject({ status: "completed", summary: "synthesized result", diagnosis: null });
    expect((result.content[0] as { text: string }).text).toContain("completed");
  });

  it("turns the historical missing-synthesis composition into actionable output", async () => {
    const result = await execute(productionShapedTools(false), "fn_research_run", { query: "q", wait_for_completion: true, max_wait_ms: 5_000 });
    expect(result.details).toMatchObject({ status: "failed", diagnosis: { code: "MISSING_CREDENTIALS", classification: "configuration", retryable: false } });
    expect((result.content[0] as { text: string }).text).toContain("Settings → Authentication");
    expect((result.content[0] as { text: string }).text).not.toContain("All synthesis rounds failed");
  });

  it("preserves cancellation when a provider resolves after the cancellation request", async () => {
    let releaseSearch!: (sources: ResearchRun["sources"]) => void;
    const search = () => new Promise<ResearchRun["sources"]>((resolve) => { releaseSearch = resolve; });
    const tools = productionShapedTools(true, search);

    const started = await execute(tools, "fn_research_run", { query: "q", wait_for_completion: false });
    const runId = (started.details as { runId: string }).runId;
    await vi.waitFor(() => expect(releaseSearch).toBeTypeOf("function"));
    const cancelled = await execute(tools, "fn_research_cancel", { id: runId });
    releaseSearch([{ id: "late", type: "web", reference: "https://example.test", status: "completed" }]);

    expect(cancelled.details).toMatchObject({ status: "cancelling" });
    await vi.waitFor(async () => {
      const detail = await execute(tools, "fn_research_get", { id: runId });
      expect(detail.details).toMatchObject({ status: "cancelled", diagnosis: { code: "RUN_CANCELLED" } });
    });
  });

  it("keeps a provider failure terminal when cancellation arrives afterward", async () => {
    const tools = productionShapedTools(false);
    const failed = await execute(tools, "fn_research_run", { query: "q", wait_for_completion: true, max_wait_ms: 5_000 });
    const runId = (failed.details as { runId: string }).runId;
    await execute(tools, "fn_research_cancel", { id: runId });
    const detail = await execute(tools, "fn_research_get", { id: runId });

    expect(detail.details).toMatchObject({ status: "failed", diagnosis: { code: "MISSING_CREDENTIALS" } });
  });

  it("uses the shared registry composition to provide synthesis and refresh model settings", async () => {
    const registry = new ResearchProviderRegistry({ defaultProvider: "mock", defaultModelId: "first" }, process.cwd());
    const synthesis = registry.getProvider("llm-synthesis") as { synthesize: ReturnType<typeof vi.fn> };
    synthesis.synthesize = vi.fn(async (_request, model) => ({ output: model.modelId, citations: [] }));

    const first = await registry.createStepRunner().runSynthesis({ query: "q", sources: [], round: 1 });
    expect(first.data?.output).toBe("first");

    registry.refreshSettings({ defaultProvider: "mock", defaultModelId: "second" });
    const refreshed = registry.getProvider("llm-synthesis") as { synthesize: ReturnType<typeof vi.fn> };
    refreshed.synthesize = vi.fn(async (_request, model) => ({ output: model.modelId, citations: [] }));
    const second = await registry.createStepRunner().runSynthesis({ query: "q", sources: [], round: 1 });
    expect(second.data?.output).toBe("second");
  });
});
