// @vitest-environment node

import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AgentStore, drizzleSql } from "@fusion/core";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";

vi.mock("@fusion/engine", async () => {
  const { createEngineMock } = await import("../../test/mockCoreEngine.js");
  return createEngineMock({
    listCliAdapterDescriptors: () => [],
    createFnAgent: vi.fn(async () => ({ session: { state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn() } })),
    createResolvedAgentSession: vi.fn(async () => ({
      session: { state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn() },
      runtimeModel: undefined,
    })),
  });
});

const h = createSharedPgTaskStoreTestHarness({
  prefix: "agent_identity_routes",
  projectId: "dashboard_agent_identity_routes",
});

pgDescribe("agent identity resolution routes", () => {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("composes real startup reconciliation with list, exact-ID detail, and deterministic name resolution", async () => {
    const store = h.store();
    const agentStore = new AgentStore({
      rootDir: store.getFusionDir(),
      asyncLayer: store.getAsyncLayer()!,
    });
    await agentStore.init();

    const original = (await agentStore.listAgents({ includeEphemeral: true })).find(
      (agent) => agent.metadata?.builtInWorkflowRole === true && agent.metadata?.workflowRole === "merger",
    )!;
    const duplicate = await agentStore.createAgent({
      name: "temporary dashboard merger duplicate",
      role: "merger",
      instructionsText: "duplicate dashboard instructions",
      metadata: { builtInWorkflowRole: true, workflowRole: "merger", retained: "dashboard" },
      runtimeConfig: { identity: "duplicate" },
    });
    const unique = await agentStore.createAgent({ name: "Unique Reviewer", role: "reviewer" });

    // Reproduce the legacy duplicate after create-time uniqueness validation, with timestamps
    // that make the existing built-in the deterministic provenance owner during route init.
    await h.layer().db.execute(drizzleSql`
      UPDATE project.agents
      SET created_at = CASE
        WHEN id = ${original.id} THEN ${"2026-01-01T00:00:00.000Z"}
        ELSE ${"2026-01-02T00:00:00.000Z"}
      END,
      name = ${"Workflow Merger"}
      WHERE project_id = ${"dashboard_agent_identity_routes"}
        AND id IN (${original.id}, ${duplicate.id})
    `);

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const list = await request(app, "GET", "/api/agents");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect((list.body as Array<{ id: string; name: string }>).filter((agent) => agent.name === "Workflow Merger")
      .map((agent) => agent.id).sort()).toEqual([original.id, duplicate.id].sort());

    for (const id of [original.id, duplicate.id]) {
      const detail = await request(app, "GET", `/api/agents/${id}`);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect((detail.body as { id: string }).id).toBe(id);
    }

    const uniqueResponse = await request(app, "GET", "/api/agents/resolve/unique_reviewer");
    expect(uniqueResponse.status).toBe(200);
    expect((uniqueResponse.body as { agent: { id: string } }).agent.id).toBe(unique.id);

    const missing = await request(app, "GET", "/api/agents/resolve/missing-agent");
    expect(missing.status).toBe(404);

    const ambiguous = await request(app, "GET", "/api/agents/resolve/workflow_merger");
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body).toEqual({
      error: "Ambiguous agent name",
      code: "AMBIGUOUS_AGENT_NAME",
      outcome: "ambiguous",
      query: "workflow_merger",
      normalizedName: "workflow-merger",
      candidateAgentIds: [original.id, duplicate.id].sort(),
    });

    const reconciledOriginal = await agentStore.getAgent(original.id);
    const reconciledDuplicate = await agentStore.getAgent(duplicate.id);
    expect(reconciledOriginal?.metadata).toMatchObject({ builtInWorkflowRole: true, workflowRole: "merger" });
    expect(reconciledDuplicate).toMatchObject({
      id: duplicate.id,
      name: "Workflow Merger",
      instructionsText: "duplicate dashboard instructions",
      metadata: { retained: "dashboard" },
      runtimeConfig: { identity: "duplicate" },
    });
    expect(reconciledDuplicate?.metadata).not.toHaveProperty("builtInWorkflowRole");
    expect(reconciledDuplicate?.metadata).not.toHaveProperty("workflowRole");
  });
});
