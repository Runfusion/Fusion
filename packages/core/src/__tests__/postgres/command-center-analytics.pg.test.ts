/**
 * FNXC:PostgresCommandCenterAnalytics 2026-06-27-10:00:
 * PostgreSQL-backed coverage for the four Command Center analytics aggregators
 * that returned HTTP 503 in PG backend mode before being ported to the
 * AsyncDataLayer:
 *
 *   - aggregateProductivityAnalytics (files/commits/PRs/LOC/duration)
 *   - aggregateTeamAnalytics         (per-agent tokens/cost/files/tasks)
 *   - aggregateTokenAnalytics        (token usage series/totals)
 *   - aggregateToolAnalytics         (tool-call breakdown + autonomy ratio)
 *
 * Each aggregator is exercised twice: once against an EMPTY project (proving it
 * resolves with a well-formed zero/empty result instead of throwing or 500ing),
 * and once against seeded rows (proving the PG queries hit the real project.*
 * tables with the right snake_case columns and aggregation semantics).
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
import { aggregateProductivityAnalytics } from "../../productivity-analytics.js";
import { aggregateTeamAnalytics } from "../../team-analytics.js";
import { aggregateTokenAnalytics } from "../../token-analytics.js";
import { aggregateToolAnalytics } from "../../tool-analytics.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";

const pgTest = pgDescribe;

const FROM = "2026-06-01T00:00:00.000Z";
const TO = "2026-06-30T23:59:59.999Z";
const IN_RANGE = "2026-06-15T12:00:00.000Z";
const IN_RANGE_MS = Date.parse(IN_RANGE);

pgTest("Command Center analytics aggregators (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_cc_analytics",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // ── Empty project: each aggregator resolves with a zero/empty shape ─────────

  it("all four aggregators resolve (no throw) against an empty project", async () => {
    const layer = Object.assign(h.layer(), { projectId: "p1" });
    const range = { from: FROM, to: TO };

    const productivity = await aggregateProductivityAnalytics(layer, range);
    expect(productivity.from).toBe(FROM);
    expect(productivity.modifiedFiles).toBe(0);
    expect(productivity.commits).toBe(0);
    expect(productivity.pullRequests).toBe(0);
    expect(productivity.byLanguage).toEqual([]);
    expect(productivity.loc.unavailable).toBe(true);
    expect(productivity.taskDuration.unavailable).toBe(true);

    const team = await aggregateTeamAnalytics(layer, range);
    expect(team.agents).toEqual([]);
    expect(team.totals.tokens.totalTokens).toBe(0);
    expect(team.totals.tasksCompleted).toBe(0);

    const tokens = await aggregateTokenAnalytics(layer, { ...range, groupBy: "model" });
    expect(tokens.totals.totalTokens).toBe(0);
    expect(tokens.groups).toEqual([]);

    const tools = await aggregateToolAnalytics(layer, range);
    expect(tools.toolCalls).toBe(0);
    expect(tools.byCategory).toEqual([]);
    expect(tools.interventions.total).toBe(0);
    expect(tools.fullyAutonomous).toBe(true);
  });

  // ── Seeded project: aggregators reflect real project.* rows ─────────────────

  it("aggregators reflect seeded project rows", async () => {
    const store = h.store();
    const adminDb = h.adminDb();

    // A done task assigned to an agent, with token usage + modified files in range.
    await store.createTaskWithReservedId(
      { description: "analytics target", column: "done" },
      {
        taskId: "FN-CC-1",
        createdAt: IN_RANGE,
        updatedAt: IN_RANGE,
        applyDefaultWorkflowSteps: false,
      },
    );

    // Agent row (team identity).
    await adminDb.execute(sql`
      INSERT INTO project.agents (id, name, role, state, created_at, updated_at)
      VALUES ('agent-1', 'Agent One', 'executor', 'idle', ${IN_RANGE}, ${IN_RANGE})
    `);

    // Backfill the analytics-relevant task columns directly (token usage, files,
    // assignment, completion timestamps). These are not all settable via the
    // public create API, so a targeted UPDATE keeps the seed precise.
    await adminDb.execute(sql`
      UPDATE project.tasks SET
        assigned_agent_id = 'agent-1',
        token_usage_input_tokens = 100,
        token_usage_output_tokens = 50,
        token_usage_cached_tokens = 10,
        token_usage_cache_write_tokens = 5,
        token_usage_total_tokens = 165,
        token_usage_last_used_at = ${IN_RANGE},
        token_usage_model_provider = 'anthropic',
        token_usage_model_id = 'claude-sonnet-4-5',
        model_provider = 'anthropic',
        model_id = 'claude-sonnet-4-5',
        modified_files = ${JSON.stringify(["src/a.ts", "src/b.tsx", "README.md"])}::jsonb,
        column_moved_at = ${IN_RANGE},
        execution_completed_at = ${IN_RANGE},
        cumulative_active_ms = 120000
      WHERE id = 'FN-CC-1'
    `);

    // A commit association with diff stats (LOC) in range.
    await adminDb.execute(sql`
      INSERT INTO project.task_commit_associations
        (id, task_lineage_id, task_id_snapshot, commit_sha, commit_subject,
         authored_at, matched_by, confidence, additions, deletions, created_at, updated_at)
      VALUES
        ('tca-1', 'FN-CC-1', 'FN-CC-1', 'deadbeef', 'feat: thing',
         ${IN_RANGE}, 'canonical-lineage-trailer', 'canonical', 30, 15, ${IN_RANGE}, ${IN_RANGE})
    `);

    // A pull request in range (created_at is bigint epoch-ms).
    await adminDb.execute(sql`
      INSERT INTO project.pull_requests
        (id, source_type, source_id, repo, head_branch, state, created_at, updated_at)
      VALUES
        ('pr-1', 'task', 'FN-CC-1', 'owner/repo', 'fusion/FN-CC-1', 'open', ${IN_RANGE_MS}, ${IN_RANGE_MS})
    `);

    // Usage events: tool calls + a session start.
    await adminDb.execute(sql`
      INSERT INTO project.usage_events (project_id, ts, kind, tool_name, category)
      VALUES
        ('p1', ${IN_RANGE}, 'tool_call', 'Read', 'other'),
        ('p1', ${IN_RANGE}, 'tool_call', 'Edit', 'other'),
        ('p1', ${IN_RANGE}, 'session_start', NULL, NULL)
    `);

    // An approval event (human intervention).
    await adminDb.execute(sql`
      INSERT INTO project.approval_request_audit_events
        (id, request_id, event_type, actor_id, actor_type, actor_name, created_at)
      VALUES
        ('ev-1', 'req-1', 'approved', 'user-1', 'user', 'User One', ${IN_RANGE})
    `);

    const layer = Object.assign(h.layer(), { projectId: "p1" });
    const range = { from: FROM, to: TO };

    // Productivity.
    const productivity = await aggregateProductivityAnalytics(layer, range);
    expect(productivity.modifiedFiles).toBe(3);
    expect(productivity.commits).toBe(1);
    expect(productivity.pullRequests).toBe(1);
    expect(productivity.loc).toEqual({ value: 45, unavailable: false });
    expect(productivity.taskDuration.completedTasks).toBe(1);
    expect(productivity.taskDuration.totalMs).toBe(120000);
    const langs = new Set(productivity.byLanguage.map((l) => l.language));
    expect(langs).toEqual(new Set(["ts", "tsx", "md"]));

    // Team.
    const team = await aggregateTeamAnalytics(layer, range);
    expect(team.agents.map((a) => a.agentId)).toContain("agent-1");
    const agent = team.agents.find((a) => a.agentId === "agent-1");
    expect(agent?.tokens.totalTokens).toBe(165);
    expect(agent?.filesChanged).toBe(3);
    expect(agent?.tasksCompleted).toBe(1);
    expect(team.totals.tokens.totalTokens).toBe(165);

    // Tokens.
    const tokens = await aggregateTokenAnalytics(layer, { ...range, groupBy: "model" });
    expect(tokens.totals.totalTokens).toBe(165);
    expect(tokens.totals.nTasks).toBe(1);
    expect(tokens.groups.map((g) => g.key)).toContain("claude-sonnet-4-5");

    // Tools.
    const tools = await aggregateToolAnalytics(layer, range);
    expect(tools.toolCalls).toBe(2);
    expect(tools.sessions).toBe(1);
    expect(tools.interventions.approvals).toBe(1);
    expect(tools.interventions.total).toBe(1);
    expect(tools.fullyAutonomous).toBe(false);
    expect(tools.autonomyRatio).toBe(2);
    const byCat = Object.fromEntries(tools.byCategory.map((c) => [c.category, c.count]));
    expect(Object.values(byCat).reduce((a, b) => a + b, 0)).toBe(2);
  });

  /*
  FNXC:PostgresCommandCenterAnalytics 2026-07-14-00:49:
  Unbound tool analytics intentionally combine all project partitions, including usage-event totals/categories/sessions and task-backed user steers. Binding the same read layer must isolate every one of those query surfaces to the selected project.
  */
  it("tool analytics aggregate all projects when unbound and isolate a bound project", async () => {
    const store = h.store();
    const layer = h.layer() as AsyncDataLayer & { projectId?: string };
    const adminDb = h.adminDb();

    layer.projectId = "tool-project-a";
    await store.createTaskWithReservedId(
      { description: "tool analytics A", column: "todo" },
      { taskId: "FN-TOOL-A", createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
    );
    layer.projectId = "tool-project-b";
    await store.createTaskWithReservedId(
      { description: "tool analytics B", column: "todo" },
      { taskId: "FN-TOOL-B", createdAt: IN_RANGE, updatedAt: IN_RANGE, applyDefaultWorkflowSteps: false },
    );
    await adminDb.execute(sql`
      UPDATE project.tasks
      SET steering_comments = ${JSON.stringify([{ id: "steer-a", author: "user", content: "A", createdAt: IN_RANGE }])}::jsonb
      WHERE id = 'FN-TOOL-A'
    `);
    await adminDb.execute(sql`
      UPDATE project.tasks
      SET steering_comments = ${JSON.stringify([{ id: "steer-b", author: "user", content: "B", createdAt: IN_RANGE }])}::jsonb
      WHERE id = 'FN-TOOL-B'
    `);
    await adminDb.execute(sql`
      INSERT INTO project.usage_events (project_id, ts, kind, tool_name, category)
      VALUES
        ('tool-project-a', ${IN_RANGE}, 'tool_call', 'Read', 'other'),
        ('tool-project-a', ${IN_RANGE}, 'session_start', NULL, NULL),
        ('tool-project-b', ${IN_RANGE}, 'tool_call', 'Edit', 'other'),
        ('tool-project-b', ${IN_RANGE}, 'session_start', NULL, NULL)
    `);

    delete layer.projectId;
    const range = { from: FROM, to: TO };
    const unbound = await aggregateToolAnalytics(layer, range);
    expect(unbound).toMatchObject({ toolCalls: 2, sessions: 2 });
    expect(unbound.interventions).toMatchObject({ userSteers: 2, total: 2 });
    expect(Object.values(Object.fromEntries(unbound.byCategory.map((row) => [row.category, row.count]))).reduce((a, b) => a + b, 0)).toBe(2);

    const bound = await aggregateToolAnalytics({ ...layer, projectId: "tool-project-a" }, range);
    expect(bound).toMatchObject({ toolCalls: 1, sessions: 1 });
    expect(bound.interventions).toMatchObject({ userSteers: 1, total: 1 });
    expect(Object.values(Object.fromEntries(bound.byCategory.map((row) => [row.category, row.count]))).reduce((a, b) => a + b, 0)).toBe(1);
  });
});
