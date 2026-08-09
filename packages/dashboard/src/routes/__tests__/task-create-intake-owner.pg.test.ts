// @vitest-environment node

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express from "express";

const { mockSession, mockCreateResolvedAgentSession } = vi.hoisted(() => ({
  mockSession: () => ({
    model: { provider: "mock", id: "intake-owner" },
    state: {},
    prompt: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    abort: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(() => () => undefined),
    sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
  }),
  mockCreateResolvedAgentSession: vi.fn(),
}));

vi.mock("../../../../engine/src/agents/agent-session-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../engine/src/agents/agent-session-helpers.js")>();
  return {
    ...actual,
    createResolvedAgentSession: mockCreateResolvedAgentSession,
  };
});

vi.mock("../../../../engine/src/mcp/mcp-resolution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../engine/src/mcp/mcp-resolution.js")>();
  return { ...actual, resolveMcpServersForStore: vi.fn(async () => ({ servers: [], errors: [] })) };
});

vi.mock("../../../../engine/src/pi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../engine/src/pi.js")>();
  return {
    ...actual,
    describeModel: vi.fn(() => "mock/intake-owner"),
    promptWithFallback: vi.fn(async (session: { prompt: (prompt: string) => Promise<void> }, prompt: string) => await session.prompt(prompt)),
  };
});

vi.mock("../../../../engine/src/worktree/worktree-acquisition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../engine/src/worktree/worktree-acquisition.js")>();
  return {
    ...actual,
    acquireTaskWorktree: vi.fn(async () => ({
      worktreePath: "/tmp/fusion-intake-owner-heartbeat",
      branch: "fusion/intake-owner",
      source: "existing",
      hydrated: false,
      isResume: true,
    })),
  };
});

import { AgentStore, type TaskStore } from "@fusion/core";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../../../core/src/workflows/builtin-coding-workflow-ir.js";
import { TriageProcessor } from "../../../../engine/src/triage.js";
import { HeartbeatMonitor } from "../../../../engine/src/agent-heartbeat.js";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

/*
FNXC:IntakeOwnership 2026-08-09-17:11:
Dashboard intake must persist an executor owner before its response makes the new
card visible. This production-route PostgreSQL fixture protects the reported
unowned-card symptom and keeps workflowId:null on the same pool-resolution path.
*/
pgDescribe("POST /tasks intake owner", () => {
  let harness: PgTestHarness;
  let store: TaskStore;
  let agents: AgentStore;
  let app: express.Express;

  beforeEach(async () => {
    mockCreateResolvedAgentSession.mockImplementation(async () => ({
      session: mockSession(),
      settleFallbackDispatch: async () => undefined,
      runtimeId: "mock",
    }));
    harness = await createTaskStoreForTest({
      prefix: "fusion_dashboard_intake_owner",
      projectId: "dashboard-intake-owner",
    });
    store = harness.store;
    agents = new AgentStore({ rootDir: harness.rootDir, asyncLayer: harness.layer, projectId: "dashboard-intake-owner", taskStore: store });
    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
  });

  afterEach(async () => {
    agents.close();
    await harness.teardown();
  });

  const post = (body: unknown) => REQUEST(app, "POST", "/api/tasks", JSON.stringify(body), {
    "content-type": "application/json",
  });

  it("keeps Dashboard intake ownership stable through planning routing and the owner heartbeat claim", async () => {
    const planner = await agents.createAgent({ name: "Dashboard planner", role: "triage" });
    const executor = await agents.createAgent({ name: "Dashboard executor", role: "executor" });

    const response = await post({ description: "Dashboard task gets an implementation owner" });

    expect(response.status).toBe(201);
    const created = response.body as { id: string; assignedAgentId?: string };
    expect(created.assignedAgentId).toBe(executor.id);
    expect(created.assignedAgentId).not.toBe(planner.id);
    const persisted = await store.getTask(created.id);
    expect(persisted?.assignedAgentId).toBe(executor.id);

    /*
    FNXC:IntakeOwnership 2026-08-09-20:54:
    The reported Dashboard/API failure must be proved through live lifecycle
    entry points, not routing helpers. Planning receives the separately fenced
    triage principal, while the executor's real heartbeat discovers the durable
    owner inbox; neither stage may rewrite the persisted executor owner.
    */
    const triage = new TriageProcessor(store, harness.rootDir, { agentStore: agents });
    await triage.specifyTask(persisted!);

    const afterPlanning = await store.getTask(created.id);
    expect(afterPlanning?.assignedAgentId).toBe(executor.id);
    expect(mockCreateResolvedAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionPurpose: "triage",
      taskId: created.id,
      actionGateContext: expect.objectContaining({ agentId: planner.id }),
    }));

    const heartbeat = new HeartbeatMonitor({ store: agents, taskStore: store, rootDir: harness.rootDir });
    await heartbeat.executeHeartbeat({ agentId: executor.id, source: "on_demand" });

    expect(mockCreateResolvedAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionPurpose: "heartbeat",
      actionGateContext: expect.objectContaining({ agentId: executor.id }),
    }));
    expect((await agents.getAgent(executor.id))?.taskId).toBe(created.id);
    expect((await store.getTask(created.id))?.assignedAgentId).toBe(executor.id);
  });

  it("rejects invalid explicit and named execute owners without creating an unowned card", async () => {
    const executor = await agents.createAgent({ name: "Route fallback executor", role: "executor" });
    const unavailableBinding = await store.createWorkflowDefinition({
      name: "Route unavailable execute binding",
      ir: {
        ...BUILTIN_CODING_WORKFLOW_IR,
        columns: BUILTIN_CODING_WORKFLOW_IR.columns.map((column) => column.id === "in-progress"
          ? { ...column, agent: { agentId: "route-missing-executor", mode: "override" as const } }
          : column),
      },
    });

    const invalidExplicit = await post({
      description: "Route invalid explicit owner",
      assignedAgentId: "route-missing-explicit-owner",
    });
    const invalidBinding = await post({
      description: "Route unavailable named execute owner",
      workflowId: unavailableBinding.id,
    });

    expect(executor.id).toBeTruthy();
    expect(invalidExplicit.status).toBeGreaterThanOrEqual(400);
    expect(invalidBinding.status).toBeGreaterThanOrEqual(400);
    expect((await store.listTasks()).map((task) => task.description)).not.toContain("Route invalid explicit owner");
    expect((await store.listTasks()).map((task) => task.description)).not.toContain("Route unavailable named execute owner");
  });

  it("keeps no-workflow creates owned and makes a genuine empty pool observable", async () => {
    const executor = await agents.createAgent({ name: "No workflow executor", role: "executor" });
    const ownedResponse = await post({
      description: "No workflow still needs an executor",
      workflowId: null,
      ownershipExemption: true,
    });

    expect(ownedResponse.status).toBe(201);
    const owned = ownedResponse.body as { id: string; assignedAgentId?: string };
    expect(owned.assignedAgentId).toBe(executor.id);
    expect((await store.getTask(owned.id))?.assignedAgentId).toBe(executor.id);

    await agents.deleteAgent(executor.id);
    const unownedResponse = await post({ description: "Fresh project has no executor" });

    expect(unownedResponse.status).toBe(201);
    const unowned = unownedResponse.body as { id: string; assignedAgentId?: string };
    expect(unowned.assignedAgentId).toBeUndefined();
    expect((await store.getTask(unowned.id))?.assignedAgentId).toBeUndefined();
    const audit = await store.getRunAuditEventsAsync({ taskId: unowned.id });
    expect(audit.filter((event) => event.mutationType === "task:intake-owner-unresolved"))
      .toHaveLength(1);
  });
});
