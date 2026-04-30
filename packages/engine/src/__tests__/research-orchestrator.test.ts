import { describe, expect, it, vi } from "vitest";
import type { ResearchRun, ResearchSource } from "@fusion/core";
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
        status: "pending",
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
    expect(run.status).toBe("cancelled");
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
    expect(store.addEvent).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        type: "error",
        metadata: expect.objectContaining({ orchestrationEventType: "step-failed" }),
      }),
    );
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
