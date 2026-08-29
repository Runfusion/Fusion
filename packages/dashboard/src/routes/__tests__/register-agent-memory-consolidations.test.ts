// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";

const getAgent = vi.fn();

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  class MockAgentStore {
    async init() {}
    getAgent = getAgent;
  }
  return { ...actual, AgentStore: MockAgentStore };
});

function app(events: unknown[]) {
  const store = {
    getRootDir: vi.fn().mockReturnValue("/fake/project"),
    getFusionDir: vi.fn().mockReturnValue("/fake/project/.fusion"),
    getAsyncLayer: vi.fn().mockReturnValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn(),
    getPluginStore: vi.fn().mockReturnValue({ init: vi.fn().mockResolvedValue(undefined), listPlugins: vi.fn().mockResolvedValue([]) }),
    listTasks: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn().mockResolvedValue([]),
    getRunAuditEventsAsync: vi.fn().mockImplementation(async ({ mutationType }: { mutationType?: string }) => events.filter((event: any) => event.mutationType === mutationType)),
  } as unknown as TaskStore;
  const server = express();
  server.use(express.json());
  server.use("/api", createApiRoutes(store));
  return { server, store };
}

const completed = { id: "audit-completed", timestamp: "2026-08-11T10:00:00.000Z", mutationType: "memory:consolidation-completed", runId: "run-1", metadata: { parsedFiles: 2, recallCreated: 1 } };
const skipped = { id: "audit-skipped", timestamp: "2026-08-11T11:00:00.000Z", mutationType: "memory:consolidation-skipped", runId: "run-2", metadata: { reason: "disabled" } };
const failed = { id: "audit-failed", timestamp: "2026-08-11T12:00:00.000Z", mutationType: "memory:consolidation-failed", runId: "run-3", metadata: { stage: "graph" } };

describe("GET /api/agents/:id/memory-consolidations", () => {
  beforeEach(() => {
    getAgent.mockReset();
    getAgent.mockResolvedValue({ id: "memory-keeper" });
  });

  it("merges each consolidation mutation query newest-first", async () => {
    const { server, store } = app([completed, skipped, failed, { id: "noise", timestamp: "2026-08-11T13:00:00.000Z", mutationType: "agent:heartbeat", runId: "run-noise", metadata: { text: "never expose" } }]);
    const response = await request(server, "GET", "/api/agents/memory-keeper/memory-consolidations");

    expect(response.status).toBe(200);
    expect(response.body.events.map((event: typeof completed) => event.id)).toEqual(["audit-failed", "audit-skipped", "audit-completed"]);
    expect((store.getRunAuditEventsAsync as any).mock.calls.map(([filter]: any[]) => filter.mutationType).sort()).toEqual([
      "memory:consolidation-completed", "memory:consolidation-failed", "memory:consolidation-skipped",
    ]);
  });

  it("returns an empty history", async () => {
    const { server } = app([]);
    const response = await request(server, "GET", "/api/agents/memory-keeper/memory-consolidations");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ agentId: "memory-keeper", events: [] });
  });

  it("returns 404 for an unknown agent", async () => {
    getAgent.mockResolvedValueOnce(null);
    const { server } = app([]);
    const response = await request(server, "GET", "/api/agents/missing/memory-consolidations");
    expect(response.status).toBe(404);
  });

  it("caps the merged response limit", async () => {
    const events = Array.from({ length: 101 }, (_, index) => ({
      ...completed,
      id: `audit-${index}`,
      timestamp: `2026-08-11T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }));
    const { server } = app(events);
    const response = await request(server, "GET", "/api/agents/memory-keeper/memory-consolidations?limit=999");
    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(100);
  });
});
