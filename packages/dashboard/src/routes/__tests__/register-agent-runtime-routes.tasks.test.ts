// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
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

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    description: `${id} task`,
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

function createStore(tasks: Task[]): TaskStore {
  return {
    getRootDir: vi.fn().mockReturnValue("/fake/project-a"),
    getFusionDir: vi.fn().mockReturnValue("/fake/project-a/.fusion"),
    getAsyncLayer: vi.fn().mockReturnValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn(),
    getPluginStore: vi.fn().mockReturnValue({ init: vi.fn().mockResolvedValue(undefined), listPlugins: vi.fn().mockResolvedValue([]) }),
    listTasks: vi.fn().mockImplementation(async ({ includeArchived }: { includeArchived?: boolean } = {}) => (
      includeArchived === false ? tasks.filter((candidate) => candidate.column !== "archived") : tasks
    )),
    searchTasks: vi.fn().mockResolvedValue([]),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    getAgentLogCount: vi.fn().mockResolvedValue(0),
    getAgentLogsByTimeRange: vi.fn().mockResolvedValue([]),
    getTaskDocuments: vi.fn().mockResolvedValue([]),
    getTaskDocument: vi.fn().mockResolvedValue(null),
    getTaskDocumentRevisions: vi.fn().mockResolvedValue([]),
    getAllDocuments: vi.fn().mockResolvedValue([]),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    getMissionStore: vi.fn(),
  } as unknown as TaskStore;
}

function app(tasks: Task[]) {
  const server = express();
  server.use(express.json());
  const store = createStore(tasks);
  server.use("/api", createApiRoutes(store));
  return { server, store };
}

function scopedApp(stores: Record<string, TaskStore>) {
  const server = express();
  const engineManager = {
    getEngine: vi.fn((projectId: string) => ({ getTaskStore: () => stores[projectId] })),
    onProjectAccessed: vi.fn(),
  };
  server.use(express.json());
  server.use("/api", createApiRoutes(createStore([]), { engineManager } as never));
  return { server, engineManager };
}

describe("GET /api/agents/:id/tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the role-agnostic, project-scoped union of explicit assignments and runtime workflow links", async () => {
    const assigned = task("FN-ASSIGNED", { assignedAgentId: "executor-agent" });
    const workflow = task("FN-WORKFLOW");
    const secondAssigned = task("FN-SECOND-ASSIGNED", { assignedAgentId: "executor-agent" });
    const otherAgent = task("FN-OTHER", { assignedAgentId: "merger-agent" });
    const { server, store } = app([assigned, workflow, secondAssigned, otherAgent]);
    getAgent.mockResolvedValue({ id: "executor-agent", roles: ["executor", "reviewer"], taskId: "FN-WORKFLOW" });

    const response = await request(server, "GET", "/api/agents/executor-agent/tasks");

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.map((entry: Task) => entry.id)).toEqual(["FN-ASSIGNED", "FN-WORKFLOW", "FN-SECOND-ASSIGNED"]);
    expect(new Set(response.body.map((entry: Task) => entry.id)).size).toBe(response.body.length);
    expect(response.body.map((entry: Task) => entry.id)).not.toContain(otherAgent.id);
    expect(store.listTasks).toHaveBeenCalledWith({ slim: true, includeArchived: false });
  });

  it("deduplicates a task present through assignment and the runtime link", async () => {
    const overlap = task("FN-OVERLAP", { assignedAgentId: "reviewer-agent" });
    const { server } = app([overlap]);
    getAgent.mockResolvedValue({ id: "reviewer-agent", roles: ["reviewer"], taskId: overlap.id });

    const response = await request(server, "GET", "/api/agents/reviewer-agent/tasks");

    expect(response.status).toBe(200);
    expect(response.body.map((entry: Task) => entry.id)).toEqual([overlap.id]);
  });

  it("keeps explicit assignment visibility when the runtime link is undefined or stale", async () => {
    const assigned = task("FN-ASSIGNED", { assignedAgentId: "merger-agent" });
    const { server } = app([assigned]);
    getAgent.mockResolvedValueOnce({ id: "merger-agent", roles: ["merger"] })
      .mockResolvedValueOnce({ id: "merger-agent", roles: ["merger"], taskId: "FN-STALE" });

    const undefinedLink = await request(server, "GET", "/api/agents/merger-agent/tasks");
    const staleLink = await request(server, "GET", "/api/agents/merger-agent/tasks");

    expect(undefinedLink.status).toBe(200);
    expect(staleLink.status).toBe(200);
    expect(undefinedLink.body.map((entry: Task) => entry.id)).toEqual([assigned.id]);
    expect(staleLink.body.map((entry: Task) => entry.id)).toEqual([assigned.id]);
  });

  it("excludes completed tasks and does not read another project's task list", async () => {
    const completed = task("FN-COMPLETE", { column: "done", assignedAgentId: "executor-agent" });
    const projectA = createStore([completed]);
    const projectB = createStore([task("FN-FOREIGN", { assignedAgentId: "executor-agent" })]);
    const { server, engineManager } = scopedApp({ "project-a": projectA, "project-b": projectB });
    getAgent.mockResolvedValue({ id: "executor-agent", roles: ["executor"], taskId: "FN-FOREIGN" });

    const response = await request(server, "GET", "/api/agents/executor-agent/tasks?projectId=project-a");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(projectA.listTasks).toHaveBeenCalledWith({ slim: true, includeArchived: false });
    expect(projectB.listTasks).not.toHaveBeenCalled();
    expect(engineManager.getEngine).toHaveBeenCalledWith("project-a");
  });

  it("returns 404 for an unknown agent", async () => {
    const { server } = app([task("FN-WORKFLOW")]);
    getAgent.mockResolvedValue(null);

    const response = await request(server, "GET", "/api/agents/missing-agent/tasks");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: "Agent not found" });
  });
});
