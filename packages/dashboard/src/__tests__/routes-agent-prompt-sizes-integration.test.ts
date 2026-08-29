import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { postgresSchema, TaskStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createServer } from "../server.js";
import { get } from "../test-request.js";

pgDescribe("GET /api/agents/:id/prompt-sizes integration", () => {
  let harness: PgTestHarness;
  let store: TaskStore;
  let agentId: string;

  beforeEach(async () => {
    // FNXC:PostgresCutover 2026-07-16-06:30: route integration fixtures use
    // the canonical PG harness because TaskStore no longer supports SQLite.
    harness = await createTaskStoreForTest();
    // FNXC:PostgresCutover 2026-07-16-06:30: AgentStore persists agent runs
    // by project, so bind the isolated harness layer before seeding telemetry.
    (harness.layer as { projectId?: string }).projectId = "prompt-sizes-project";
    store = harness.store;

    agentId = "agent-prompt-sizes";
    const projectId = harness.layer.projectId!;
    await harness.layer.db.insert(postgresSchema.project.agents).values({
      projectId,
      id: agentId,
      name: "Prompt Sizes Agent",
      role: "executor",
      state: "active",
      createdAt: "2026-05-17T12:00:00.000Z",
      updatedAt: "2026-05-17T12:00:00.000Z",
      data: {},
    });
    await harness.layer.db.insert(postgresSchema.project.agentRuns).values({
      projectId,
      id: "run-prompt-size-1",
      agentId,
      startedAt: "2026-05-17T12:00:00.000Z",
      endedAt: "2026-05-17T12:00:01.000Z",
      status: "completed",
      data: {
        id: "run-prompt-size-1",
        agentId,
        startedAt: "2026-05-17T12:00:00.000Z",
        endedAt: "2026-05-17T12:00:01.000Z",
        status: "completed",
        systemPrompt: "sys prompt",
        executionPrompt: "execute now",
      },
    });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it("returns prompt-size rows derived from startedAt and run JSON", async () => {
    const app = createServer(store);
    const okRes = await get(app, `/api/agents/${agentId}/prompt-sizes`);
    expect(okRes.status).toBe(200);
    expect(okRes.body).toEqual([
      {
        runId: "run-prompt-size-1",
        createdAt: "2026-05-17T12:00:00.000Z",
        systemChars: "sys prompt".length,
        execChars: "execute now".length,
        totalChars: "sys prompt".length + "execute now".length,
      },
    ]);
  });
});
