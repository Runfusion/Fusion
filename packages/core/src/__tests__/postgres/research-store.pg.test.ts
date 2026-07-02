/**
 * FNXC:ResearchStore 2026-06-27-12:50:
 * PostgreSQL integration coverage for the ResearchStore (U4) port. `store.getResearchStore()`
 * previously THREW "ResearchStore is not available in PG backend mode" (the dashboard
 * /api/research routes 503'd); it now returns the AsyncDataLayer-backed AsyncResearchStore.
 * This drives the real wiring (getResearchStoreImpl → AsyncResearchStore) through the shared
 * PG harness and asserts the dashboard-critical surface: queued→running→completed lifecycle
 * auto-fields, invalid-transition + terminal-immutability lifecycle errors, dual-write events
 * (run.events jsonb), source/results round-trip, search, stats, exports, and the retry gate +
 * lineage (within cap → retry_waiting child; over cap → retry_exhausted + not_retryable;
 * non-failed → invalid_transition). Runs in the blocking gate (test:pg-gate).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { ResearchLifecycleError } from "../../research-store.js";
import type { AsyncResearchStore } from "../../async-research-store.js";

const pgTest = pgDescribe;

pgTest("ResearchStore (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_research_store",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // In backend mode getResearchStore() returns AsyncResearchStore (async methods).
  const research = (): AsyncResearchStore => h.store().getResearchStore() as AsyncResearchStore;

  it("does not throw when resolving the store in backend mode", () => {
    expect(h.store().backendMode).toBe(true);
    expect(() => research()).not.toThrow();
  });

  it("createRun is queued → running sets startedAt → completed sets completedAt + retryable=false", async () => {
    const s = research();
    const run = await s.createRun({ query: "What is RAG?", topic: "RAG" });
    expect(run.id).toMatch(/^RR-/);
    expect(run.status).toBe("queued");

    await s.updateStatus(run.id, "running");
    const running = await s.getRun(run.id);
    expect(running?.status).toBe("running");
    expect(running?.startedAt).toBeTruthy();

    await s.updateStatus(run.id, "completed");
    const completed = await s.getRun(run.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAt).toBeTruthy();
    expect(completed?.lifecycle?.retryable).toBe(false);
    expect(completed?.lifecycle?.terminalReason).toBe("completed");
  });

  it("rejects an invalid status transition with ResearchLifecycleError(invalid_transition)", async () => {
    const s = research();
    const run = await s.createRun({ query: "invalid transition" });
    // queued → completed is not a valid transition.
    let caught: unknown;
    try {
      await s.updateStatus(run.id, "completed");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResearchLifecycleError);
    expect((caught as ResearchLifecycleError).code).toBe("invalid_transition");
  });

  it("a terminal run is immutable for non-event/non-metadata fields", async () => {
    const s = research();
    const run = await s.createRun({ query: "terminal immutable" });
    await s.updateStatus(run.id, "running");
    await s.updateStatus(run.id, "completed");

    await expect(s.updateRun(run.id, { query: "late edit" })).rejects.toMatchObject({
      name: "ResearchLifecycleError",
      code: "terminal_immutable",
    });
  });

  it("appendEvent dual-writes: the event appears in getRun().events", async () => {
    const s = research();
    const run = await s.createRun({ query: "dual write events" });
    const e1 = await s.appendEvent(run.id, { type: "info", message: "started" });
    const e2 = await s.appendEvent(run.id, { type: "progress", message: "halfway" });
    expect(e1.id).toMatch(/^REVT-/);

    const reloaded = await s.getRun(run.id);
    expect(reloaded?.events.map((e) => e.message)).toEqual(["started", "halfway"]);

    const events = await s.listRunEvents(run.id);
    // status_changed lifecycle events are not appended here; only the two info/progress events.
    expect(events.map((e) => e.message)).toContain("started");
    expect(events.map((e) => e.message)).toContain("halfway");
    expect(e2.message).toBe("halfway");
  });

  it("addSource and setResults round-trip via getRun", async () => {
    const s = research();
    const run = await s.createRun({ query: "sources and results" });
    const source = await s.addSource(run.id, {
      type: "web",
      reference: "https://example.com",
      title: "Example",
      status: "completed",
    });
    expect(source.id).toMatch(/^RSRC-/);

    await s.setResults(run.id, { summary: "A short summary", findings: [] });

    const reloaded = await s.getRun(run.id);
    expect(reloaded?.sources).toHaveLength(1);
    expect(reloaded?.sources[0]?.reference).toBe("https://example.com");
    expect(reloaded?.results?.summary).toBe("A short summary");
  });

  it("searchRuns matches query/topic/summary", async () => {
    const s = research();
    await s.createRun({ query: "quantum entanglement basics", topic: "physics" });
    const withSummary = await s.createRun({ query: "unrelated alpha" });
    await s.setResults(withSummary.id, { summary: "discusses quantum tunneling", findings: [] });

    const byQuery = await s.searchRuns("quantum entanglement");
    expect(byQuery.length).toBeGreaterThanOrEqual(1);
    expect(byQuery.some((r) => r.query.includes("quantum entanglement"))).toBe(true);

    const bySummary = await s.searchRuns("tunneling");
    expect(bySummary.map((r) => r.id)).toContain(withSummary.id);
  });

  it("getStats groups by status", async () => {
    const s = research();
    const a = await s.createRun({ query: "stats a" });
    const b = await s.createRun({ query: "stats b" });
    await s.updateStatus(a.id, "running");

    const stats = await s.getStats();
    expect(stats.total).toBeGreaterThanOrEqual(2);
    expect(stats.byStatus.running).toBeGreaterThanOrEqual(1);
    expect(stats.byStatus.queued).toBeGreaterThanOrEqual(1);
    expect(b.status).toBe("queued");
  });

  it("createExport → getExports → getExport round-trip", async () => {
    const s = research();
    const run = await s.createRun({ query: "export round-trip" });
    const created = await s.createExport(run.id, "markdown", "# Hello");
    expect(created.id).toMatch(/^REXP-/);

    const exports = await s.getExports(run.id);
    expect(exports).toHaveLength(1);
    expect(exports[0]?.content).toBe("# Hello");

    const fetched = await s.getExport(created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.format).toBe("markdown");
  });

  it("retry gate: a failed retryable run within cap creates a lineage-linked retry_waiting run", async () => {
    const s = research();
    const run = await s.createRun({ query: "retry within cap", lifecycle: { attempt: 1, maxAttempts: 3 } });
    await s.updateStatus(run.id, "running");
    // Fail as a retryable transient so lifecycle.retryable === true.
    await s.updateStatus(run.id, "failed", { lifecycle: { failureClass: "retryable_transient" } });

    const failed = await s.getRun(run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.lifecycle?.retryable).toBe(true);

    const retry = await s.createRetryRun(run.id);
    expect(retry.status).toBe("retry_waiting");
    expect(retry.lifecycle?.attempt).toBe(2);
    expect(retry.lifecycle?.retryOfRunId).toBe(run.id);
    expect(retry.lifecycle?.rootRunId).toBe(run.id);
  });

  it("retry gate: exceeding the cap moves the source to retry_exhausted and throws not_retryable", async () => {
    const s = research();
    const run = await s.createRun({ query: "retry over cap", lifecycle: { attempt: 3, maxAttempts: 3 } });
    await s.updateStatus(run.id, "running");
    await s.updateStatus(run.id, "failed", { lifecycle: { failureClass: "retryable_transient" } });

    let caught: unknown;
    try {
      await s.createRetryRun(run.id);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResearchLifecycleError);
    expect((caught as ResearchLifecycleError).code).toBe("not_retryable");

    const exhausted = await s.getRun(run.id);
    expect(exhausted?.status).toBe("retry_exhausted");
    expect(exhausted?.lifecycle?.errorCode).toBe("RETRY_EXHAUSTED");
  });

  it("retry gate: retrying a non-failed run throws invalid_transition", async () => {
    const s = research();
    const run = await s.createRun({ query: "retry non-failed" });
    // queued (not failed/timed_out) → not retryable.
    let caught: unknown;
    try {
      await s.createRetryRun(run.id);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResearchLifecycleError);
    expect((caught as ResearchLifecycleError).code).toBe("invalid_transition");
  });

  it("deleteRun removes the run", async () => {
    const s = research();
    const run = await s.createRun({ query: "to be deleted" });
    expect(await s.deleteRun(run.id)).toBe(true);
    expect(await s.getRun(run.id)).toBeUndefined();
    expect(await s.deleteRun(run.id)).toBe(false);
  });
});
