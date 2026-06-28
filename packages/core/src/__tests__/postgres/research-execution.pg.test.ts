/**
 * FNXC:ResearchStore 2026-06-28-11:40:
 * PostgreSQL integration coverage for the research-run EXECUTION store-access path.
 * A created research run previously stayed "queued" forever in PG backend mode because
 * the engine's ResearchOrchestrator/ResearchRunDispatcher were instanceof-gated to the
 * sync EventEmitter ResearchStore and called its methods synchronously. The orchestrator
 * now types `store` as `ResearchStore | AsyncResearchStore` and `await`s every store call,
 * so a queued run advances queued→running→completed (or →failed on a thrown step) and the
 * status/results/events PERSIST through the AsyncDataLayer-backed AsyncResearchStore.
 *
 * This drives the REAL engine ResearchOrchestrator (imported from engine SOURCE so it
 * reflects the current port, not a possibly-stale dist build) against embedded PG with a
 * STUBBED step runner (NO real AI / network). It asserts:
 *   - happy path: queued→running→completed, results persisted (summary/findings/citations),
 *     a source persisted, startedAt/completedAt set, phase-changed events recorded.
 *   - failure path: a step runner that yields no sources drives the run to a persisted
 *     `failed` status with an error event (mirrors "no provider configured" failing cleanly
 *     instead of throwing an unhandled error).
 * Intended for the blocking PG gate (the orchestrator wires it into package.json).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { AsyncResearchStore } from "../../async-research-store.js";
import type {
  ResearchModelSettings,
  ResearchProviderConfig,
  ResearchSource,
  ResearchSynthesisRequest,
} from "../../research-types.js";
// Import the orchestrator from engine SOURCE (not the @fusion/engine barrel, which resolves
// to a possibly-stale dist build) so this test exercises the current await-converted port.
import {
  ResearchOrchestrator,
  type ResearchStepRunnerApi,
} from "../../../../engine/src/research-orchestrator.js";

const pgTest = pgDescribe;

/**
 * Stub step runner implementing ResearchStepRunnerApi with NO AI/network. The `mode`
 * controls whether search yields a source (happy path) or returns empty (failure path —
 * the orchestrator throws "No sources discovered" internally and persists `failed`).
 */
function makeStubStepRunner(mode: "ok" | "no-sources"): ResearchStepRunnerApi {
  return {
    async runSourceQuery(_query: string, _providerType: string, _config?: ResearchProviderConfig) {
      if (mode === "no-sources") {
        return { ok: true as const, data: [] as ResearchSource[] };
      }
      const source: ResearchSource = {
        id: "stub-source-1",
        type: "web",
        reference: "https://example.com/a",
        title: "Example A",
        status: "pending",
      };
      return { ok: true as const, data: [source] };
    },
    async runContentFetch(_url: string, _providerType?: string, _config?: ResearchProviderConfig) {
      return { ok: true as const, data: { content: "stub content body", metadata: { fetched: true } } };
    },
    async runSynthesis(_request: ResearchSynthesisRequest, _model?: ResearchModelSettings) {
      return {
        ok: true as const,
        data: { output: "final synthesized report", citations: ["https://example.com/a"], confidence: 0.9 },
      };
    },
  };
}

pgTest("Research run execution (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_research_exec",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // In backend mode getResearchStore() returns AsyncResearchStore (async methods).
  const research = (): AsyncResearchStore => h.store().getResearchStore() as AsyncResearchStore;

  it("advances a queued run through running → completed and persists results via AsyncResearchStore", async () => {
    const store = research();
    const orchestrator = new ResearchOrchestrator({
      store,
      stepRunner: makeStubStepRunner("ok"),
      maxConcurrentRuns: 1,
    });

    const runId = await orchestrator.createRun({
      providers: [{ type: "stub" }],
      maxSources: 1,
      maxSynthesisRounds: 1,
    });

    // Created run starts queued and persists through the async store.
    const queued = await store.getRun(runId);
    expect(queued?.status).toBe("queued");

    const finished = await orchestrator.startRun(runId, "What is PostgreSQL?");
    expect(finished.status).toBe("completed");

    // Re-read independently: lifecycle + results persisted through AsyncResearchStore.
    const reloaded = await store.getRun(runId);
    expect(reloaded?.status).toBe("completed");
    expect(reloaded?.startedAt).toBeTruthy();
    expect(reloaded?.completedAt).toBeTruthy();
    expect(reloaded?.results?.summary).toBe("final synthesized report");
    expect(reloaded?.results?.citations).toContain("https://example.com/a");
    expect(reloaded?.results?.findings?.length ?? 0).toBeGreaterThan(0);

    // A source was discovered + fetched and persisted.
    expect(reloaded?.sources?.length ?? 0).toBeGreaterThan(0);

    // Orchestration events recorded (phase transitions go through appendEvent).
    const events = await store.listRunEvents(runId);
    const phases = events
      .filter((e) => e.metadata?.orchestrationEventType === "phase-changed")
      .map((e) => e.metadata?.phase);
    expect(phases).toContain("searching");
    expect(phases).toContain("completed");

    // Status reflected by getRunStatus (now async).
    const status = await orchestrator.getRunStatus(runId);
    expect(status.status).toBe("completed");
  });

  it("persists a failed status when a step yields no sources (clean failure, no unhandled throw)", async () => {
    const store = research();
    const orchestrator = new ResearchOrchestrator({
      store,
      stepRunner: makeStubStepRunner("no-sources"),
      maxConcurrentRuns: 1,
    });

    const runId = await orchestrator.createRun({
      providers: [{ type: "stub" }],
      maxSources: 1,
      maxSynthesisRounds: 1,
    });

    // startRun resolves (does not reject) even though the run fails internally.
    const finished = await orchestrator.startRun(runId, "query with no sources");
    expect(finished.status).toBe("failed");
    expect(finished.error).toBeTruthy();

    const reloaded = await store.getRun(runId);
    expect(reloaded?.status).toBe("failed");

    const events = await store.listRunEvents(runId);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});
