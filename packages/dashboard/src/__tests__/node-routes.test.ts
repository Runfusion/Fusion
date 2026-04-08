import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";
import { request } from "../test-request.js";
import { createServer } from "../server.js";

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListNodes = vi.fn().mockResolvedValue([]);
const mockRegisterNode = vi.fn();
const mockGetNode = vi.fn();
const mockUpdateNode = vi.fn();
const mockUnregisterNode = vi.fn().mockResolvedValue(undefined);
const mockCheckNodeHealth = vi.fn();
const mockUpdateProject = vi.fn();
const mockAssignProjectToNode = vi.fn();
const mockUnassignProjectFromNode = vi.fn();

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: vi.fn().mockImplementation(() => ({
      init: mockInit,
      close: mockClose,
      listNodes: mockListNodes,
      registerNode: mockRegisterNode,
      getNode: mockGetNode,
      updateNode: mockUpdateNode,
      unregisterNode: mockUnregisterNode,
      checkNodeHealth: mockCheckNodeHealth,
      updateProject: mockUpdateProject,
      assignProjectToNode: mockAssignProjectToNode,
      unassignProjectFromNode: mockUnassignProjectFromNode,
    })),
  };
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1080";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    };
  }

  getMissionStore() {
    return {
      listMissions: vi.fn().mockResolvedValue([]),
      createMission: vi.fn(),
      getMission: vi.fn(),
      updateMission: vi.fn(),
      deleteMission: vi.fn(),
      listTemplates: vi.fn().mockResolvedValue([]),
      createTemplate: vi.fn(),
      getTemplate: vi.fn(),
      updateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
      instantiateMission: vi.fn(),
    };
  }

  async listTasks(): Promise<Task[]> {
    return [];
  }
}

function makeNode(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "node_local",
    name: "local-node",
    type: "local",
    status: "online",
    maxConcurrent: 2,
    capabilities: ["executor"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Node routes", () => {
  const app = createServer(new MockStore() as any);

  beforeEach(() => {
    vi.clearAllMocks();
    mockListNodes.mockResolvedValue([]);
    mockGetNode.mockResolvedValue(undefined);
    mockRegisterNode.mockResolvedValue(makeNode());
    mockUpdateNode.mockResolvedValue(makeNode({ name: "updated-node", maxConcurrent: 4 }));
    mockCheckNodeHealth.mockResolvedValue("online");
    mockUpdateProject.mockResolvedValue({
      id: "proj_123",
      name: "Project",
      path: "/tmp/project",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockAssignProjectToNode.mockResolvedValue({
      id: "proj_123",
      name: "Project",
      path: "/tmp/project",
      status: "active",
      isolationMode: "in-process",
      nodeId: "node_local",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockUnassignProjectFromNode.mockResolvedValue({
      id: "proj_123",
      name: "Project",
      path: "/tmp/project",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("GET /api/nodes returns an empty array when no nodes are registered", async () => {
    mockListNodes.mockResolvedValue([]);

    const res = await request(app, "GET", "/api/nodes");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /api/nodes returns node list", async () => {
    mockListNodes.mockResolvedValue([
      makeNode({ id: "node_b", name: "z-node" }),
      makeNode({ id: "node_a", name: "a-node" }),
    ]);

    const res = await request(app, "GET", "/api/nodes");

    expect(res.status).toBe(200);
    expect((res.body as any[])).toHaveLength(2);
    expect((res.body as any[])[0].name).toBe("a-node");
    expect((res.body as any[])[1].name).toBe("z-node");
  });

  it("POST /api/nodes registers a local node with minimal input", async () => {
    mockRegisterNode.mockResolvedValue(makeNode({ id: "node_1", name: "node-one", type: "local" }));

    const res = await request(
      app,
      "POST",
      "/api/nodes",
      JSON.stringify({ name: "node-one", type: "local" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect((res.body as any).id).toBe("node_1");
    expect(mockRegisterNode).toHaveBeenCalledWith(expect.objectContaining({ name: "node-one", type: "local" }));
  });

  it("POST /api/nodes registers a remote node with url", async () => {
    mockRegisterNode.mockResolvedValue(
      makeNode({ id: "node_remote", name: "remote-node", type: "remote", url: "https://node.example.com" }),
    );

    const res = await request(
      app,
      "POST",
      "/api/nodes",
      JSON.stringify({ name: "remote-node", type: "remote", url: "https://node.example.com" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect((res.body as any).type).toBe("remote");
    expect(mockRegisterNode).toHaveBeenCalledWith(
      expect.objectContaining({ name: "remote-node", type: "remote", url: "https://node.example.com" }),
    );
  });

  it("POST /api/nodes returns 400 when name is missing", async () => {
    const res = await request(
      app,
      "POST",
      "/api/nodes",
      JSON.stringify({ type: "local" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });

  it("POST /api/nodes returns 400 when remote node is missing url", async () => {
    const res = await request(
      app,
      "POST",
      "/api/nodes",
      JSON.stringify({ name: "remote-node", type: "remote" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });

  it("POST /api/nodes returns 400 for invalid type", async () => {
    const res = await request(
      app,
      "POST",
      "/api/nodes",
      JSON.stringify({ name: "node", type: "invalid" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });

  it("GET /api/nodes/:id returns node by id", async () => {
    mockGetNode.mockResolvedValue(makeNode({ id: "node_1", name: "node-one" }));

    const res = await request(app, "GET", "/api/nodes/node_1");

    expect(res.status).toBe(200);
    expect((res.body as any).id).toBe("node_1");
  });

  it("GET /api/nodes/:id returns 404 for unknown id", async () => {
    mockGetNode.mockResolvedValue(undefined);

    const res = await request(app, "GET", "/api/nodes/missing");

    expect(res.status).toBe(404);
  });

  it("PATCH /api/nodes/:id updates node", async () => {
    mockUpdateNode.mockResolvedValue(makeNode({ id: "node_1", name: "node-two", maxConcurrent: 6 }));

    const res = await request(
      app,
      "PATCH",
      "/api/nodes/node_1",
      JSON.stringify({ name: "node-two", maxConcurrent: 6 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect((res.body as any).name).toBe("node-two");
    expect((res.body as any).maxConcurrent).toBe(6);
  });

  it("PATCH /api/nodes/:id returns 404 for unknown id", async () => {
    mockUpdateNode.mockRejectedValue(new Error("Node not found: missing"));

    const res = await request(
      app,
      "PATCH",
      "/api/nodes/missing",
      JSON.stringify({ name: "new-name" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(404);
  });

  it("DELETE /api/nodes/:id unregisters node", async () => {
    mockGetNode.mockResolvedValue(makeNode({ id: "node_1" }));

    const res = await request(app, "DELETE", "/api/nodes/node_1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockUnregisterNode).toHaveBeenCalledWith("node_1");
  });

  it("DELETE /api/nodes/:id returns 404 for unknown id", async () => {
    mockGetNode.mockResolvedValue(undefined);

    const res = await request(app, "DELETE", "/api/nodes/missing");

    expect(res.status).toBe(404);
  });

  it("POST /api/nodes/:id/health-check returns health status", async () => {
    mockCheckNodeHealth.mockResolvedValue("online");

    const res = await request(app, "POST", "/api/nodes/node_1/health-check");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "online" });
  });

  it("POST /api/nodes/:id/health-check returns 404 for unknown id", async () => {
    mockCheckNodeHealth.mockRejectedValue(new Error("Node not found: missing"));

    const res = await request(app, "POST", "/api/nodes/missing/health-check");

    expect(res.status).toBe(404);
  });

  it("GET /api/nodes/:id/metrics returns stub metrics for local node", async () => {
    mockGetNode.mockResolvedValue(makeNode({ id: "node_1", type: "local", maxConcurrent: 8 }));

    const res = await request(app, "GET", "/api/nodes/node_1/metrics");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "online",
      activeTasks: 0,
      maxConcurrent: 8,
    });
  });

  it("GET /api/nodes/:id/metrics returns 501 for remote nodes", async () => {
    mockGetNode.mockResolvedValue(makeNode({ id: "node_2", type: "remote" }));

    const res = await request(app, "GET", "/api/nodes/node_2/metrics");

    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: "Remote node metrics not yet implemented" });
  });

  it("PATCH /api/projects/:id assigns project to node when nodeId is provided", async () => {
    const res = await request(
      app,
      "PATCH",
      "/api/projects/proj_123",
      JSON.stringify({ nodeId: "node_local" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(mockUpdateProject).toHaveBeenCalledWith("proj_123", {});
    expect(mockAssignProjectToNode).toHaveBeenCalledWith("proj_123", "node_local");
    expect((res.body as any).nodeId).toBe("node_local");
  });

  it("PATCH /api/projects/:id unassigns project from node when nodeId is null", async () => {
    const res = await request(
      app,
      "PATCH",
      "/api/projects/proj_123",
      JSON.stringify({ nodeId: null }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(mockUnassignProjectFromNode).toHaveBeenCalledWith("proj_123");
    expect(res.body).not.toHaveProperty("nodeId");
  });
});
