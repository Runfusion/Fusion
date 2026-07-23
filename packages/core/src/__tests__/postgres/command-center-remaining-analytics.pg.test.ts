/**
 * FNXC:PostgresCommandCenterAnalytics 2026-06-28-09:30:
 * PostgreSQL-backed coverage for the LAST four Command Center analytics surfaces
 * that threw / returned HTTP 503 in PG backend mode before being ported to the
 * AsyncDataLayer:
 *
 *   - aggregateWorkflowAnalytics   (per-workflow tokens/cost/files/task counts)
 *   - aggregateGithubIssueAnalytics(filed/fixed/daily/byRepo/resolved)
 *   - aggregateSignalsAnalytics    (incident totals/open/resolved/MTTR/breakdowns)
 *   - composeLiveSnapshot          (active sessions/runs/nodes + per-column counts)
 *
 * Each is exercised against an EMPTY project (proving it resolves with a
 * well-formed zero/empty result instead of throwing or 500ing) and against
 * seeded rows (proving the PG queries hit the real project.* tables with the
 * right snake_case columns and aggregation semantics).
 *
 * Runs in the blocking gate (`@fusion/core test:pg-gate`) and auto-skips via
 * pgDescribe when PostgreSQL is unavailable.
 */

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { aggregateWorkflowAnalytics } from "../../board/workflow-analytics.js";
import { aggregateGithubIssueAnalytics } from "../../board/github-issue-analytics.js";
import { aggregateSignalsAnalytics } from "../../board/activity-analytics.js";
import { composeLiveSnapshot } from "../../board/command-center-live.js";

const pgTest = pgDescribe;

const FROM = "2026-06-01T00:00:00.000Z";
const TO = "2026-06-30T23:59:59.999Z";
const IN_RANGE = "2026-06-15T12:00:00.000Z";
const RESOLVED_IN_RANGE = "2026-06-15T13:00:00.000Z";

pgTest("Command Center remaining analytics aggregators (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_cc_remaining",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // ── Empty project: each aggregator resolves with a zero/empty shape ─────────

  it("all four aggregators resolve (no throw) against an empty project", async () => {
    const layer = Object.assign(h.layer(), { projectId: "p1" });
    const range = { from: FROM, to: TO };

    const workflow = await aggregateWorkflowAnalytics(layer, {
      ...range,
      defaultWorkflowId: "builtin:coding",
    });
    expect(workflow.from).toBe(FROM);
    expect(workflow.workflows).toEqual([]);
    expect(workflow.totals.tokens.totalTokens).toBe(0);
    expect(workflow.totals.tasksCompleted).toBe(0);
    expect(workflow.totals.tasksInProgress).toBe(0);
    expect(workflow.totals.filesChanged).toBe(0);

    const github = await aggregateGithubIssueAnalytics(layer, range);
    expect(github.filed).toBe(0);
    expect(github.fixed).toBe(0);
    expect(github.net).toBe(0);
    expect(github.daily).toEqual([]);
    expect(github.byRepo).toEqual([]);
    expect(github.resolved).toEqual([]);

    const signals = await aggregateSignalsAnalytics(layer, range);
    expect(signals.totalSignals).toBe(0);
    expect(signals.open).toBe(0);
    expect(signals.resolved).toBe(0);
    expect(signals.mttr.unavailable).toBe(true);
    expect(signals.mttr.value).toBeNull();
    expect(signals.bySource).toEqual([]);
    expect(signals.bySeverity).toEqual([]);
    expect(signals.byStatus).toEqual([]);

    const live = await composeLiveSnapshot(layer);
    expect(typeof live.capturedAt).toBe("string");
    expect(live.activeSessions).toBe(0);
    expect(live.activeRuns).toBe(0);
    expect(live.activeNodes).toBe(0);
    expect(live.sessions).toEqual([]);
    expect(live.runs).toEqual([]);
    expect(live.columns).toEqual([]);
  });

  // ── Seeded project: aggregators reflect real project.* rows ─────────────────

  it("aggregators reflect seeded project rows", async () => {
    const store = h.store();
    const adminDb = h.adminDb();

    // ── Workflow analytics target: a done task on a custom workflow ───────────
    await store.createTaskWithReservedId(
      { description: "workflow target", column: "done" },
      { taskId: "FN-WF-1", createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
    );
    await adminDb.execute(sql`
      INSERT INTO project.workflows (id, name, description, ir, layout, kind, created_at, updated_at)
      VALUES ('wf-custom', 'Custom WF', '', ${JSON.stringify({ version: "v2" })}::jsonb, '{}'::jsonb, 'workflow', ${IN_RANGE}, ${IN_RANGE})
    `);
    await adminDb.execute(sql`
      INSERT INTO project.task_workflow_selection (task_id, workflow_id, step_ids, updated_at)
      VALUES ('FN-WF-1', 'wf-custom', '[]'::jsonb, ${IN_RANGE})
    `);
    await adminDb.execute(sql`
      UPDATE project.tasks SET
        token_usage_input_tokens = 100,
        token_usage_output_tokens = 50,
        token_usage_total_tokens = 150,
        token_usage_last_used_at = ${IN_RANGE},
        model_provider = 'anthropic',
        model_id = 'claude-sonnet-4-5',
        modified_files = ${JSON.stringify(["src/a.ts", "src/b.ts"])}::jsonb,
        column_moved_at = ${IN_RANGE}
      WHERE id = 'FN-WF-1'
    `);

    // ── GitHub analytics: a filed-issue task + a fixed source-issue task ──────
    await store.createTaskWithReservedId(
      { description: "filed a github issue", column: "in-progress" },
      { taskId: "FN-GH-1", createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
    );
    await adminDb.execute(sql`
      UPDATE project.tasks SET
        github_tracking = ${JSON.stringify({
          issue: { number: 42, owner: "acme", repo: "widgets", createdAt: IN_RANGE },
        })}::jsonb
      WHERE id = 'FN-GH-1'
    `);
    await store.createTaskWithReservedId(
      { description: "fixed a github source issue", column: "done" },
      { taskId: "FN-GH-2", createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
    );
    await adminDb.execute(sql`
      UPDATE project.tasks SET
        source_issue_provider = 'github',
        source_issue_repository = 'acme/widgets',
        source_issue_number = 7,
        source_issue_url = 'https://github.com/acme/widgets/issues/7',
        source_issue_closed_at = ${IN_RANGE}
      WHERE id = 'FN-GH-2'
    `);

    // ── Signals: one resolved-in-range incident ──────────────────────────────
    await adminDb.execute(sql`
      INSERT INTO project.incidents
        (project_id, incident_id, grouping_key, title, severity, status, source, opened_at, resolved_at, created_at, updated_at)
      VALUES
        ('p1', 'inc-1', 'gk-1', 'DB down', 'high', 'resolved', 'datadog', ${IN_RANGE}, ${RESOLVED_IN_RANGE}, ${IN_RANGE}, ${RESOLVED_IN_RANGE})
    `);

    // ── Live snapshot: one active session + one active run ────────────────────
    await adminDb.execute(sql`
      INSERT INTO project.agents (project_id, id, name, role, state, created_at, updated_at)
      VALUES ('p1', 'agent-live', 'Live Agent', 'executor', 'idle', ${IN_RANGE}, ${IN_RANGE})
    `);
    await adminDb.execute(sql`
      INSERT INTO project.agent_runs (project_id, id, agent_id, data, started_at, status)
      VALUES ('p1', 'run-1', 'agent-live', ${JSON.stringify({ taskId: "FN-WF-1" })}::jsonb, ${IN_RANGE}, 'active')
    `);
    await adminDb.execute(sql`
      INSERT INTO project.cli_sessions
        (id, task_id, purpose, project_id, adapter_id, agent_state, worktree_path, created_at, updated_at)
      VALUES
        ('cli-1', 'FN-WF-1', 'task', 'p1', 'claude-local', 'working', '/tmp/wt/FN-WF-1', ${IN_RANGE}, ${IN_RANGE})
    `);

    const layer = Object.assign(h.layer(), { projectId: "p1" });
    const range = { from: FROM, to: TO };

    // Workflow.
    const workflow = await aggregateWorkflowAnalytics(layer, { ...range, defaultWorkflowId: "builtin:coding" });
    const wf = workflow.workflows.find((w) => w.workflowId === "wf-custom");
    expect(wf).toBeDefined();
    expect(wf?.workflowName).toBe("Custom WF");
    expect(wf?.isBuiltin).toBe(false);
    expect(wf?.tokens.totalTokens).toBe(150);
    expect(wf?.tasksCompleted).toBe(1);
    expect(wf?.filesChanged).toBe(2);
    expect(workflow.totals.tokens.totalTokens).toBe(150);
    // FN-WF-1 (wf-custom) + FN-GH-2 (done, backfilled to the builtin:coding
    // default workflow) both count as completed in range.
    expect(workflow.totals.tasksCompleted).toBe(2);

    // GitHub.
    const github = await aggregateGithubIssueAnalytics(layer, range);
    expect(github.filed).toBe(1);
    expect(github.fixed).toBe(1);
    expect(github.net).toBe(0);
    expect(github.byRepo.map((r) => r.repo)).toContain("acme/widgets");
    expect(github.resolved).toHaveLength(1);
    expect(github.resolved[0].taskId).toBe("FN-GH-2");
    expect(github.resolved[0].issueNumber).toBe(7);
    expect(github.resolved[0].resolvedAtExact).toBe(true);

    // Signals.
    const signals = await aggregateSignalsAnalytics(layer, range);
    expect(signals.totalSignals).toBe(1);
    expect(signals.resolved).toBe(1);
    expect(signals.open).toBe(0);
    expect(signals.mttr.unavailable).toBe(false);
    expect(signals.mttr.sampleCount).toBe(1);
    expect(signals.mttr.value).toBeCloseTo(60, 5); // one hour → 60 minutes
    expect(signals.bySource.find((b) => b.source === "datadog")?.count).toBe(1);
    expect(signals.bySeverity.find((b) => b.severity === "high")?.count).toBe(1);

    // Live snapshot.
    const live = await composeLiveSnapshot(layer);
    expect(live.activeSessions).toBe(1);
    expect(live.sessions[0].id).toBe("cli-1");
    expect(live.activeRuns).toBe(1);
    expect(live.runs[0].id).toBe("run-1");
    expect(live.runs[0].taskId).toBe("FN-WF-1");
    expect(live.activeNodes).toBe(1);
    const columnCounts = Object.fromEntries(live.columns.map((c) => [c.column, c.count]));
    expect(columnCounts["done"]).toBe(2); // FN-WF-1 + FN-GH-2
    expect(columnCounts["in-progress"]).toBe(1); // FN-GH-1
  });

  /*
   * FNXC:CommandCenter 2026-07-10:
   * FN-7786 (PG port of the upstream sqlite regression): workflow cost
   * analytics must price the actually-used token-usage model snapshot
   * (token_usage_model_provider/id) before the legacy task model columns, so
   * a task whose model columns are NULL still prices instead of reporting an
   * unavailable/zero estimated cost.
   */
  it("prices token usage from the actually-used model snapshot when task model columns are empty", async () => {
    const store = h.store();
    const adminDb = h.adminDb();

    await store.createTaskWithReservedId(
      { description: "snapshot priced", column: "todo" },
      { taskId: "FN-SNAP-1", createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
    );
    await adminDb.execute(sql`
      UPDATE project.tasks SET
        token_usage_input_tokens = 1000000,
        token_usage_output_tokens = 200000,
        token_usage_cached_tokens = 0,
        token_usage_cache_write_tokens = 0,
        token_usage_total_tokens = 1200000,
        token_usage_last_used_at = ${IN_RANGE},
        model_provider = NULL,
        model_id = NULL,
        token_usage_model_provider = 'anthropic',
        token_usage_model_id = 'claude-sonnet-5'
      WHERE id = 'FN-SNAP-1'
    `);

    const layer = Object.assign(h.layer(), { projectId: "p1" });
    const workflow = await aggregateWorkflowAnalytics(layer, {
      from: FROM,
      to: TO,
      defaultWorkflowId: "builtin:coding",
    });

    expect(workflow.workflows[0].cost).toMatchObject({ unavailable: false, stale: false });
    expect(workflow.workflows[0].cost.usd).toBeCloseTo(4, 2);
    expect(workflow.totals.cost.usd).toBeCloseTo(4, 2);
  });

  /*
  FNXC:PostgresCommandCenterAnalytics 2026-07-14-00:49:
  An unbound live snapshot intentionally composes sessions, heartbeat runs, active nodes, and task-column counts across every project partition. Binding the same layer must scope every live surface together so the snapshot cannot mix global and project-local counts.
  */
  it("live snapshot aggregates all projects when unbound and isolates a bound project", async () => {
    const store = h.store();
    const layer = Object.assign(h.layer(), { projectId: undefined as string | undefined });
    const adminDb = h.adminDb();

    layer.projectId = "live-project-a";
    await store.createTaskWithReservedId(
      { description: "live task A", column: "todo" },
      { taskId: "FN-LIVE-A", createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
    );
    layer.projectId = "live-project-b";
    await store.createTaskWithReservedId(
      { description: "live task B", column: "in-progress" },
      { taskId: "FN-LIVE-B", createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
    );
    await store.createTaskWithReservedId(
      { description: "soft-deleted live task", column: "in-progress" },
      { taskId: "FN-LIVE-DELETED", createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
    );
    await adminDb.execute(sql`
      UPDATE project.tasks
      SET deleted_at = ${IN_RANGE}, "column" = 'archived'
      WHERE project_id = 'live-project-b' AND id = 'FN-LIVE-DELETED'
    `);
    await adminDb.execute(sql`
      INSERT INTO project.agents (project_id, id, name, role, state, created_at, updated_at)
      VALUES
        ('live-project-a', 'agent-live-a', 'Live A', 'executor', 'idle', ${IN_RANGE}, ${IN_RANGE}),
        ('live-project-b', 'agent-live-b', 'Live B', 'executor', 'idle', ${IN_RANGE}, ${IN_RANGE})
    `);
    await adminDb.execute(sql`
      INSERT INTO project.agent_runs (project_id, id, agent_id, data, started_at, status)
      VALUES
        ('live-project-a', 'run-live-a', 'agent-live-a', ${JSON.stringify({ taskId: "FN-LIVE-A" })}::jsonb, ${IN_RANGE}, 'active'),
        ('live-project-b', 'run-live-b', 'agent-live-b', ${JSON.stringify({ taskId: "FN-LIVE-B" })}::jsonb, ${IN_RANGE}, 'active')
    `);
    await adminDb.execute(sql`
      INSERT INTO project.cli_sessions
        (id, task_id, purpose, project_id, adapter_id, agent_state, worktree_path, created_at, updated_at)
      VALUES
        ('cli-live-a', 'FN-LIVE-A', 'task', 'live-project-a', 'test', 'working', '/tmp/live-a', ${IN_RANGE}, ${IN_RANGE}),
        ('cli-live-b', 'FN-LIVE-B', 'task', 'live-project-b', 'test', 'working', '/tmp/live-b', ${IN_RANGE}, ${IN_RANGE})
    `);

    delete layer.projectId;
    const unbound = await composeLiveSnapshot(layer, Date.parse(IN_RANGE));
    expect(unbound).toMatchObject({ activeSessions: 2, activeRuns: 2, activeNodes: 2 });
    expect(unbound.sessions.map(({ id }) => id).sort()).toEqual(["cli-live-a", "cli-live-b"]);
    expect(unbound.runs.map(({ id }) => id).sort()).toEqual(["run-live-a", "run-live-b"]);
    // FN-8429: a soft-deleted archived task is no longer live board work.
    expect(Object.fromEntries(unbound.columns.map(({ column, count }) => [column, count]))).toEqual({ todo: 1, "in-progress": 1 });

    const bound = await composeLiveSnapshot({ ...layer, projectId: "live-project-a" }, Date.parse(IN_RANGE));
    expect(bound).toMatchObject({ activeSessions: 1, activeRuns: 1, activeNodes: 1 });
    expect(bound.sessions.map(({ id }) => id)).toEqual(["cli-live-a"]);
    expect(bound.runs.map(({ id }) => id)).toEqual(["run-live-a"]);
    expect(Object.fromEntries(bound.columns.map(({ column, count }) => [column, count]))).toEqual({ todo: 1 });
  });

  /**
   * FNXC:SignalsAnalyticsIsolation 2026-07-14-01:26:
   * Unbound Signals analytics intentionally aggregate every project partition, while a bound layer must apply one tenant scope to totals, open/resolved counts, MTTR samples, and every source/severity/status breakdown.
   */
  it("signals analytics aggregate all projects when unbound and isolate a bound project", async () => {
    const layer = Object.assign(h.layer(), { projectId: undefined as string | undefined });
    const adminDb = h.adminDb();
    await adminDb.execute(sql`
      INSERT INTO project.incidents
        (project_id, incident_id, grouping_key, title, severity, status, source, opened_at, resolved_at, created_at, updated_at)
      VALUES
        ('signal-project-a', 'signal-a', 'group-a', 'A', 'high', 'resolved', 'datadog', ${IN_RANGE}, ${RESOLVED_IN_RANGE}, ${IN_RANGE}, ${RESOLVED_IN_RANGE}),
        ('signal-project-b', 'signal-b', 'group-b', 'B', 'critical', 'open', 'sentry', ${IN_RANGE}, NULL, ${IN_RANGE}, ${IN_RANGE})
    `);

    const range = { from: FROM, to: TO };
    const unbound = await aggregateSignalsAnalytics(layer, range);
    expect(unbound).toMatchObject({ totalSignals: 2, open: 1, resolved: 1 });
    expect(unbound.mttr).toEqual({ value: 60, unavailable: false, sampleCount: 1 });
    expect(unbound.bySource).toEqual([
      { source: "datadog", count: 1 },
      { source: "sentry", count: 1 },
    ]);
    expect(unbound.bySeverity).toEqual([
      { severity: "critical", count: 1 },
      { severity: "high", count: 1 },
    ]);
    expect(unbound.byStatus).toEqual([
      { status: "open", count: 1 },
      { status: "resolved", count: 1 },
    ]);

    const bound = await aggregateSignalsAnalytics({ ...layer, projectId: "signal-project-a" }, range);
    expect(bound).toMatchObject({ totalSignals: 1, open: 0, resolved: 1 });
    expect(bound.mttr).toEqual({ value: 60, unavailable: false, sampleCount: 1 });
    expect(bound.bySource).toEqual([{ source: "datadog", count: 1 }]);
    expect(bound.bySeverity).toEqual([{ severity: "high", count: 1 }]);
    expect(bound.byStatus).toEqual([{ status: "resolved", count: 1 }]);
  });
});
