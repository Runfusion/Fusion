import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, type Database } from "../db.js";
import { ResearchLifecycleError, ResearchStore } from "../research-store.js";

describe("ResearchStore", () => {
  let db: Database;
  let store: ResearchStore;

  beforeEach(() => {
    const fusionDir = mkdtempSync(join(tmpdir(), "fn-research-test-"));
    db = createDatabase(fusionDir, { inMemory: true });
    db.init();
    store = new ResearchStore(db);
  });

  it("creates, gets, updates, lists and deletes runs", () => {
    const run = store.createRun({ query: "test topic", tags: ["a"] });
    expect(run.id).toMatch(/^RR-/);
    expect(store.getRun(run.id)?.query).toBe("test topic");

    const updated = store.updateRun(run.id, { topic: "new topic", error: "oops" });
    expect(updated?.topic).toBe("new topic");

    const listed = store.listRuns({ status: "pending" });
    expect(listed.map((r) => r.id)).toContain(run.id);

    expect(store.deleteRun(run.id)).toBe(true);
    expect(store.getRun(run.id)).toBeUndefined();
    expect(store.deleteRun("RR-missing")).toBe(false);
  });

  it("handles status transitions with lifecycle timestamps", () => {
    const run = store.createRun({ query: "status test" });
    store.updateStatus(run.id, "running");
    const running = store.getRun(run.id)!;
    expect(running.startedAt).toBeTruthy();

    store.updateStatus(run.id, "completed");
    const completed = store.getRun(run.id)!;
    expect(completed.completedAt).toBeTruthy();

    const failed = store.createRun({ query: "failure" });
    store.updateStatus(failed.id, "failed");
    expect(store.getRun(failed.id)?.completedAt).toBeTruthy();

    const cancelled = store.createRun({ query: "cancel" });
    store.updateStatus(cancelled.id, "cancelled");
    expect(store.getRun(cancelled.id)?.cancelledAt).toBeTruthy();
  });

  it("enforces terminal immutability and valid transitions", () => {
    const run = store.createRun({ query: "guarded" });
    store.updateStatus(run.id, "running");
    store.updateStatus(run.id, "completed");

    expect(() => store.updateRun(run.id, { topic: "changed" })).toThrow(ResearchLifecycleError);

    const pending = store.createRun({ query: "pending" });
    expect(() => store.updateStatus(pending.id, "completed")).toThrow(/Invalid run status transition/i);
  });

  it("persists lifecycle events to research_run_events", () => {
    const run = store.createRun({ query: "events" });
    store.updateStatus(run.id, "running");
    store.appendLifecycleEvent(run.id, { type: "info", message: "custom event" });

    const events = store.listRunEvents(run.id);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)?.message).toBe("custom event");
  });

  it("guards against duplicate active runs per project and trigger", () => {
    const run = store.createRun({ query: "r1", projectId: "p1", trigger: "manual" });
    expect(store.getActiveRun("p1", "manual")?.id).toBe(run.id);
    expect(() => store.assertNoActiveRun("p1", "manual")).toThrow(ResearchLifecycleError);

    store.updateStatus(run.id, "cancelled");
    expect(() => store.assertNoActiveRun("p1", "manual")).not.toThrow();
  });

  it("appends events, manages sources, and sets results", () => {
    const run = store.createRun({ query: "events" });
    const event = store.appendEvent(run.id, { type: "info", message: "started" });
    expect(event.id).toMatch(/^REVT-/);

    const source = store.addSource(run.id, {
      type: "web",
      reference: "https://example.com",
      status: "pending",
    });

    store.updateSource(run.id, source.id, { status: "completed", title: "Example" });
    store.setResults(run.id, {
      summary: "Done",
      findings: [{ heading: "H1", content: "C1", sources: [source.id], confidence: 0.8 }],
    });

    const next = store.getRun(run.id)!;
    expect(next.events).toHaveLength(1);
    expect(next.sources[0].status).toBe("completed");
    expect(next.results?.summary).toBe("Done");
  });

  it("supports filtering, search, ordering, exports and stats", () => {
    const r1 = store.createRun({ query: "alpha", topic: "first", tags: ["core"] });
    const r2 = store.createRun({ query: "beta", topic: "second", tags: ["edge"] });
    store.setResults(r2.id, { summary: "beta summary", findings: [] });

    expect(store.listRuns({ tag: "core" }).map((r) => r.id)).toEqual([r1.id]);
    expect(store.searchRuns("beta").map((r) => r.id)).toContain(r2.id);

    const all = store.listRuns();
    expect(all[0].createdAt <= all[1].createdAt).toBe(true);

    const ex = store.createExport(r1.id, "json", "{}");
    expect(store.getExports(r1.id)).toHaveLength(1);
    expect(store.getExport(ex.id)?.runId).toBe(r1.id);
    expect(store.getExport("REXP-missing")).toBeUndefined();

    store.updateStatus(r1.id, "running");
    store.updateStatus(r2.id, "running");
    store.updateStatus(r2.id, "completed");
    const stats = store.getStats();
    expect(stats.total).toBeGreaterThanOrEqual(2);
    expect(stats.byStatus.completed).toBeGreaterThanOrEqual(1);

    store.deleteRun(r1.id);
    expect(store.getExports(r1.id)).toHaveLength(0);
  });

  it("emits status events and throws for missing run mutations", () => {
    const onStatus = vi.fn();
    const onCompleted = vi.fn();
    store.on("run:status_changed", onStatus);
    store.on("run:completed", onCompleted);

    const run = store.createRun({ query: "events" });
    store.updateStatus(run.id, "running");
    store.updateStatus(run.id, "completed");
    expect(onStatus).toHaveBeenCalled();
    expect(onCompleted).toHaveBeenCalled();

    expect(() => store.appendEvent("missing", { type: "info", message: "x" })).toThrow(/not found/i);
    expect(() => store.addSource("missing", { type: "web", reference: "x", status: "pending" })).toThrow(/not found/i);
    expect(() => store.setResults("missing", { findings: [] })).toThrow(/not found/i);
  });
});
