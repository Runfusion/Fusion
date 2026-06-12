import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDatabase, type Database, ResearchStore, type ResearchRun, type ResearchSource } from "@fusion/core";
import { ResearchOrchestrator } from "../research-orchestrator.js";

function createHarness() {
  const runs = new Map<string, ResearchRun>();
  const counter = { value: 0 };

  const store = {
    createRun: vi.fn((input: { query: string; providerConfig?: Record<string, unknown>; metadata?: Record<string, unknown> }) => {
      const id = `RR-test-${++counter.value}`;
      const now = new Date().toISOString();
      const run: ResearchRun = {
        id,
        query: input.query,
        status: "queued",
        providerConfig: input.providerConfig,
        sources: [],
        events: [],
        tags: [],
        metadata: input.metadata,
        createdAt: now,
        updatedAt: now,
      };
      runs.set(id, run);
      return run;
    }),
    getRun: vi.fn((id: string) => runs.get(id)),
    updateRun: vi.fn((id: string, patch: Partial<ResearchRun>) => {
      const run = runs.get(id);
      if (!run) return undefined;
      const next = { ...run, ...patch, updatedAt: new Date().toISOString() };
      runs.set(id, next);
      return next;
    }),
    addEvent: vi.fn((id: string, event: { type: string; message: string; metadata?: Record<string, unknown> }) => {
      const run = runs.get(id);
      if (!run) throw new Error("missing run");
      run.events.push({
        id: `evt-${run.events.length + 1}`,
        timestamp: new Date().toISOString(),
        type: event.type as never,
        message: event.message,
        metadata: event.metadata,
      });
      return run.events.at(-1)!;
    }),
    addSource: vi.fn((id: string, source: Omit<ResearchSource, "id">) => {
      const run = runs.get(id);
      if (!run) throw new Error("missing run");
      const created: ResearchSource = { ...source, id: `src-${run.sources.length + 1}` };
      run.sources.push(created);
      return created;
    }),
    updateSource: vi.fn((id: string, sourceId: string, patch: Partial<ResearchSource>) => {
      const run = runs.get(id);
      if (!run) throw new Error("missing run");
      run.sources = run.sources.map((s) => (s.id === sourceId ? { ...s, ...patch } : s));
    }),
    setResults: vi.fn((id: string, results: ResearchRun["results"]) => {
      const run = runs.get(id);
      if (!run) throw new Error("missing run");
      run.results = results;
    }),
    updateStatus: vi.fn((id: string, status: ResearchRun["status"], extra?: Partial<ResearchRun>) => {
      const run = runs.get(id);
      if (!run) throw new Error("missing run");
      runs.set(id, { ...run, ...extra, status });
    }),
    requestCancellation: vi.fn((id: string) => {
      const run = runs.get(id);
      if (!run) throw new Error("missing run");
      const next = { ...run, status: "cancelling" as ResearchRun["status"] };
      runs.set(id, next);
      return next;
    }),
  };

  const stepRunner = {
    runSourceQuery: vi.fn(async () => ({ ok: true, data: [{ type: "web", reference: "https://example.com", status: "pending" }] })),
    runContentFetch: vi.fn(async () => ({ ok: true, data: { content: "body", metadata: { lang: "en" } } })),
    runSynthesis: vi.fn(async () => ({ ok: true, data: { output: "summary", citations: ["src-1"], confidence: 0.9 } })),
  };

  return { store, stepRunner, runs };
}

describe("ResearchOrchestrator", () => {
  it("runs full lifecycle and completes", async () => {
    const { store, stepRunner } = createHarness();
    const orchestrator = new ResearchOrchestrator({
      store: store as never,
      stepRunner: stepRunner as never,
      maxConcurrentRuns: 2,
    });

    const runId = orchestrator.createRun({
      providers: [{ type: "web" }],
      maxSources: 2,
      maxSynthesisRounds: 1,
    });

    const run = await orchestrator.startRun(runId, "fusion research");
    expect(run.status).toBe("completed");
    expect(stepRunner.runSourceQuery).toHaveBeenCalledTimes(1);
    expect(stepRunner.runContentFetch).toHaveBeenCalledTimes(1);
    expect(stepRunner.runSynthesis).toHaveBeenCalledTimes(1);

    const status = orchestrator.getRunStatus(runId);
    expect(status.phase).toBe("completed");
  });

  it("normalizes dashboard string provider configs before searching", async () => {
    const { store, stepRunner } = createHarness();
    const orchestrator = new ResearchOrchestrator({
      store: store as never,
      stepRunner: stepRunner as never,
      maxConcurrentRuns: 2,
    });

    const run = store.createRun({
      query: "dashboard research",
      providerConfig: {
        providers: ["web-search", "page-fetch", "llm-synthesis"],
        maxResults: 3,
      },
    });

    const completed = await orchestrator.startRun(run.id, "dashboard research");
    expect(completed.status).toBe("completed");
    expect(stepRunner.runSourceQuery).toHaveBeenCalledTimes(2);
    expect(stepRunner.runSourceQuery).toHaveBeenNthCalledWith(1, "dashboard research", "web-search", undefined, expect.anything());
    expect(stepRunner.runSourceQuery).toHaveBeenNthCalledWith(2, "dashboard research", "page-fetch", undefined, expect.anything());
    expect(store.addEvent).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({
        message: "Search with web-search started",
      }),
    );
  });

  it("cancels a running run", async () => {
    const { store, stepRunner } = createHarness();
    stepRunner.runSourceQuery.mockImplementation(
      (async (_query: string, _provider: string, _config: unknown, signal?: AbortSignal) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
        return { ok: true, data: [] };
      }) as never,
    );

    const orchestrator = new ResearchOrchestrator({
      store: store as never,
      stepRunner: stepRunner as never,
      maxConcurrentRuns: 1,
    });

    const runId = orchestrator.createRun({
      providers: [{ type: "web" }],
      maxSources: 2,
      maxSynthesisRounds: 1,
    });

    const runPromise = orchestrator.startRun(runId, "cancel me");
    await Promise.resolve();
    expect(orchestrator.cancelRun(runId)).toBe(true);

    const run = await runPromise;
    expect(["cancelling", "cancelled"]).toContain(run.status);
  });

  it("records step failures and continues when later providers succeed", async () => {
    const { store, stepRunner } = createHarness();
    stepRunner.runSourceQuery
      .mockResolvedValueOnce({ ok: false, error: { code: "provider_error", message: "provider down" } } as never)
      .mockResolvedValueOnce({ ok: true, data: [{ type: "web", reference: "https://backup.com", status: "pending" }] } as never);

    const orchestrator = new ResearchOrchestrator({
      store: store as never,
      stepRunner: stepRunner as never,
      maxConcurrentRuns: 2,
    });

    const runId = orchestrator.createRun({
      providers: [{ type: "primary" }, { type: "backup" }],
      maxSources: 2,
      maxSynthesisRounds: 1,
    });

    const run = await orchestrator.startRun(runId, "fallback query");
    expect(run.status).toBe("completed");
    expect(stepRunner.runContentFetch).toHaveBeenCalledWith(
      "https://backup.com",
      "backup",
      undefined,
      expect.anything(),
    );
    expect(store.addEvent).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        type: "error",
        metadata: expect.objectContaining({ orchestrationEventType: "step-failed" }),
      }),
    );
  });

  it("continues with partial fetched sources when one fetch step fails", async () => {
    const { store, stepRunner } = createHarness();
    stepRunner.runSourceQuery.mockResolvedValueOnce({
      ok: true,
      data: [
        { type: "web", reference: "https://a.example", status: "pending" },
        { type: "web", reference: "https://b.example", status: "pending" },
      ],
    } as never);
    stepRunner.runContentFetch
      .mockResolvedValueOnce({ ok: false, error: { code: "provider_error", message: "fetch failed", retryable: true } } as never)
      .mockResolvedValueOnce({ ok: true, data: { content: "good", metadata: {} } } as never);

    const orchestrator = new ResearchOrchestrator({
      store: store as never,
      stepRunner: stepRunner as never,
      maxConcurrentRuns: 1,
    });

    const runId = orchestrator.createRun({
      providers: [{ type: "web" }],
      maxSources: 2,
      maxSynthesisRounds: 1,
    });

    const run = await orchestrator.startRun(runId, "partial fetch");
    expect(run.status).toBe("completed");
    expect(store.addEvent).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        type: "error",
        metadata: expect.objectContaining({ orchestrationEventType: "step-failed" }),
      }),
    );
    expect(store.setResults).toHaveBeenCalled();
  });

  it("emits step-failed for timeout-classified step errors", async () => {
    const { store, stepRunner } = createHarness();
    stepRunner.runSourceQuery
      .mockResolvedValueOnce({ ok: false, error: { code: "timeout", message: "search timed out" } } as never)
      .mockResolvedValueOnce({ ok: true, data: [{ type: "web", reference: "https://backup.com", status: "pending" }] } as never);

    const orchestrator = new ResearchOrchestrator({
      store: store as never,
      stepRunner: stepRunner as never,
      maxConcurrentRuns: 1,
    });

    const runId = orchestrator.createRun({
      providers: [{ type: "slow" }, { type: "backup" }],
      maxSources: 1,
      maxSynthesisRounds: 1,
    });

    await orchestrator.startRun(runId, "timeout query");
    expect(store.addEvent).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("failed"),
        metadata: expect.objectContaining({ orchestrationEventType: "step-failed" }),
      }),
    );
  });

  it("respects max concurrent run limit", async () => {
    const { store, stepRunner } = createHarness();
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    stepRunner.runSourceQuery.mockImplementationOnce(async () => {
      await firstBlocked;
      return { ok: true, data: [{ type: "web", reference: "https://example.com/a", status: "pending" }] };
    });

    const orchestrator = new ResearchOrchestrator({
      store: store as never,
      stepRunner: stepRunner as never,
      maxConcurrentRuns: 1,
    });

    const runA = orchestrator.createRun({ providers: [{ type: "web" }], maxSources: 1, maxSynthesisRounds: 1 });
    const runB = orchestrator.createRun({ providers: [{ type: "web" }], maxSources: 1, maxSynthesisRounds: 1 });

    const p1 = orchestrator.startRun(runA, "A");
    await Promise.resolve();
    const p2 = orchestrator.startRun(runB, "B");

    await Promise.resolve();
    expect(stepRunner.runSourceQuery).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await p1;
    await p2;
    expect(stepRunner.runSourceQuery).toHaveBeenCalledTimes(2);
  });

  it("persists provider-substitution lifecycle with real ResearchStore", async () => {
    const fusionDir = mkdtempSync(join(tmpdir(), "fn-research-orch-"));
    const db: Database = createDatabase(fusionDir, { inMemory: true });
    db.init();
    const store = new ResearchStore(db);

    const stepRunner = {
      runSourceQuery: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: { code: "provider_error", message: "primary down", retryable: true } })
        .mockResolvedValueOnce({
          ok: true,
          data: [{ type: "web", reference: "https://backup.example", status: "pending", metadata: { origin: "backup" } }],
        }),
      runContentFetch: vi.fn(async () => ({ ok: true, data: { content: "backup content", metadata: { fetchedBy: "backup" } } })),
      runSynthesis: vi.fn(async () => ({ ok: true, data: { output: "summary", citations: ["src-1"], confidence: 0.7 } })),
    };

    const orchestrator = new ResearchOrchestrator({
      store,
      stepRunner,
      maxConcurrentRuns: 1,
    });

    const runId = orchestrator.createRun({
      providers: [{ type: "primary" }, { type: "backup" }],
      maxSources: 2,
      maxSynthesisRounds: 1,
    });

    const run = await orchestrator.startRun(runId, "provider substitution");
    expect(run.status).toBe("completed");

    const persisted = store.getRun(runId)!;
    expect(persisted.sources).toHaveLength(1);
    expect(persisted.sources[0].metadata?.providerType).toBe("backup");
    expect(stepRunner.runContentFetch).toHaveBeenCalledWith(
      "https://backup.example",
      "backup",
      undefined,
      expect.anything(),
    );

    const runEvents = store.listRunEvents(runId);
    expect(runEvents.some((event) => event.status === "completed")).toBe(true);
    expect(persisted.events.some((event) => event.metadata?.orchestrationEventType === "step-failed")).toBe(true);
    expect(persisted.results?.summary).toBe("summary");
  });

  it("retries failed run with inherited config", () => {
    const { store } = createHarness();
    const orchestrator = new ResearchOrchestrator({
      store: store as never,
      stepRunner: {
        runSourceQuery: vi.fn(),
        runContentFetch: vi.fn(),
        runSynthesis: vi.fn(),
      },
    });

    const baseId = orchestrator.createRun({
      providers: [{ type: "web", config: { timeoutMs: 1000 } }],
      maxSources: 1,
      maxSynthesisRounds: 1,
    });
    store.updateStatus(baseId, "failed", { error: "boom" });

    const retryId = orchestrator.retryRun(baseId);
    expect(retryId).not.toBe(baseId);
    const retried = store.getRun(retryId)!;
    expect(retried.metadata?.retryOfRunId).toBe(baseId);
  });
});
