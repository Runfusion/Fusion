// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDockerNode, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as performRequest } from "../../test-request.js";

const mockListManagedDockerNodes = vi.fn<() => Promise<ManagedDockerNode[]>>();
const mockCreateManagedDockerNode = vi.fn<(input: any) => Promise<ManagedDockerNode>>();
const mockGetManagedDockerNode = vi.fn<(id: string) => Promise<ManagedDockerNode | undefined>>();
const mockCentralInit = vi.fn().mockResolvedValue(undefined);
const mockCentralClose = vi.fn().mockResolvedValue(undefined);
const mockCentralListProjects = vi.fn().mockResolvedValue([]);
const mockCentralReconcileProjectStatuses = vi.fn().mockResolvedValue(undefined);

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    isGhAvailable: vi.fn(),
    isGhAuthenticated: vi.fn(),
    isQmdAvailable: vi.fn().mockResolvedValue(false),
    CentralCore: vi.fn().mockImplementation(function () { return {
      init: mockCentralInit,
      close: mockCentralClose,
      listProjects: mockCentralListProjects,
      reconcileProjectStatuses: mockCentralReconcileProjectStatuses,
      listManagedDockerNodes: mockListManagedDockerNodes,
      createManagedDockerNode: mockCreateManagedDockerNode,
      getManagedDockerNode: mockGetManagedDockerNode,
    }; }),
  };
});

/*
FNXC:DashboardRouteTests 2026-08-15-05:10:
Route mounting imports model-registry refresh constants from @fusion/engine, so wholesale inline
engine mocks go stale whenever the barrel grows. Use the canonical createEngineMock helper
(fallback vi.fn() proxy) instead of hand-listing every export.
*/
vi.mock("@fusion/engine", async () => {
  const { createEngineMock } = await import("../../test/mockCoreEngine.js");
  return createEngineMock({
    listCliAdapterDescriptors: () => [],
    createFnAgent: vi.fn(async () => ({ session: { state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn() } })),
    createResolvedAgentSession: vi.fn(async () => ({
      session: { state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn() },
      runtimeModel: undefined,
    })),
    ExperimentFinalizeService: class {
      async finalize() {
        return { keptRuns: [], droppedRuns: [], branches: [] };
      }
    },
    defaultGitOps: vi.fn(() => ({})),
    promptWithFallback: vi.fn(),
  });
});

function createMockStore(): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    updateGlobalSettings: vi.fn(),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn(),
    logEntry: vi.fn(),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    getAgentLogCount: vi.fn().mockResolvedValue(0),
    getAgentLogsByTimeRange: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    addTaskComment: vi.fn(),
    updateTaskComment: vi.fn(),
    deleteTaskComment: vi.fn(),
    getTaskDocuments: vi.fn().mockResolvedValue([]),
    getTaskDocument: vi.fn().mockResolvedValue(null),
    getTaskDocumentRevisions: vi.fn().mockResolvedValue([]),
    getAllDocuments: vi.fn().mockResolvedValue([]),
    upsertTaskDocument: vi.fn(),
    deleteTaskDocument: vi.fn(),
    updatePrInfo: vi.fn(),
    updateIssueInfo: vi.fn(),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    createWorkflowStep: vi.fn(),
    getWorkflowStep: vi.fn(),
    updateWorkflowStep: vi.fn(),
    deleteWorkflowStep: vi.fn(),
    getMissionStore: vi.fn(),
  } as unknown as TaskStore;
}

function setupApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(createMockStore()));
  return app;
}

async function req(app: express.Express, method: string, path: string, body?: unknown) {
  return performRequest(
    app,
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    body === undefined ? undefined : { "Content-Type": "application/json" },
  );
}

const sampleNode: ManagedDockerNode = {
  id: "dn_1",
  nodeId: null,
  name: "Docker Node",
  imageName: "runfusion/fusion",
  imageTag: "latest",
  containerId: null,
  status: "creating",
  hostConfig: {},
  envVars: {},
  volumeMounts: [],
  resourceSizing: { memoryMB: 4096, cpus: 2 },
  extraClis: [],
  persistentStorage: true,
  reachableUrl: null,
  apiKey: null,
  errorMessage: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("docker node routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListManagedDockerNodes.mockResolvedValue([sampleNode]);
    mockCreateManagedDockerNode.mockResolvedValue(sampleNode);
    mockGetManagedDockerNode.mockResolvedValue(sampleNode);
  });

  it("POST /api/docker-nodes with valid input returns 201", async () => {
    const app = setupApp();
    const res = await req(app, "POST", "/api/docker-nodes", {
      nodeId: null,
      name: "Docker Node",
      imageName: "runfusion/fusion",
      imageTag: "latest",
      hostConfig: {},
      envVars: {},
      volumeMounts: [],
      resourceSizing: { memoryMB: 4096, cpus: 2 },
      extraClis: [],
      persistentStorage: true,
      reachableUrl: null,
      apiKey: null,
    });

    expect(res.status).toBe(201);
    expect(mockCreateManagedDockerNode).toHaveBeenCalled();
  });

  it("POST /api/docker-nodes without name returns 400", async () => {
    const app = setupApp();
    const res = await req(app, "POST", "/api/docker-nodes", { imageName: "runfusion/fusion" });
    expect(res.status).toBe(400);
  });

  it("POST /api/docker-nodes with empty name returns 400", async () => {
    const app = setupApp();
    const res = await req(app, "POST", "/api/docker-nodes", { name: "  ", imageName: "runfusion/fusion" });
    expect(res.status).toBe(400);
  });

  it("POST /api/docker-nodes with invalid extraClis returns 400", async () => {
    const app = setupApp();
    const res = await req(app, "POST", "/api/docker-nodes", {
      name: "Docker Node",
      imageName: "runfusion/fusion",
      extraClis: ["bad-cli"],
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/docker-nodes returns list", async () => {
    const app = setupApp();
    const res = await req(app, "GET", "/api/docker-nodes");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("GET /api/docker-nodes/:id returns single node", async () => {
    const app = setupApp();
    const res = await req(app, "GET", "/api/docker-nodes/dn_1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("dn_1");
  });

  it("GET /api/docker-nodes/:id with non-existent ID returns 404", async () => {
    mockGetManagedDockerNode.mockResolvedValue(undefined);
    const app = setupApp();
    const res = await req(app, "GET", "/api/docker-nodes/missing");
    expect(res.status).toBe(404);
  });
});
