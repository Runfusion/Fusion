import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Agent, AgentHeartbeatRun, AgentStore } from "../../index.js";
import { aggregateActivityAnalytics } from "../../board/activity-analytics.js";
import * as schema from "../../postgres/schema/index.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";

/*
 * Keep the production HeartbeatMonitor in this PG test while replacing only the AI runtime.
 * The runtime seam invokes the callbacks the real model runtime supplies after a tool call.
 */
vi.mock("../../../../engine/src/agents/agent-session-helpers.js", () => ({
  createResolvedAgentSession: vi.fn(async (options: { onToolStart?: (name: string, args: unknown) => void; onToolEnd?: (name: string, isError: boolean, result: unknown) => void }) => {
    options.onToolStart?.("Read", { path: "private-path" });
    options.onToolEnd?.("Read", false, "private-result");
    return { session: { dispose: vi.fn(), prompt: vi.fn(), getSessionStats: () => ({ tokens: {} }) } };
  }),
  extractRuntimeHint: vi.fn(),
  resolveHeartbeatSessionModels: vi.fn(() => ({ defaultProvider: "durable-provider", defaultModelId: "durable-model" })),
  resolveExecutorFallbackThinkingLevel: vi.fn(),
}));
vi.mock("../../../../engine/src/pi.js", () => ({ promptWithFallback: vi.fn(async () => undefined) }));

import { HeartbeatMonitor } from "../../../../engine/src/agent-heartbeat.js";

const FROM = "2026-08-09T00:00:00.000Z";
const TO = "2026-08-09T23:59:59.999Z";
const IN_RANGE = "2026-08-09T12:00:00.000Z";

/**
 * FNXC:CommandCenterActivity 2026-08-09-11:29:
 * A durable agent's heartbeat run and usage events share an identity but represent different
 * measurements. Activity must count one active agent while preserving both run totals and the
 * agent-session boundary that fixes the permanent-agent zero-telemetry symptom.
 */
pgDescribe("durable agent Activity analytics", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_durable_activity", projectId: "durable-project" });
  beforeAll(h.beforeAll); beforeEach(h.beforeEach); afterEach(h.afterEach); afterAll(h.afterAll);

  it("returns well-formed zero activity for an empty project", async () => {
    const activity = await aggregateActivityAnalytics(h.layer(), { from: FROM, to: TO });
    expect(activity).toMatchObject({ sessions: 0, messages: 0, activeAgents: 0 });
    expect(activity.daily).toEqual([]);
  });

  it("counts a durable logger session and tools while de-duplicating its heartbeat agent", async () => {
    const layer = h.layer();
    const projectId = layer.projectId ?? "";
    await layer.db.insert(schema.project.agents).values({
      projectId, id: "durable-1", name: "Durable Agent", role: "executor", state: "idle",
      createdAt: IN_RANGE, updatedAt: IN_RANGE,
    });
    await layer.db.insert(schema.project.usageEvents).values([
      { projectId, ts: IN_RANGE, kind: "session_start", agentId: "durable-1", category: "agent-session" },
      { projectId, ts: IN_RANGE, kind: "tool_call", agentId: "durable-1", toolName: "Read", category: "filesystem" },
      { projectId, ts: IN_RANGE, kind: "tool_result", agentId: "durable-1", toolName: "Read", category: "filesystem" },
      { projectId, ts: IN_RANGE, kind: "session_start", agentId: "durable-1", category: "model-router" },
    ]);
    await layer.db.execute(sql`
      INSERT INTO project.agent_runs (project_id, id, agent_id, data, started_at, status)
      VALUES (${projectId}, 'durable-run-1', 'durable-1', '{}'::jsonb, ${IN_RANGE}, 'completed')
    `);

    const activity = await aggregateActivityAnalytics(layer, { from: FROM, to: TO });
    expect(activity.sessions).toBe(1);
    expect(activity.activeAgents).toBe(1);
    expect(activity.agentRuns).toMatchObject({ total: 1, completed: 1 });
  });

  /*
  FNXC:CommandCenterActivity 2026-08-09-16:48:
  The durable-agent symptom must cross the production logger, canonical usage-event store, and
  Activity aggregation boundary. Seeding rows alone cannot prove permanent-agent callbacks emit them.
  */
  it("turns a production durable no-task heartbeat into Activity sessions and tool usage", async () => {
    const layer = h.layer();
    const taskStore = h.store();
    /*
     * FNXC:CommandCenterActivity 2026-08-09-17:16:
     * The production heartbeat lane is under test; disable only optional MCP discovery so this
     * isolated PG harness never attempts to open a user-level secrets directory.
     */
    const heartbeatTaskStore = new Proxy(taskStore, {
      get(target, property, receiver) {
        if (property === "getSettingsByScope") return undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    const projectId = layer.projectId ?? "";
    const agent: Agent = {
      id: "durable-e2e", name: "Durable E2E", role: "executor", state: "active",
      soul: "Coordinate the project.", createdAt: IN_RANGE, updatedAt: IN_RANGE,
    } as Agent;
    const runs = new Map<string, AgentHeartbeatRun>();
    const agentStore = {
      getAgent: vi.fn(async () => agent),
      getCachedAgent: vi.fn(() => null),
      getBudgetStatus: vi.fn(async () => ({ allowed: true, budget: { period: "daily", limit: 0, used: 0, remaining: 0 } })),
      startHeartbeatRun: vi.fn(async () => ({ id: "durable-e2e-run", agentId: agent.id, startedAt: IN_RANGE, endedAt: null, status: "active" })),
      endHeartbeatRun: vi.fn(async (_agentId: string, runId: string, patch: Partial<AgentHeartbeatRun>) => {
        runs.set(runId, { id: runId, agentId: agent.id, startedAt: IN_RANGE, endedAt: IN_RANGE, status: "completed", ...patch } as AgentHeartbeatRun);
      }),
      saveRun: vi.fn(async (run: AgentHeartbeatRun) => { runs.set(run.id, run); }),
      getRunDetail: vi.fn(async (_agentId: string, runId: string) => runs.get(runId) ?? { id: runId, agentId: agent.id, startedAt: IN_RANGE, endedAt: IN_RANGE, status: "completed" }),
      updateAgentState: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => undefined),
      recordHeartbeat: vi.fn(async () => undefined),
      getLastBlockedState: vi.fn(async () => null),
      setLastBlockedState: vi.fn(async () => undefined),
      clearLastBlockedState: vi.fn(async () => undefined),
      appendRunLog: vi.fn(async () => undefined),
    } as unknown as AgentStore;

    await layer.db.insert(schema.project.agents).values({
      projectId, id: agent.id, name: agent.name, role: agent.role, state: "active",
      createdAt: IN_RANGE, updatedAt: IN_RANGE,
    });
    const result = await new HeartbeatMonitor({
      agentStore,
      store: agentStore,
      taskStore: heartbeatTaskStore,
      rootDir: process.cwd(),
      secretsStore: { listEnvExportable: vi.fn(async () => []) },
    })
      .executeHeartbeat({ agentId: agent.id, source: "on_demand" });
    expect(result.status).toBe("completed");

    const activity = await aggregateActivityAnalytics(layer, { from: "2000-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z" });
    expect(activity.sessions).toBeGreaterThan(0);
    expect(activity.activeAgents).toBe(1);
    const rows = await layer.db.execute(sql`
      SELECT kind, agent_id, task_id, category FROM project.usage_events
      WHERE project_id = ${projectId} ORDER BY kind
    `);
    expect(rows).toEqual([
      { kind: "session_start", agent_id: "durable-e2e", task_id: null, category: "agent-session" },
      { kind: "tool_call", agent_id: "durable-e2e", task_id: null, category: "read" },
      { kind: "tool_result", agent_id: "durable-e2e", task_id: null, category: "read" },
    ].sort((left, right) => left.kind.localeCompare(right.kind)));
  });

  it("sums CLI and agent sessions, honors the range, and isolates the bound project", async () => {
    const layer = h.layer();
    const projectId = layer.projectId ?? "";
    await layer.db.insert(schema.project.usageEvents).values([
      { projectId, ts: IN_RANGE, kind: "session_start", agentId: "durable-1", category: "agent-session" },
      { projectId, ts: "2026-08-10T12:00:00.000Z", kind: "session_start", agentId: "outside", category: "agent-session" },
      { projectId: "other-project", ts: IN_RANGE, kind: "session_start", agentId: "other", category: "agent-session" },
    ]);
    await layer.db.execute(sql`
      INSERT INTO project.cli_sessions (id, purpose, project_id, adapter_id, agent_state, worktree_path, created_at, updated_at)
      VALUES ('durable-cli-1', 'chat', ${projectId}, 'test', 'working', '/tmp/test', ${IN_RANGE}, ${IN_RANGE})
    `);

    const activity = await aggregateActivityAnalytics(layer, { from: FROM, to: TO });
    expect(activity.sessions).toBe(2);
  });
});
