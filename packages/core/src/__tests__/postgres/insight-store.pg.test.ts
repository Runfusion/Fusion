/**
 * FNXC:InsightStore 2026-06-27-09:10:
 * PostgreSQL integration coverage for the InsightStore port. `store.getInsightStore()`
 * previously THREW "InsightStore is not available in PG backend mode" (the dashboard
 * /api/insights routes 503'd); it now returns the AsyncDataLayer-backed
 * AsyncInsightStore. This drives the real wiring (getInsightStoreImpl → AsyncInsightStore)
 * through the shared PG harness and asserts: fingerprint-dedup upsert (preserved id +
 * createdAt), run → event auto-seq → listRunEvents, updateRun terminal completion
 * (auto-completedAt), terminal-immutability + invalid-transition lifecycle errors,
 * countInsights/listInsights agreement, and findActiveRun. Runs in the blocking
 * gate (test:pg-gate).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { InsightLifecycleError } from "../../insight-store.js";
import type { AsyncInsightStore } from "../../async-insight-store.js";

const pgTest = pgDescribe;

pgTest("InsightStore (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_insight_store",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // In backend mode getInsightStore() returns AsyncInsightStore (async methods).
  const insights = (): AsyncInsightStore => h.store().getInsightStore() as AsyncInsightStore;

  it("does not throw when resolving the store in backend mode", () => {
    expect(h.store().backendMode).toBe(true);
    expect(() => insights()).not.toThrow();
  });

  it("upsertInsight dedups by (projectId, fingerprint), preserving id and createdAt", async () => {
    const s = insights();
    const first = await s.upsertInsight("P-INS", {
      title: "Use prepared statements",
      content: "v1",
      category: "security",
      fingerprint: "FP-1",
    });
    expect(first.id).toMatch(/^INS-/);

    const second = await s.upsertInsight("P-INS", {
      title: "Use prepared statements",
      content: "v2-updated",
      category: "security",
      fingerprint: "FP-1",
    });
    // Same fingerprint → same row: id and createdAt preserved, content updated.
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.content).toBe("v2-updated");

    // Only one insight exists for the fingerprint.
    const all = await s.listInsights({ projectId: "P-INS" });
    expect(all).toHaveLength(1);
  });

  it("countInsights agrees with listInsights for a filtered set", async () => {
    const s = insights();
    await s.upsertInsight("P-CNT", { title: "A", category: "quality", fingerprint: "A" });
    await s.upsertInsight("P-CNT", { title: "B", category: "quality", fingerprint: "B" });
    await s.upsertInsight("P-CNT", { title: "C", category: "performance", fingerprint: "C" });

    const quality = await s.listInsights({ projectId: "P-CNT", category: "quality" });
    const qualityCount = await s.countInsights({ projectId: "P-CNT", category: "quality" });
    expect(quality).toHaveLength(2);
    expect(qualityCount).toBe(2);
  });

  it("createRun → appendRunEvent (auto-seq) → listRunEvents → updateRun completes with completedAt", async () => {
    const s = insights();
    const run = await s.createRun("P-RUN", { trigger: "manual" });
    expect(run.id).toMatch(/^INSR-/);
    expect(run.status).toBe("pending");

    const e1 = await s.appendRunEvent(run.id, { type: "info", message: "started" });
    const e2 = await s.appendRunEvent(run.id, { type: "info", message: "progress" });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);

    const events = await s.listRunEvents(run.id);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.map((e) => e.message)).toEqual(["started", "progress"]);

    // findActiveRun returns the pending run.
    const active = await s.findActiveRun("P-RUN", "manual");
    expect(active?.id).toBe(run.id);

    const completed = await s.updateRun(run.id, { status: "completed", summary: "done" });
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAt).toBeTruthy();

    // No longer active once terminal.
    expect(await s.findActiveRun("P-RUN", "manual")).toBeUndefined();
  });

  it("updateRun on a terminal run throws InsightLifecycleError(terminal_immutable)", async () => {
    const s = insights();
    const run = await s.createRun("P-TERM", { trigger: "manual" });
    await s.updateRun(run.id, { status: "failed", error: "boom" });

    await expect(s.updateRun(run.id, { summary: "late edit" })).rejects.toMatchObject({
      name: "InsightLifecycleError",
      code: "terminal_immutable",
    });
  });

  it("updateRun rejects an invalid status transition with invalid_transition", async () => {
    const s = insights();
    const run = await s.createRun("P-INV", { trigger: "manual" });
    await s.updateRun(run.id, { status: "running" });
    // running → pending is not a valid transition.
    let caught: unknown;
    try {
      await s.updateRun(run.id, { status: "pending" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InsightLifecycleError);
    expect((caught as InsightLifecycleError).code).toBe("invalid_transition");
  });
});
