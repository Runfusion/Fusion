/**
 * FNXC:PostgresBackend 2026-06-27-00:40:
 * PostgreSQL-backed integration coverage for two surfaces that crashed/500'd in
 * embedded-PG mode after the SQLite→Postgres migration and had NO pg.test.ts:
 *
 *   1. Agent-log buffer flush/append — the SQLite-only `store.db` getter throws
 *      in backend mode; the flush ran on a retry timer + catch handlers, so a
 *      handled error became an uncaught throw that exited `fn serve` (~35s).
 *      getAgentLogs() flushes the buffer internally, so these tests exercise the
 *      exact crash path against a real AsyncDataLayer.
 *   2. aggregateActivityAnalytics / aggregateMonitorMetrics — the deployments
 *      read referenced `deployments` unqualified (real table: project.deployments)
 *      and sat outside the try/catch, 500'ing /api/command-center/activity.
 *
 * These run in the blocking gate (`@fusion/core test:pg-gate`) so the class can
 * no longer merge green. Auto-skipped via pgDescribe when PostgreSQL is absent.
 */

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { aggregateActivityAnalytics } from "../../activity-analytics.js";

const pgTest = pgDescribe;

pgTest("agent-log buffer + monitor metrics (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_logs_monitor",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // Agent logs persist to per-task JSONL files on disk, which the harness's
  // TRUNCATE ... RESTART IDENTITY does NOT clear — and the reset identity counter
  // can re-hand the same auto id to a later test, colliding task dirs. Use a
  // distinct reserved id per test so each owns an isolated task dir.
  it("appendAgentLog + flush persists every entry without crashing", async () => {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: "log target", column: "todo" },
      { taskId: "FN-LOG-SINGLE", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", applyDefaultWorkflowSteps: false },
    );

    await store.appendAgentLog("FN-LOG-SINGLE", "line one", "text");
    await store.appendAgentLog("FN-LOG-SINGLE", "line two", "tool", "readme.md", "executor");

    // flushAgentLogBuffer is the path that threw on store.db in PG mode; assert
    // it is a no-throw and the entries are durably readable from the JSONL.
    expect(() => store.flushAgentLogBuffer()).not.toThrow();
    const entries = await store.getAgentLogs("FN-LOG-SINGLE");
    expect(entries.map((e) => e.text)).toEqual(["line one", "line two"]);
  });

  it("appendAgentLogBatch persists every entry without crashing", async () => {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: "batch target", column: "todo" },
      { taskId: "FN-LOG-BATCH", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", applyDefaultWorkflowSteps: false },
    );

    await store.appendAgentLogBatch([
      { taskId: "FN-LOG-BATCH", text: "a", type: "text" },
      { taskId: "FN-LOG-BATCH", text: "b", type: "text" },
    ]);

    const entries = await store.getAgentLogs("FN-LOG-BATCH");
    expect(entries.map((e) => e.text)).toEqual(["a", "b"]);
  });

  it("aggregateActivityAnalytics resolves against real Postgres (no deployments 500)", async () => {
    // Was a 500: the deployments read referenced an unqualified relation outside
    // any try/catch. Must resolve with a well-formed (empty) monitor block.
    const result = await aggregateActivityAnalytics(h.layer(), {
      from: "2026-06-20",
      to: "2026-06-27",
    });

    expect(result).toBeDefined();
    expect(result.monitor.deployments).toBe(0);
    expect(result.monitor.incidentsOpened).toBe(0);
    expect(result.monitor.mttr.unavailable).toBe(true);
  });
});
