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
import { aggregateActivityAnalytics, aggregateMonitorMetrics } from "../../board/activity-analytics.js";
import { sql } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";

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

  /**
   * FNXC:MonitorAnalyticsIsolation 2026-07-14-01:04:
   * An unbound Command Center monitor read intentionally aggregates every project, while a project-bound layer must isolate deployments, incident counts, and MTTR to that tenant.
   */
  it("monitor metrics aggregate all projects when unbound and isolate a bound project", async () => {
    const adminDb = h.adminDb();
    await adminDb.execute(sql`
      INSERT INTO project.deployments
        (project_id, deployment_id, deployed_at, created_at)
      VALUES
        ('monitor-project-a', 'deployment-a', '2026-07-13T12:00:00.000Z', '2026-07-13T12:00:00.000Z'),
        ('monitor-project-b', 'deployment-b', '2026-07-13T12:00:00.000Z', '2026-07-13T12:00:00.000Z')
    `);
    await adminDb.execute(sql`
      INSERT INTO project.incidents
        (project_id, incident_id, grouping_key, title, status, opened_at, resolved_at, created_at, updated_at)
      VALUES
        ('monitor-project-a', 'incident-a', 'group-a', 'A', 'resolved', '2026-07-13T10:00:00.000Z', '2026-07-13T11:00:00.000Z', '2026-07-13T10:00:00.000Z', '2026-07-13T11:00:00.000Z'),
        ('monitor-project-b', 'incident-b', 'group-b', 'B', 'open', '2026-07-13T12:00:00.000Z', NULL, '2026-07-13T12:00:00.000Z', '2026-07-13T12:00:00.000Z')
    `);

    const range = { from: "2026-07-13T00:00:00.000Z", to: "2026-07-13T23:59:59.999Z" };
    const layer = h.layer();
    const unbound = await aggregateMonitorMetrics(layer, range);
    expect(unbound).toMatchObject({ deployments: 2, incidentsOpened: 2, incidentsResolved: 1, openIncidents: 1 });
    expect(unbound.mttr).toEqual({ value: 60, unavailable: false, sampleCount: 1 });

    const bound = await aggregateMonitorMetrics({ ...layer, projectId: "monitor-project-a" }, range);
    expect(bound).toMatchObject({ deployments: 1, incidentsOpened: 1, incidentsResolved: 1, openIncidents: 0 });
    expect(bound.mttr).toEqual({ value: 60, unavailable: false, sampleCount: 1 });
  });

  /*
  FNXC:ActivityAnalyticsPostgres 2026-07-13-22:38:
  PostgreSQL activity analytics must report persisted sessions, messages, nodes, agents, and heartbeat runs instead of valid-looking zeros. Seed every contributing surface so the dashboard contract is verified across summary and daily aggregation.

  FNXC:ActivityAnalyticsPostgres 2026-07-14-00:37:
  Unbound command-center analytics intentionally aggregate all project partitions, while an explicitly bound layer remains isolated. Cover sessions, usage, runs, daily activity, and SDLC funnel transitions together so those views cannot disagree about the project scope.
  */
  it("aggregateActivityAnalytics aggregates all projects when unbound and isolates a bound project", async () => {
    const layer = h.layer();
    await layer.db.insert(schema.project.agents).values({
      id: "agent-analytics",
      name: "Analytics Agent",
      role: "worker",
      createdAt: "2026-07-13T10:00:00.000Z",
      updatedAt: "2026-07-13T10:00:00.000Z",
    });
    await layer.db.insert(schema.project.agentRuns).values({
      projectId: layer.projectId ?? "__legacy_unscoped__",
      id: "run-analytics",
      agentId: "agent-analytics",
      data: {},
      startedAt: "2026-07-13T12:00:00.000Z",
      status: "completed",
    });
    await layer.db.insert(schema.project.usageEvents).values([
      { projectId: layer.projectId ?? "__legacy_unscoped__", ts: "2026-07-13T11:00:00.000Z", kind: "user_message", agentId: "agent-analytics", nodeId: "node-1" },
      { projectId: layer.projectId ?? "__legacy_unscoped__", ts: "2026-07-13T11:05:00.000Z", kind: "tool_call", agentId: "agent-analytics", nodeId: "node-2" },
    ]);
    await layer.db.insert(schema.project.agents).values({
      projectId: "other-project",
      id: "agent-other-project",
      name: "Other Project Agent",
      role: "worker",
      createdAt: "2026-07-13T10:00:00.000Z",
      updatedAt: "2026-07-13T10:00:00.000Z",
    });
    await layer.db.insert(schema.project.agentRuns).values({
      projectId: "other-project",
      id: "run-other-project",
      agentId: "agent-other-project",
      data: {},
      startedAt: "2026-07-13T12:00:00.000Z",
      status: "failed",
    });
    await layer.db.insert(schema.project.usageEvents).values({
      projectId: "other-project",
      ts: "2026-07-13T11:00:00.000Z",
      kind: "user_message",
      agentId: "agent-other-project",
      nodeId: "other-node",
    });
    await layer.db.insert(schema.project.cliSessions).values({
      id: "cli-analytics",
      purpose: "chat",
      projectId: layer.projectId ?? "__legacy_unscoped__",
      adapterId: "test",
      createdAt: "2026-07-13T10:30:00.000Z",
      updatedAt: "2026-07-13T10:30:00.000Z",
    });
    await layer.db.insert(schema.project.cliSessions).values({
      id: "cli-other-project",
      purpose: "chat",
      projectId: "other-project",
      adapterId: "test",
      createdAt: "2026-07-13T10:45:00.000Z",
      updatedAt: "2026-07-13T10:45:00.000Z",
    });
    await layer.db.insert(schema.project.activityLog).values([
      {
        projectId: "__legacy_unscoped__",
        id: "activity-analytics-local",
        timestamp: "2026-07-13T13:00:00.000Z",
        type: "task:moved",
        taskId: "FN-ANALYTICS-LOCAL",
        details: "moved",
        metadata: { to: "todo" },
      },
      {
        projectId: "other-project",
        id: "activity-analytics-other",
        timestamp: "2026-07-13T13:05:00.000Z",
        type: "task:moved",
        taskId: "FN-ANALYTICS-OTHER",
        details: "moved",
        metadata: { to: "todo" },
      },
    ]);

    const range = {
      from: "2026-07-13T00:00:00.000Z",
      to: "2026-07-13T23:59:59.999Z",
    };
    const result = await aggregateActivityAnalytics(layer, range);

    expect(result).toMatchObject({ sessions: 2, messages: 2, activeNodes: 3, activeAgents: 2 });
    expect(result.agentRuns).toMatchObject({ total: 2, completed: 1, failed: 1 });
    expect(result.daily).toEqual([
      expect.objectContaining({ day: "2026-07-13", messages: 2, activeNodes: 3, activeAgents: 2, agentRuns: 2 }),
    ]);
    expect(result.funnel.stages.find(({ stage }) => stage === "todo")?.entered).toBe(2);

    const boundResult = await aggregateActivityAnalytics({ ...layer, projectId: "__legacy_unscoped__" }, range);
    expect(boundResult).toMatchObject({ sessions: 1, messages: 1, activeNodes: 2, activeAgents: 1 });
    expect(boundResult.agentRuns).toMatchObject({ total: 1, completed: 1, failed: 0 });
    expect(boundResult.daily).toEqual([
      expect.objectContaining({ day: "2026-07-13", messages: 1, activeNodes: 2, activeAgents: 1, agentRuns: 1 }),
    ]);
    expect(boundResult.funnel.stages.find(({ stage }) => stage === "todo")?.entered).toBe(1);
  });

  /**
   * FNXC:ActivityAnalyticsPostgres 2026-07-14-01:41:
   * Legacy or schema-drift agent runs may lack an agent ID. Such rows still count as runs, but they must not create a phantom daily active agent or push stickiness above the range-active-agent population.
   */
  it("excludes null run agent IDs from daily active agents and stickiness", async () => {
    const layer = h.layer();
    await layer.db.insert(schema.project.agents).values({
      id: "agent-real",
      name: "Real Agent",
      role: "worker",
      createdAt: "2026-07-13T10:00:00.000Z",
      updatedAt: "2026-07-13T10:00:00.000Z",
    });
    await layer.db.insert(schema.project.usageEvents).values({
      projectId: "__legacy_unscoped__",
      ts: "2026-07-13T11:00:00.000Z",
      kind: "user_message",
      agentId: "agent-real",
    });
    await layer.db.execute(sql`ALTER TABLE project.agent_runs ALTER COLUMN agent_id DROP NOT NULL`);
    try {
      await layer.db.execute(sql`
        INSERT INTO project.agent_runs (project_id, id, agent_id, data, started_at, status)
        VALUES ('', 'run-without-agent', NULL, '{}'::jsonb, '2026-07-13T12:00:00.000Z', 'completed')
      `);
      const result = await aggregateActivityAnalytics(layer, {
        from: "2026-07-13T00:00:00.000Z",
        to: "2026-07-13T23:59:59.999Z",
      });

      expect(result.agentRuns.total).toBe(1);
      expect(result.activeAgents).toBe(1);
      expect(result.daily).toEqual([
        expect.objectContaining({ day: "2026-07-13", activeAgents: 1, agentRuns: 1 }),
      ]);
      expect(result.stickiness).toBe(1);
    } finally {
      await layer.db.execute(sql`DELETE FROM project.agent_runs WHERE agent_id IS NULL`);
      await layer.db.execute(sql`ALTER TABLE project.agent_runs ALTER COLUMN agent_id SET NOT NULL`);
    }
  });
});
