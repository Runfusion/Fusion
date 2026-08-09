/*
FNXC:AgentActivityStream 2026-08-09-12:02:
FN-8864 requires core-side writers to use AsyncDataLayer directly because production
AgentStore instances do not receive the optional TaskStore facade. Exercise the public
state and assignment transitions against the PostgreSQL outbox so a mock-only writer
cannot satisfy this coverage.
*/
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "../agents/agent-store.js";
import { ApprovalRequestStore } from "../agents/approval-request-store.js";
import { queryAgentActivityEvents } from "../task-store/async/async-agent-activity.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("agent activity production writers", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_activity_writers",
    projectId: "proj_agent_activity_writers",
  });
  let agentStore: AgentStore;

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
    // Deliberately omit taskStore: this is the production construction shape.
    agentStore = new AgentStore({ rootDir: h.rootDir(), asyncLayer: h.layer() });
    await agentStore.init();
  });
  afterEach(async () => {
    agentStore?.close();
    await h.afterEach();
  });

  it("persists one roster-proven state transition through updateAgentState", async () => {
    const agent = await agentStore.createAgent({ name: "Activity executor", role: "executor" });

    await agentStore.updateAgentState(agent.id, "running");

    const { events } = await queryAgentActivityEvents(h.layer(), { agentId: agent.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent:state-changed",
      agentId: agent.id,
      agentAttribution: "agent",
      metadata: { fromState: "active", toState: "running", source: "update" },
    });
  });

  it("persists an attributable approval through its production AsyncDataLayer seam", async () => {
    const agent = await agentStore.createAgent({ name: "Approval requester", role: "executor" });
    const approvals = new ApprovalRequestStore(null, { asyncLayer: h.layer() });

    const request = await approvals.create({
      requester: { actorId: agent.id, actorType: "agent", actorName: "Approval requester" },
      targetAction: { category: "command_execution", action: "run", summary: "test", resourceType: "task", resourceId: "FN-8864", context: { toolName: "fn_task_done", toolArgs: { forbidden: "never persisted" } } },
      taskId: "FN-8864",
    });

    const { events } = await queryAgentActivityEvents(h.layer(), { agentId: agent.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "approval:requested",
      agentId: agent.id,
      agentAttribution: "agent",
      taskId: "FN-8864",
      metadata: { requestId: request.id, category: "command_execution", toolName: "fn_task_done" },
    });
  });

  it("persists assignment without inventing a delegating manager", async () => {
    const agent = await agentStore.createAgent({ name: "Assigned executor", role: "executor" });

    await agentStore.assignTask(agent.id, "FN-8864");
    await agentStore.assignTask(agent.id, undefined);

    const { events } = await queryAgentActivityEvents(h.layer(), { agentId: agent.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task:handed-off",
      taskId: "FN-8864",
      agentId: agent.id,
      agentAttribution: "agent",
      fromAgentId: null,
      toAgentId: agent.id,
      metadata: { delegationDirection: "unknown" },
    });
  });
});
