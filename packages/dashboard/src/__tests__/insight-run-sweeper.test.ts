import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InsightStore, createDatabase } from "@fusion/core";
import {
  ORPHAN_GRACE_MS,
  recoverOrphanedInsightRun,
  startInsightRunSweeper,
  sweepStaleInsightRuns,
} from "../insight-run-sweeper.js";

describe("insight-run-sweeper", () => {
  let store: InsightStore;
  let controllers: Map<string, AbortController>;
  let tmpDir: string;

  beforeEach(() => {
    // Database constructor rejects relative fusionDir paths (including
    // ":memory:") unless inMemory is explicitly opted in. Pass a real
    // tmp path alongside inMemory so the SQLite handle remains in-RAM.
    tmpDir = mkdtempSync(join(tmpdir(), "kb-insight-sweeper-"));
    const db = createDatabase(tmpDir, { inMemory: true });
    db.init();
    store = new InsightStore(db);
    controllers = new Map<string, AbortController>();
  });

  afterEach(() => {
    vi.useRealTimers();
    store.getDatabase().close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips runs younger than graceMs", () => {
    const run = store.createRun("proj", { trigger: "manual" });
    const now = new Date(new Date(run.createdAt).getTime() + ORPHAN_GRACE_MS - 1);

    const result = sweepStaleInsightRuns({
      insightStore: store,
      activeRunControllers: controllers,
      now,
      graceMs: ORPHAN_GRACE_MS,
      source: "drive_by",
    });

    expect(result).toEqual({ scanned: 0, recovered: 0, skipped: 0 });
    expect(store.getRun(run.id)?.status).toBe("pending");
  });

  it("skips runs with active controllers", () => {
    const run = store.createRun("proj", { trigger: "manual" });
    controllers.set(run.id, new AbortController());

    const result = sweepStaleInsightRuns({
      insightStore: store,
      activeRunControllers: controllers,
      now: new Date(new Date(run.createdAt).getTime() + ORPHAN_GRACE_MS + 1000),
      source: "startup",
    });

    expect(result).toEqual({ scanned: 1, recovered: 0, skipped: 1 });
    expect(store.getRun(run.id)?.status).toBe("pending");
  });

  it("recovers eligible runs and emits recovery metadata", () => {
    const run = store.createRun("proj", { trigger: "manual" });
    store.updateRun(run.id, {
      status: "running",
      startedAt: "2025-01-01T00:00:00.000Z",
    });

    const recoverResult = recoverOrphanedInsightRun({
      insightStore: store,
      run: store.getRun(run.id),
      now: new Date("2025-01-01T01:00:00.000Z"),
      activeRunControllers: controllers,
      source: "periodic",
      graceMs: ORPHAN_GRACE_MS,
    });

    expect(recoverResult).toEqual({ recovered: true });

    const updated = store.getRun(run.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.lifecycle.terminalCause).toBe("orphaned_active_run_recovered");
    expect(updated?.lifecycle.failureClass).toBe("non_retryable");
    expect(updated?.lifecycle.retryable).toBe(false);

    const events = store.listRunEvents(run.id);
    const warning = events.find((event) => event.type === "warning");
    const statusChanged = events.find((event) => event.type === "status_changed");

    expect(warning?.metadata?.recoverySource).toBe("periodic");
    expect(statusChanged?.metadata?.recoverySource).toBe("periodic");
  });

  it("returns accurate scanned/recovered/skipped counts", () => {
    const recoverable = store.createRun("proj", { trigger: "manual" });
    const withController = store.createRun("proj", { trigger: "schedule" });
    controllers.set(withController.id, new AbortController());

    const result = sweepStaleInsightRuns({
      insightStore: store,
      activeRunControllers: controllers,
      now: new Date(new Date(recoverable.createdAt).getTime() + ORPHAN_GRACE_MS + 10_000),
      source: "drive_by",
    });

    expect(result).toEqual({ scanned: 2, recovered: 1, skipped: 1 });
  });

  it("runs periodic sweeps and dispose stops interval", () => {
    vi.useFakeTimers();

    const first = store.createRun("proj", { trigger: "manual" });
    const logger = { warn: vi.fn() };
    const sweeper = startInsightRunSweeper({
      insightStore: store,
      activeRunControllers: controllers,
      intervalMs: 1_000,
      graceMs: 0,
      logger,
    });

    vi.advanceTimersByTime(1_000);
    expect(store.getRun(first.id)?.status).toBe("failed");

    const second = store.createRun("proj", { trigger: "manual" });
    sweeper.dispose();
    vi.advanceTimersByTime(2_000);

    expect(store.getRun(second.id)?.status).toBe("pending");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
