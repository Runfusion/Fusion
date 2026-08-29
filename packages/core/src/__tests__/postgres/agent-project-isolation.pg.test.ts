import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { AgentStore } from "../../agents/agent-store.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";
import { TaskStore } from "../../store.js";
import type { Agent } from "../../types.js";
import { aggregateTeamAnalytics } from "../../board/team-analytics.js";
import {
  addRating,
  appendConfigRevision,
  clearLastBlockedState,
  deleteAgent,
  deleteRating,
  findAgentRowsByName,
  getAllBlockedStates,
  getHeartbeatHistory,
  getLastBlockedState,
  getRatings,
  getTaskSession,
  insertApiKey,
  listAgentRows,
  readAgent,
  readApiKeys,
  readConfigRevisions,
  recordHeartbeat,
  setLastBlockedState,
  upsertTaskSession,
  writeAgent,
} from "../../async-stores/async-agent-store.js";

pgDescribe("agent project isolation", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_project_isolation",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  it("keeps duplicate agent ids and satellite rows inside the bound project", async () => {
    /*
    FNXC:MultiProjectIsolation 2026-08-11-09:13:
    Runfusion/Fusion#3414 reproduced duplicate durable ids in a shared owner-connected
    PostgreSQL cluster. This fixture exercises production AgentStore and TaskStore paths,
    proving every bound helper uses its partition while unbound compatibility remains cross-project.
    */
    const bind = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId });
    const projectA = bind("agents-project-a");
    const projectB = bind("agents-project-b");
    const sharedId = "agent-shared";
    const now = "2026-08-11T09:13:00.000Z";
    const agent = (name: string, state: Agent["state"], taskId?: string): Agent => ({
      id: sharedId,
      name,
      role: "executor",
      roles: ["executor"],
      state,
      taskId,
      createdAt: now,
      updatedAt: now,
      metadata: { project: name },
      runtimeConfig: { model: `${name}-model` },
    });
    const readRaw = async (projectId: string) => (await h.adminDb()
      .select({
        projectId: schema.project.agents.projectId,
        name: schema.project.agents.name,
        state: schema.project.agents.state,
        taskId: schema.project.agents.taskId,
        metadata: schema.project.agents.metadata,
        data: schema.project.agents.data,
      })
      .from(schema.project.agents)
      .where(and(eq(schema.project.agents.id, sharedId), eq(schema.project.agents.projectId, projectId))))[0];

    await writeAgent(projectA.db, agent("Agent A", "idle", "task-a"), projectA.projectId);
    await writeAgent(projectB.db, agent("Agent B", "active", "task-b"), projectB.projectId);
    await writeAgent(projectB.db, { ...agent("Only B", "idle"), id: "agent-only-b" }, projectB.projectId);

    expect((await listAgentRows(projectA.db, undefined, projectA.projectId)).map((row) => row.name)).toEqual(["Agent A"]);
    expect((await readAgent(projectA.db, sharedId, projectA.projectId))?.name).toBe("Agent A");
    expect(await readAgent(projectA.db, "agent-only-b", projectA.projectId)).toBeNull();
    expect(await findAgentRowsByName(projectA.db, "Agent B", projectA.projectId)).toEqual([]);

    // Direct writeAgent upsert updates all durable identity fields only in project A.
    const beforeBDirectUpdate = await readRaw(projectB.projectId);
    await writeAgent(projectA.db, {
      ...agent("Agent A direct update", "paused", "task-a-updated"),
      metadata: { project: "A-direct" },
      runtimeConfig: { model: "a-direct-model" },
    }, projectA.projectId);
    expect(await readRaw(projectB.projectId)).toEqual(beforeBDirectUpdate);

    // AgentStore is the dashboard/engine update entry point; its delegation must retain A's layer id.
    const agentStoreA = new AgentStore({ rootDir: h.rootDir(), asyncLayer: projectA });
    const beforeBAgentStoreUpdate = await readRaw(projectB.projectId);
    await agentStoreA.updateAgent(sharedId, {
      name: "Agent A store update",
      runtimeConfig: { model: "a-store-model" },
      metadata: { project: "A-store" },
    });
    await agentStoreA.updateAgentState(sharedId, "active");
    expect((await readAgent(projectA.db, sharedId, projectA.projectId))?.name).toBe("Agent A store update");
    expect(await readRaw(projectB.projectId)).toEqual(beforeBAgentStoreUpdate);

    // Repeat through B's production update path and prove it cannot mutate A.
    const agentStoreB = new AgentStore({ rootDir: h.rootDir(), asyncLayer: projectB });
    const beforeBUpdateA = await readRaw(projectA.projectId);
    await agentStoreB.updateAgent(sharedId, {
      name: "Agent B store update",
      runtimeConfig: { model: "b-store-model" },
      metadata: { project: "B-store" },
    });
    await agentStoreB.updateAgentState(sharedId, "paused");
    expect(await readRaw(projectA.projectId)).toEqual(beforeBUpdateA);
    expect((await readAgent(projectB.db, sharedId, projectB.projectId))?.name).toBe("Agent B store update");

    await recordHeartbeat(projectA.db, { agentId: sharedId, timestamp: now, status: "ok", runId: "run-a" }, projectA.projectId);
    await recordHeartbeat(projectB.db, { agentId: sharedId, timestamp: now, status: "missed", runId: "run-b" }, projectB.projectId);
    expect((await getHeartbeatHistory(projectA.db, sharedId, 50, projectA.projectId)).map((row) => row.runId)).toEqual(["run-a"]);

    await upsertTaskSession(projectA.db, { agentId: sharedId, taskId: "session", createdAt: now, updatedAt: now } as never, projectA.projectId);
    await upsertTaskSession(projectB.db, { agentId: sharedId, taskId: "session", createdAt: now, updatedAt: now, model: "b" } as never, projectB.projectId);
    expect((await getTaskSession(projectA.db, sharedId, "session", projectA.projectId) as { model?: string } | null)?.model).toBeUndefined();

    await insertApiKey(projectA.db, { id: "key", agentId: sharedId, tokenHash: "a", createdAt: now }, projectA.projectId);
    await insertApiKey(projectB.db, { id: "key", agentId: sharedId, tokenHash: "b", createdAt: now }, projectB.projectId);
    expect((await readApiKeys(projectA.db, sharedId, projectA.projectId)).map((key) => key.tokenHash)).toEqual(["a"]);

    await appendConfigRevision(projectA.db, { id: "revision-a", agentId: sharedId, createdAt: now } as never, projectA.projectId);
    await appendConfigRevision(projectB.db, { id: "revision-b", agentId: sharedId, createdAt: now } as never, projectB.projectId);
    expect((await readConfigRevisions(projectA.db, sharedId, projectA.projectId)).map((row) => row.id)).toEqual(expect.arrayContaining(["revision-a"]));

    await addRating(projectA.db, { id: "rating", agentId: sharedId, raterType: "user", score: 5, createdAt: now }, projectA.projectId);
    await addRating(projectB.db, { id: "rating", agentId: sharedId, raterType: "user", score: 1, createdAt: now }, projectB.projectId);
    expect((await getRatings(projectA.db, sharedId, undefined, projectA.projectId)).map((rating) => rating.score)).toEqual([5]);
    expect(await deleteRating(projectA.db, "rating", projectA.projectId)).toBe(true);
    expect((await getRatings(projectB.db, sharedId, undefined, projectB.projectId)).map((rating) => rating.score)).toEqual([1]);

    await setLastBlockedState(projectA.db, sharedId, { taskId: "blocked-a" } as never, projectA.projectId);
    await setLastBlockedState(projectB.db, sharedId, { taskId: "blocked-b" } as never, projectB.projectId);
    expect((await getLastBlockedState(projectA.db, sharedId, projectA.projectId) as { taskId?: string } | null)?.taskId).toBe("blocked-a");
    expect((await getAllBlockedStates(projectA.db, projectA.projectId)).map((row) => row.agentId)).toEqual([sharedId]);
    await clearLastBlockedState(projectA.db, sharedId, projectA.projectId);
    expect(await getLastBlockedState(projectB.db, sharedId, projectB.projectId)).not.toBeNull();

    await h.adminDb().insert(schema.project.tasks).values([
      {
        projectId: projectA.projectId,
        id: "analytics-a",
        description: "A analytics fixture",
        column: "done",
        assignedAgentId: sharedId,
        tokenUsageInputTokens: 5,
        tokenUsageTotalTokens: 5,
        tokenUsageLastUsedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        projectId: projectB.projectId,
        id: "analytics-b",
        description: "B analytics fixture",
        column: "done",
        assignedAgentId: sharedId,
        tokenUsageInputTokens: 99,
        tokenUsageTotalTokens: 99,
        tokenUsageLastUsedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const analytics = await aggregateTeamAnalytics(projectA, { now: Date.parse(now) });
    expect(analytics.agents.map((row) => row.agentName)).toEqual(["Agent A store update"]);
    expect(analytics.agents[0]?.tokens.totalTokens).toBe(5);

    // Use TaskStore's public reassignment path rather than a cast mock so both UPDATEs are covered.
    const taskStoreA = new TaskStore(h.rootDir(), undefined, { asyncLayer: projectA });
    const beforeReassignmentB = await readRaw(projectB.projectId);
    await taskStoreA.syncAgentTaskLinkOnReassignment("task-a-updated", sharedId, sharedId);
    expect(await readRaw(projectB.projectId)).toEqual(beforeReassignmentB);
    expect((await readAgent(projectA.db, sharedId, projectA.projectId))?.taskId).toBe("task-a-updated");

    expect(await deleteAgent(projectA.db, sharedId, projectA.projectId)).toBe(true);
    expect(await readAgent(projectA.db, sharedId, projectA.projectId)).toBeNull();
    expect((await readAgent(projectB.db, sharedId, projectB.projectId))?.name).toBe("Agent B store update");

    // An undefined project id intentionally remains unscoped: it sees B's row and writes its legacy partition.
    const unboundStore = new AgentStore({
      rootDir: h.rootDir(),
      asyncLayer: { ...h.layer(), projectId: undefined },
    });
    expect((await listAgentRows(h.layer().db)).map((row) => row.name).sort()).toEqual(["Agent B store update", "Only B"]);
    expect((await findAgentRowsByName(h.layer().db, "Agent B store update")).map((row) => row.id)).toEqual([sharedId]);
    await unboundStore.updateAgent(sharedId, { name: "Agent unbound update" });
    expect((await readAgent(h.layer().db, sharedId))?.name).toBe("Agent B store update");
    expect((await listAgentRows(h.layer().db)).map((row) => row.name)).toContain("Agent unbound update");
    expect((await readAgent(projectB.db, sharedId, projectB.projectId))?.name).toBe("Agent B store update");
  });
});
