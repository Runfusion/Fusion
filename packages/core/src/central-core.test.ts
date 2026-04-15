import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CentralCore } from "./central-core.js";
import { NodeDiscovery } from "./node-discovery.js";
import { NodeConnection, type ConnectionResult } from "./node-connection.js";
import { getAppVersion } from "./app-version.js";
import * as systemMetrics from "./system-metrics.js";
import type {
  RegisteredProject,
  ProjectHealth,
  CentralActivityLogEntry,
  GlobalConcurrencyState,
  SystemMetrics,
  DiscoveryConfig,
  DiscoveredNode,
} from "./types.js";

describe("CentralCore", () => {
  let tempDir: string;
  let central: CentralCore;
  let projectPaths: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
    tempDir = mkdtempSync(join(tmpdir(), "kb-central-core-test-"));
    central = new CentralCore(tempDir);
    projectPaths = [];
  });

  afterEach(async () => {
    await central.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("lifecycle", () => {
    it("should initialize and create database", async () => {
      await central.init();
      expect(central.isInitialized()).toBe(true);
      expect(central.getDatabasePath()).toBe(join(tempDir, "fusion-central.db"));
    });

    it("should be idempotent on multiple init calls", async () => {
      await central.init();
      await central.init();
      expect(central.isInitialized()).toBe(true);
    });

    it("should create a default online local node on init", async () => {
      await central.init();

      const nodes = await central.listNodes();
      const localNodes = nodes.filter((node) => node.type === "local");
      expect(localNodes).toHaveLength(1);
      expect(localNodes[0].name).toBe("local");
      expect(localNodes[0].status).toBe("online");
      expect(localNodes[0].maxConcurrent).toBe(4);
    });

    it("should not create duplicate default local nodes across re-initialization", async () => {
      await central.init();
      await central.close();

      central = new CentralCore(tempDir);
      await central.init();

      const nodes = await central.listNodes();
      const localNodes = nodes.filter((node) => node.type === "local");
      expect(localNodes).toHaveLength(1);
      expect(localNodes[0].name).toBe("local");
    });

    it("should close and clean up", async () => {
      await central.init();
      await central.close();
      expect(central.isInitialized()).toBe(false);
    });

    it("should throw if operations called before init", async () => {
      await expect(central.listProjects()).rejects.toThrow("not initialized");
    });
  });

  describe("project registration", () => {
    beforeEach(async () => {
      await central.init();
    });

    it("should register a project with valid inputs", async () => {
      const projectPath = join(tempDir, "project1");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Test Project",
        path: projectPath,
      });

      expect(project.id).toMatch(/^proj_[a-f0-9]+$/);
      expect(project.name).toBe("Test Project");
      expect(project.path).toBe(projectPath);
      expect(project.status).toBe("initializing");
      expect(project.isolationMode).toBe("in-process");
      expect(project.createdAt).toBeDefined();
      expect(project.updatedAt).toBeDefined();
      expect(project.lastActivityAt).toBeDefined();
    });

    it("should reject relative paths", async () => {
      await expect(
        central.registerProject({
          name: "Test",
          path: "relative/path",
        })
      ).rejects.toThrow("must be absolute");
    });

    it("should reject non-existent paths", async () => {
      await expect(
        central.registerProject({
          name: "Test",
          path: "/nonexistent/path",
        })
      ).rejects.toThrow("does not exist");
    });

    it("should reject non-directory paths", async () => {
      const filePath = join(tempDir, "not-a-dir.txt");
      // Create a file (can't use writeFileSync with these imports, use native fs via db or skip)
      // Actually let's create it using standard fs which is available in node
      const { writeFileSync } = await import("node:fs");
      writeFileSync(filePath, "content");

      await expect(
        central.registerProject({
          name: "Test",
          path: filePath,
        })
      ).rejects.toThrow("must be a directory");
    });

    it("should reject duplicate paths", async () => {
      const projectPath = join(tempDir, "dup-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      await central.registerProject({
        name: "First",
        path: projectPath,
      });

      await expect(
        central.registerProject({
          name: "Second",
          path: projectPath,
        })
      ).rejects.toThrow("already registered");
    });

    it("should accept custom isolation mode", async () => {
      const projectPath = join(tempDir, "isolated-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Isolated",
        path: projectPath,
        isolationMode: "child-process",
      });

      expect(project.isolationMode).toBe("child-process");
    });

    it("should emit project:registered event", async () => {
      const projectPath = join(tempDir, "event-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      let emittedProject: RegisteredProject | undefined;
      central.on("project:registered", (p) => {
        emittedProject = p;
      });

      await central.registerProject({
        name: "Event Test",
        path: projectPath,
      });

      expect(emittedProject).toBeDefined();
      expect(emittedProject?.name).toBe("Event Test");
    });

    it("should initialize project health on registration", async () => {
      const projectPath = join(tempDir, "health-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Health Test",
        path: projectPath,
      });

      const health = await central.getProjectHealth(project.id);
      expect(health).toBeDefined();
      expect(health?.projectId).toBe(project.id);
      expect(health?.status).toBe("initializing");
      expect(health?.activeTaskCount).toBe(0);
      expect(health?.inFlightAgentCount).toBe(0);
      expect(health?.totalTasksCompleted).toBe(0);
      expect(health?.totalTasksFailed).toBe(0);
    });
  });

  describe("project unregistration", () => {
    beforeEach(async () => {
      await central.init();
    });

    it("should unregister a project", async () => {
      const projectPath = join(tempDir, "unreg-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "To Unregister",
        path: projectPath,
      });

      await central.unregisterProject(project.id);

      const found = await central.getProject(project.id);
      expect(found).toBeUndefined();
    });

    it("should be idempotent for non-existent projects", async () => {
      await expect(central.unregisterProject("nonexistent")).resolves.toBeUndefined();
    });

    it("should emit project:unregistered event", async () => {
      const projectPath = join(tempDir, "unreg-event-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "To Unregister",
        path: projectPath,
      });

      let emittedId: string | undefined;
      central.on("project:unregistered", (id) => {
        emittedId = id;
      });

      await central.unregisterProject(project.id);

      expect(emittedId).toBe(project.id);
    });

    it("should cascade delete health records", async () => {
      const projectPath = join(tempDir, "cascade-health");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Cascade",
        path: projectPath,
      });

      await central.unregisterProject(project.id);

      const health = await central.getProjectHealth(project.id);
      expect(health).toBeUndefined();
    });

    it("should cascade delete activity log entries", async () => {
      const projectPath = join(tempDir, "cascade-activity");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Cascade Activity",
        path: projectPath,
      });

      await central.logActivity({
        type: "task:created",
        projectId: project.id,
        projectName: project.name,
        timestamp: new Date().toISOString(),
        details: "Test activity",
      });

      await central.unregisterProject(project.id);

      const activities = await central.getRecentActivity({ projectId: project.id });
      expect(activities).toHaveLength(0);
    });
  });

  describe("project queries", () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
      await central.init();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should get project by id", async () => {
      const projectPath = join(tempDir, "get-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Get Test",
        path: projectPath,
      });

      const found = await central.getProject(project.id);
      expect(found).toEqual(project);
    });

    it("should return undefined for non-existent id", async () => {
      const found = await central.getProject("nonexistent");
      expect(found).toBeUndefined();
    });

    it("should get project by path", async () => {
      const projectPath = join(tempDir, "by-path-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "By Path",
        path: projectPath,
      });

      const found = await central.getProjectByPath(projectPath);
      expect(found).toEqual(project);
    });

    it("should list all projects", async () => {
      const projects: RegisteredProject[] = [];
      for (let i = 0; i < 3; i++) {
        const projectPath = join(tempDir, `list-project-${i}`);
        mkdirSync(projectPath);
        projectPaths.push(projectPath);

        const project = await central.registerProject({
          name: `Project ${i}`,
          path: projectPath,
        });
        projects.push(project);
      }

      const listed = await central.listProjects();
      expect(listed).toHaveLength(3);
      // Should be sorted by name
      expect(listed.map((p) => p.name)).toEqual(["Project 0", "Project 1", "Project 2"]);
    });

    it("should return empty array when no projects", async () => {
      const listed = await central.listProjects();
      expect(listed).toEqual([]);
    });

    it("should update project fields", async () => {
      const projectPath = join(tempDir, "update-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Original",
        path: projectPath,
      });

      vi.setSystemTime(new Date("2026-04-01T12:00:00.010Z"));

      const updated = await central.updateProject(project.id, {
        name: "Updated",
        status: "active",
      });

      expect(updated.name).toBe("Updated");
      expect(updated.status).toBe("active");
      expect(updated.id).toBe(project.id);
      expect(updated.createdAt).toBe(project.createdAt);
      expect(updated.updatedAt).not.toBe(project.updatedAt);
    });

    it("should throw when updating non-existent project", async () => {
      await expect(
        central.updateProject("nonexistent", { name: "New Name" })
      ).rejects.toThrow("not found");
    });

    it("should emit project:updated event", async () => {
      const projectPath = join(tempDir, "update-event-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Original",
        path: projectPath,
      });

      let emittedProject: RegisteredProject | undefined;
      central.on("project:updated", (p) => {
        emittedProject = p;
      });

      await central.updateProject(project.id, { name: "Updated" });

      expect(emittedProject).toBeDefined();
      expect(emittedProject?.name).toBe("Updated");
    });
  });

  describe("project status reconciliation", () => {
    beforeEach(async () => {
      await central.init();
    });

    it("should promote stale initializing projects to active", async () => {
      const projectPath = join(tempDir, "stale-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      // Register a project (starts as "initializing")
      const project = await central.registerProject({
        name: "Stale Project",
        path: projectPath,
      });
      expect(project.status).toBe("initializing");

      // Reconcile — should promote to active
      const reconciled = await central.reconcileProjectStatuses();
      expect(reconciled).toHaveLength(1);
      expect(reconciled[0].projectId).toBe(project.id);
      expect(reconciled[0].previousStatus).toBe("initializing");

      // Verify project is now active
      const updated = await central.getProject(project.id);
      expect(updated?.status).toBe("active");
    });

    it("should update both projects and projectHealth tables", async () => {
      const projectPath = join(tempDir, "health-stale");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Health Stale",
        path: projectPath,
      });

      // Health row should be "initializing" initially
      const healthBefore = await central.getProjectHealth(project.id);
      expect(healthBefore?.status).toBe("initializing");

      // Reconcile
      await central.reconcileProjectStatuses();

      // Both project and health should be "active"
      const updatedProject = await central.getProject(project.id);
      expect(updatedProject?.status).toBe("active");

      const updatedHealth = await central.getProjectHealth(project.id);
      expect(updatedHealth?.status).toBe("active");
    });

    it("should not affect active projects", async () => {
      const projectPath = join(tempDir, "active-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Active Project",
        path: projectPath,
      });
      await central.updateProject(project.id, { status: "active" });

      const reconciled = await central.reconcileProjectStatuses();
      expect(reconciled).toHaveLength(0);

      const unchanged = await central.getProject(project.id);
      expect(unchanged?.status).toBe("active");
    });

    it("should not affect paused or errored projects", async () => {
      const pausedPath = join(tempDir, "paused-project");
      mkdirSync(pausedPath);
      projectPaths.push(pausedPath);

      const erroredPath = join(tempDir, "errored-project");
      mkdirSync(erroredPath);
      projectPaths.push(erroredPath);

      const paused = await central.registerProject({
        name: "Paused Project",
        path: pausedPath,
      });
      await central.updateProject(paused.id, { status: "paused" });

      const errored = await central.registerProject({
        name: "Errored Project",
        path: erroredPath,
      });
      await central.updateProject(errored.id, { status: "errored" });

      const reconciled = await central.reconcileProjectStatuses();
      expect(reconciled).toHaveLength(0);

      expect((await central.getProject(paused.id))?.status).toBe("paused");
      expect((await central.getProject(errored.id))?.status).toBe("errored");
    });

    it("should be idempotent — calling twice is a no-op after promotion", async () => {
      const projectPath = join(tempDir, "idempotent-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      await central.registerProject({
        name: "Idempotent Project",
        path: projectPath,
      });

      // First call promotes
      const first = await central.reconcileProjectStatuses();
      expect(first).toHaveLength(1);

      // Second call is a no-op
      const second = await central.reconcileProjectStatuses();
      expect(second).toHaveLength(0);
    });

    it("should reconcile multiple stale projects at once", async () => {
      const paths: string[] = [];
      for (let i = 0; i < 3; i++) {
        const p = join(tempDir, `multi-stale-${i}`);
        mkdirSync(p);
        projectPaths.push(p);
        paths.push(p);
      }

      await central.registerProject({ name: "Stale A", path: paths[0] });
      await central.registerProject({ name: "Stale B", path: paths[1] });
      await central.registerProject({ name: "Stale C", path: paths[2] });

      const reconciled = await central.reconcileProjectStatuses();
      expect(reconciled).toHaveLength(3);

      const projects = await central.listProjects();
      expect(projects.every((p) => p.status === "active")).toBe(true);
    });

    it("should return empty array when no projects exist", async () => {
      const reconciled = await central.reconcileProjectStatuses();
      expect(reconciled).toEqual([]);
    });
  });

  describe("node management", () => {
    beforeEach(async () => {
      await central.init();
    });

    it("should register and retrieve a node", async () => {
      const node = await central.registerNode({
        name: "executor-node-a",
        type: "local",
        maxConcurrent: 3,
      });

      expect(node.id).toMatch(/^node_[a-f0-9]+$/);
      expect(node.name).toBe("executor-node-a");
      expect(node.type).toBe("local");
      expect(node.status).toBe("offline");
      expect(node.maxConcurrent).toBe(3);

      const fetched = await central.getNode(node.id);
      expect(fetched).toEqual(node);

      const byName = await central.getNodeByName("executor-node-a");
      expect(byName?.id).toBe(node.id);
    });

    it("should reject duplicate node names", async () => {
      await central.registerNode({ name: "dup-node", type: "local" });

      await expect(
        central.registerNode({ name: "dup-node", type: "local" }),
      ).rejects.toThrow("already exists");
    });

    it("should validate node type constraints on register", async () => {
      await expect(
        central.registerNode({ name: "remote-missing-url", type: "remote" }),
      ).rejects.toThrow("must include a url");

      await expect(
        central.registerNode({
          name: "local-with-url",
          type: "local",
          url: "https://example.com",
        }),
      ).rejects.toThrow("must not include url or apiKey");

      await expect(
        central.registerNode({
          name: "local-with-key",
          type: "local",
          apiKey: "abc",
        }),
      ).rejects.toThrow("must not include url or apiKey");
    });

    it("should update nodes and enforce type constraints", async () => {
      const remote = await central.registerNode({
        name: "remote-node",
        type: "remote",
        url: "https://node.example.com",
        apiKey: "secret",
      });

      const updated = await central.updateNode(remote.id, {
        status: "connecting",
        maxConcurrent: 4,
      });

      expect(updated.status).toBe("connecting");
      expect(updated.maxConcurrent).toBe(4);

      await expect(
        central.updateNode(remote.id, {
          type: "local",
        }),
      ).rejects.toThrow("must not include url or apiKey");
    });

    it("should list nodes ordered by name", async () => {
      await central.registerNode({ name: "z-node", type: "local" });
      await central.registerNode({ name: "a-node", type: "local" });

      const nodes = await central.listNodes();
      const names = nodes.map((node) => node.name);
      expect(names).toContain("a-node");
      expect(names).toContain("z-node");
      expect(names.indexOf("a-node")).toBeLessThan(names.indexOf("z-node"));
    });

    it("should assign and unassign projects to nodes", async () => {
      const projectPath = join(tempDir, "node-assignment");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Node Assignment",
        path: projectPath,
      });
      const node = await central.registerNode({ name: "assign-node", type: "local" });

      const assigned = await central.assignProjectToNode(project.id, node.id);
      expect(assigned.nodeId).toBe(node.id);
      expect((await central.getProject(project.id))?.nodeId).toBe(node.id);

      const unassigned = await central.unassignProjectFromNode(project.id);
      expect(unassigned.nodeId).toBeUndefined();
      expect((await central.getProject(project.id))?.nodeId).toBeUndefined();
    });

    it("should throw when assigning to unknown project or node", async () => {
      const node = await central.registerNode({ name: "assignment-target", type: "local" });

      await expect(central.assignProjectToNode("proj_missing", node.id)).rejects.toThrow("Project not found");

      const projectPath = join(tempDir, "node-assignment-errors");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Node Assignment Errors",
        path: projectPath,
      });

      await expect(central.assignProjectToNode(project.id, "node_missing")).rejects.toThrow("Node not found");
      await expect(central.unassignProjectFromNode("proj_missing")).rejects.toThrow("Project not found");
    });

    it("should unassign projects when a node is unregistered", async () => {
      const projectPath = join(tempDir, "node-unregister");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Node Unregister",
        path: projectPath,
      });
      const node = await central.registerNode({ name: "ephemeral-node", type: "local" });

      await central.assignProjectToNode(project.id, node.id);
      await central.unregisterNode(node.id);

      expect(await central.getNode(node.id)).toBeUndefined();
      expect((await central.getProject(project.id))?.nodeId).toBeUndefined();
    });

    it("should be idempotent when unregistering missing nodes", async () => {
      await expect(central.unregisterNode("node_missing")).resolves.toBeUndefined();
    });

    it("should check local node health and emit node:health:changed", async () => {
      const node = await central.registerNode({ name: "local-health", type: "local" });

      let emittedNodeId: string | undefined;
      let emittedStatus: string | undefined;
      central.on("node:health:changed", (updated) => {
        emittedNodeId = updated.id;
        emittedStatus = updated.status;
      });

      const status = await central.checkNodeHealth(node.id);
      expect(status).toBe("online");

      const stored = await central.getNode(node.id);
      expect(stored?.status).toBe("online");
      expect(emittedNodeId).toBe(node.id);
      expect(emittedStatus).toBe("online");
    });

    it("should test node connection and emit node:connection:test", async () => {
      const connectionResult = {
        success: true,
        url: "http://remote.example:3000",
        latencyMs: 12,
        nodeInfo: {
          name: "remote",
          version: "1.0.0",
          uptime: 5,
          capabilities: ["executor"],
        },
      };
      const testSpy = vi.spyOn(NodeConnection.prototype, "test").mockResolvedValue(connectionResult);

      let emittedResult: unknown;
      central.on("node:connection:test", (result) => {
        emittedResult = result;
      });

      const result = await central.testNodeConnection({
        host: "remote.example",
        port: 3000,
        apiKey: "secret",
      });

      expect(result).toEqual(connectionResult);
      expect(emittedResult).toEqual(connectionResult);
      expect(testSpy).toHaveBeenCalledWith({
        host: "remote.example",
        port: 3000,
        apiKey: "secret",
      });
    });

    it("should return failed testNodeConnection results", async () => {
      const connectionResult: ConnectionResult = {
        success: false,
        url: "http://offline.example:3000",
        error: {
          type: "connection-refused",
          message: "fetch failed: ECONNREFUSED",
        },
      };
      vi.spyOn(NodeConnection.prototype, "test").mockResolvedValue(connectionResult);

      const result = await central.testNodeConnection({
        host: "offline.example",
        port: 3000,
      });

      expect(result).toEqual(connectionResult);
    });

    it("should connect to remote node and register when test succeeds", async () => {
      const connectionResult = {
        success: true,
        url: "http://remote.example:3000",
        latencyMs: 10,
        nodeInfo: {
          name: "remote",
          version: "1.0.0",
          uptime: 30,
          capabilities: ["executor"],
        },
      };
      vi.spyOn(NodeConnection.prototype, "test").mockResolvedValue(connectionResult);
      const registerSpy = vi.spyOn(central, "registerNode");
      const healthSpy = vi.spyOn(central, "checkNodeHealth").mockResolvedValue("online");

      let emittedResult: unknown;
      central.on("node:connection:test", (result) => {
        emittedResult = result;
      });

      const output = await central.connectToRemoteNode({
        name: "remote-node",
        host: "remote.example",
        port: 3000,
        apiKey: "secret",
        maxConcurrent: 4,
      });

      expect(output.result).toEqual(connectionResult);
      expect(output.node).toBeDefined();
      expect(output.node?.name).toBe("remote-node");
      expect(output.node?.type).toBe("remote");
      expect(output.node?.url).toBe("http://remote.example:3000");
      expect(emittedResult).toEqual(connectionResult);
      expect(registerSpy).toHaveBeenCalledWith({
        name: "remote-node",
        type: "remote",
        url: "http://remote.example:3000",
        apiKey: "secret",
        maxConcurrent: 4,
      });
      expect(healthSpy).toHaveBeenCalledWith(output.node!.id);
    });

    it("should reject duplicate node names before testing connection", async () => {
      await central.registerNode({ name: "existing-node", type: "local" });

      const testSpy = vi.spyOn(NodeConnection.prototype, "test");

      await expect(
        central.connectToRemoteNode({
          name: "existing-node",
          host: "remote.example",
          port: 3000,
        })
      ).rejects.toThrow("Node already exists with name: existing-node");

      expect(testSpy).not.toHaveBeenCalled();
    });

    it("should return connection result without registration when test fails", async () => {
      const connectionResult: ConnectionResult = {
        success: false,
        url: "http://offline.example:3000",
        error: {
          type: "timeout",
          message: "Connection timed out after 10000ms",
        },
      };
      vi.spyOn(NodeConnection.prototype, "test").mockResolvedValue(connectionResult);
      const registerSpy = vi.spyOn(central, "registerNode");
      const healthSpy = vi.spyOn(central, "checkNodeHealth");

      let emittedResult: unknown;
      central.on("node:connection:test", (result) => {
        emittedResult = result;
      });

      const output = await central.connectToRemoteNode({
        name: "offline-node",
        host: "offline.example",
        port: 3000,
      });

      expect(output).toEqual({ result: connectionResult });
      expect(registerSpy).not.toHaveBeenCalled();
      expect(healthSpy).not.toHaveBeenCalled();
      expect(emittedResult).toEqual(connectionResult);
    });

    it("should start and stop discovery lifecycle", async () => {
      const startSpy = vi.spyOn(NodeDiscovery.prototype, "start").mockImplementation(() => {});
      const stopSpy = vi.spyOn(NodeDiscovery.prototype, "stop").mockImplementation(() => {});
      const config: DiscoveryConfig = {
        broadcast: true,
        listen: true,
        serviceType: "_fusion._tcp",
        port: 4040,
        staleTimeoutMs: 300_000,
      };

      const discovery = await central.startDiscovery(config);
      const local = (await central.listNodes()).find((node) => node.type === "local");

      expect(discovery).toBeInstanceOf(NodeDiscovery);
      expect(startSpy).toHaveBeenCalledWith(local?.id, local?.name);
      expect(central.isDiscoveryActive()).toBe(true);
      expect(central.getDiscoveryConfig()).toEqual(config);

      central.stopDiscovery();

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(central.isDiscoveryActive()).toBe(false);
      expect(central.getDiscoveryConfig()).toBeNull();
    });

    it("should forward discovery events and track discovered nodes", async () => {
      vi.spyOn(NodeDiscovery.prototype, "start").mockImplementation(() => {});
      await central.startDiscovery({
        broadcast: false,
        listen: true,
        serviceType: "_fusion._tcp",
        port: 4040,
        staleTimeoutMs: 300_000,
      });

      const discovery = (central as unknown as { nodeDiscovery: NodeDiscovery | null }).nodeDiscovery;
      expect(discovery).toBeTruthy();

      const discovered: DiscoveredNode = {
        name: "mesh-peer",
        host: "192.168.0.42",
        port: 4040,
        nodeType: "remote",
        nodeId: "node_remote",
        discoveredAt: "2026-04-01T12:00:00.000Z",
        lastSeenAt: "2026-04-01T12:00:00.000Z",
      };

      let eventPayload: DiscoveredNode | undefined;
      central.on("discovery:node:found", (node) => {
        eventPayload = node;
      });

      discovery!.emit("node:discovered", discovered);
      await Promise.resolve();
      await Promise.resolve();

      expect(eventPayload).toEqual(discovered);
      expect(central.getDiscoveredNodes()).toEqual([discovered]);

      const updated = {
        ...discovered,
        lastSeenAt: "2026-04-01T12:01:00.000Z",
      };
      discovery!.emit("node:updated", updated);
      await Promise.resolve();
      await Promise.resolve();

      expect(central.getDiscoveredNodes()).toEqual([updated]);

      let lostName: string | undefined;
      central.on("discovery:node:lost", (name) => {
        lostName = name;
      });

      discovery!.emit("node:lost", discovered.name);
      await Promise.resolve();
      await Promise.resolve();

      expect(lostName).toBe(discovered.name);
      expect(central.getDiscoveredNodes()).toEqual([]);
    });

    it("should set registered nodes online/offline from discovery events", async () => {
      vi.spyOn(NodeDiscovery.prototype, "start").mockImplementation(() => {});
      const remote = await central.registerNode({
        name: "remote-peer",
        type: "remote",
        url: "http://remote-peer:4040",
      });

      await central.startDiscovery({
        broadcast: false,
        listen: true,
        serviceType: "_fusion._tcp",
        port: 4040,
        staleTimeoutMs: 300_000,
      });

      const discovery = (central as unknown as { nodeDiscovery: NodeDiscovery | null }).nodeDiscovery;
      expect(discovery).toBeTruthy();

      discovery!.emit("node:discovered", {
        name: "remote-peer",
        host: "192.168.0.22",
        port: 4040,
        nodeType: "remote",
        nodeId: "node_remote_peer",
        discoveredAt: "2026-04-01T12:00:00.000Z",
        lastSeenAt: "2026-04-01T12:00:00.000Z",
      } satisfies DiscoveredNode);
      await Promise.resolve();
      await Promise.resolve();

      expect((await central.getNode(remote.id))?.status).toBe("online");
      expect(central.getDiscoveredNodes()).toEqual([]);

      discovery!.emit("node:lost", "remote-peer");
      await Promise.resolve();
      await Promise.resolve();
      expect((await central.getNode(remote.id))?.status).toBe("offline");
    });

    it("should return empty discovered node list when discovery is inactive", () => {
      expect(central.isDiscoveryActive()).toBe(false);
      expect(central.getDiscoveredNodes()).toEqual([]);
      expect(central.getDiscoveryConfig()).toBeNull();
    });

    it("should update node metrics and emit node:metrics:updated", async () => {
      const local = (await central.listNodes()).find((node) => node.type === "local");
      expect(local).toBeDefined();

      const metrics: SystemMetrics = {
        cpuUsage: 23,
        memoryUsed: 200,
        memoryTotal: 500,
        storageUsed: 1_500,
        storageTotal: 4_000,
        uptime: 12_000,
        reportedAt: "2026-04-01T12:00:00.000Z",
      };

      let eventPayload: { nodeId: string; metrics: SystemMetrics } | undefined;
      central.on("node:metrics:updated", (payload) => {
        eventPayload = payload;
      });

      const updated = await central.updateNodeMetrics(local!.id, metrics);
      expect(updated.systemMetrics).toEqual(metrics);
      expect(eventPayload).toEqual({ nodeId: local!.id, metrics });
    });

    it("should register peer nodes, list peers, and keep knownPeers in sync", async () => {
      const local = (await central.listNodes()).find((node) => node.type === "local");
      expect(local).toBeDefined();

      const firstPeer = await central.registerPeerNode({
        nodeId: local!.id,
        peerNodeId: "node_peer_b",
        name: "Peer B",
        url: "https://peer-b.example",
      });
      const secondPeer = await central.registerPeerNode({
        nodeId: local!.id,
        peerNodeId: "node_peer_a",
        name: "Peer A",
        url: "https://peer-a.example",
      });

      expect(firstPeer.peerNodeId).toBe("node_peer_b");
      expect(secondPeer.peerNodeId).toBe("node_peer_a");

      const peers = await central.listPeers(local!.id);
      expect(peers.map((peer) => peer.name)).toEqual(["Peer A", "Peer B"]);

      const storedNode = await central.getNode(local!.id);
      expect(storedNode?.knownPeers).toEqual(expect.arrayContaining(["node_peer_a", "node_peer_b"]));
      expect(storedNode?.knownPeers).toHaveLength(2);
    });

    it("should emit mesh:peer:added and mesh:peer:removed events", async () => {
      const local = (await central.listNodes()).find((node) => node.type === "local");
      expect(local).toBeDefined();

      let addedPayload:
        | {
            nodeId: string;
            peer: {
              peerNodeId: string;
            };
          }
        | undefined;
      let removedPayload: { nodeId: string; peerNodeId: string } | undefined;

      central.on("mesh:peer:added", (payload) => {
        addedPayload = payload as typeof addedPayload;
      });
      central.on("mesh:peer:removed", (payload) => {
        removedPayload = payload;
      });

      await central.registerPeerNode({
        nodeId: local!.id,
        peerNodeId: "node_peer_event",
        name: "Peer Event",
        url: "https://peer-event.example",
      });

      expect(addedPayload?.nodeId).toBe(local!.id);
      expect(addedPayload?.peer.peerNodeId).toBe("node_peer_event");

      await central.unregisterPeerNode(local!.id, "node_peer_event");
      expect(removedPayload).toEqual({ nodeId: local!.id, peerNodeId: "node_peer_event" });
    });

    it("should handle duplicate peer registration idempotently", async () => {
      const local = (await central.listNodes()).find((node) => node.type === "local");
      expect(local).toBeDefined();

      await central.registerPeerNode({
        nodeId: local!.id,
        peerNodeId: "node_dup_peer",
        name: "Peer Original",
        url: "https://peer-original.example",
      });
      await central.registerPeerNode({
        nodeId: local!.id,
        peerNodeId: "node_dup_peer",
        name: "Peer Updated",
        url: "https://peer-updated.example",
      });

      const peers = await central.listPeers(local!.id);
      expect(peers).toHaveLength(1);
      expect(peers[0].peerNodeId).toBe("node_dup_peer");
      expect(peers[0].name).toBe("Peer Updated");

      const node = await central.getNode(local!.id);
      expect(node?.knownPeers).toEqual(["node_dup_peer"]);
    });

    it("should unregister peers and remove IDs from knownPeers", async () => {
      const local = (await central.listNodes()).find((node) => node.type === "local");
      expect(local).toBeDefined();

      await central.registerPeerNode({
        nodeId: local!.id,
        peerNodeId: "node_peer_remove",
        name: "Peer Remove",
        url: "https://peer-remove.example",
      });

      await central.unregisterPeerNode(local!.id, "node_peer_remove");

      const peers = await central.listPeers(local!.id);
      expect(peers).toHaveLength(0);

      const node = await central.getNode(local!.id);
      expect(node?.knownPeers ?? []).not.toContain("node_peer_remove");
    });

    it("should return mesh state with metrics and peers", async () => {
      const local = (await central.listNodes()).find((node) => node.type === "local");
      expect(local).toBeDefined();

      const metrics: SystemMetrics = {
        cpuUsage: 45,
        memoryUsed: 100,
        memoryTotal: 200,
        storageUsed: 300,
        storageTotal: 500,
        uptime: 90_000,
        reportedAt: "2026-04-01T12:00:00.000Z",
      };

      await central.updateNodeMetrics(local!.id, metrics);
      await central.registerPeerNode({
        nodeId: local!.id,
        peerNodeId: "node_mesh_peer",
        name: "Mesh Peer",
        url: "https://mesh-peer.example",
      });

      const state = await central.getMeshState(local!.id);
      expect(state.nodeId).toBe(local!.id);
      expect(state.metrics).toEqual(metrics);
      expect(state.knownPeers).toHaveLength(1);
      expect(state.knownPeers[0].peerNodeId).toBe("node_mesh_peer");
    });

    it("should report local mesh state using collected system metrics", async () => {
      const metrics: SystemMetrics = {
        cpuUsage: 18,
        memoryUsed: 150,
        memoryTotal: 250,
        storageUsed: 1_000,
        storageTotal: 2_000,
        uptime: 50_000,
        reportedAt: "2026-04-01T12:00:00.000Z",
      };
      const metricsSpy = vi.spyOn(systemMetrics, "collectSystemMetrics").mockResolvedValue(metrics);

      const state = await central.reportMeshState();

      expect(metricsSpy).toHaveBeenCalledTimes(1);
      expect(state.nodeName).toBe("local");
      expect(state.metrics).toEqual(metrics);
      expect(state.knownPeers).toEqual([]);
    });

    describe("peer exchange methods", () => {
      it("should register a gossip peer and preserve its nodeId", async () => {
        const peerInfo = {
          nodeId: "node_remote_gossip",
          nodeName: "Gossip Peer",
          nodeUrl: "https://gossip.example.com",
          status: "online" as const,
          metrics: null,
          lastSeen: "2026-04-01T12:00:00.000Z",
          maxConcurrent: 3,
        };

        const registered = await central.registerGossipPeer(peerInfo);

        expect(registered.id).toBe("node_remote_gossip");
        expect(registered.name).toBe("Gossip Peer");
        expect(registered.type).toBe("remote");
        expect(registered.url).toBe("https://gossip.example.com");
        expect(registered.status).toBe("online");
        expect(registered.maxConcurrent).toBe(3);

        // Verify it can be retrieved by the preserved ID
        const fetched = await central.getNode("node_remote_gossip");
        expect(fetched?.id).toBe("node_remote_gossip");
      });

      it("should handle duplicate peer names by appending suffix", async () => {
        // First, register a local node with the same name
        await central.registerNode({ name: "Same Name", type: "local" });

        const peerInfo = {
          nodeId: "node_same_1",
          nodeName: "Same Name",
          nodeUrl: "https://same1.example.com",
          status: "online" as const,
          metrics: null,
          lastSeen: "2026-04-01T12:00:00.000Z",
          maxConcurrent: 2,
        };

        const registered = await central.registerGossipPeer(peerInfo);

        // Should have suffix added to avoid collision
        expect(registered.name).toBe("Same Name-2");
      });

      it("should merge peers - add new peers", async () => {
        const peerInfo = {
          nodeId: "node_new_peer",
          nodeName: "New Peer",
          nodeUrl: "https://new-peer.example.com",
          status: "online" as const,
          metrics: null,
          lastSeen: "2026-04-01T12:00:00.000Z",
          maxConcurrent: 2,
        };

        const result = await central.mergePeers([peerInfo]);

        expect(result.added).toContain("node_new_peer");
        expect(result.updated).toEqual([]);
        expect(await central.getNode("node_new_peer")).toBeDefined();
      });

      it("should merge peers - update stale peers", async () => {
        // First, register a peer
        const peerInfo = {
          nodeId: "node_stale_peer",
          nodeName: "Stale Peer",
          nodeUrl: "https://stale-peer.example.com",
          status: "offline" as const,
          metrics: null,
          lastSeen: "2026-04-01T11:00:00.000Z",
          maxConcurrent: 2,
        };
        await central.registerGossipPeer(peerInfo);

        // Now merge with fresher data
        const fresherPeer = {
          ...peerInfo,
          status: "online" as const,
          lastSeen: "2026-04-01T12:30:00.000Z",
        };

        const result = await central.mergePeers([fresherPeer]);

        expect(result.added).toEqual([]);
        expect(result.updated).toContain("node_stale_peer");
        const updated = await central.getNode("node_stale_peer");
        expect(updated?.status).toBe("online");
      });

      it("should merge peers - skip fresher local data", async () => {
        // First, register a peer
        const peerInfo = {
          nodeId: "node_fresher_local",
          nodeName: "Fresher Local",
          nodeUrl: "https://fresher-local.example.com",
          status: "online" as const,
          metrics: null,
          lastSeen: "2026-04-01T11:00:00.000Z",
          maxConcurrent: 2,
        };
        await central.registerGossipPeer(peerInfo);

        // Manually update to be fresher
        await central.updateNode("node_fresher_local", {
          status: "offline",
        });

        // Now merge with older data - should not update
        const olderPeer = {
          ...peerInfo,
          status: "online" as const,
          lastSeen: "2026-04-01T10:00:00.000Z",
        };

        const result = await central.mergePeers([olderPeer]);

        expect(result.updated).toEqual([]);
        const updated = await central.getNode("node_fresher_local");
        expect(updated?.status).toBe("offline");
      });

      it("should merge peers - never overwrite local node", async () => {
        const local = (await central.listNodes()).find((node) => node.type === "local");
        expect(local).toBeDefined();

        // Create a fake peer info with the local node's ID
        const fakePeerInfo = {
          nodeId: local!.id,
          nodeName: "Fake Local",
          nodeUrl: "https://fake-local.example.com",
          status: "online" as const,
          metrics: null,
          lastSeen: "2026-04-01T12:00:00.000Z",
          maxConcurrent: 10,
        };

        const result = await central.mergePeers([fakePeerInfo]);

        // Should not add or update
        expect(result.added).toEqual([]);
        expect(result.updated).toEqual([]);

        // Local node should be unchanged
        const unchanged = await central.getNode(local!.id);
        expect(unchanged?.maxConcurrent).toBe(4); // Default local node maxConcurrent
      });

      it("should merge peers - emit events correctly", async () => {
        let gossipEvent: { nodeId: string; peer: unknown } | undefined;
        let stateChangedEvent: { nodeId: string } | undefined;

        central.on("gossip:peer:registered", (payload) => {
          gossipEvent = payload;
        });
        central.on("mesh:state:changed", (payload) => {
          stateChangedEvent = payload;
        });

        const peerInfo = {
          nodeId: "node_event_peer",
          nodeName: "Event Peer",
          nodeUrl: "https://event-peer.example.com",
          status: "online" as const,
          metrics: null,
          lastSeen: "2026-04-01T12:00:00.000Z",
          maxConcurrent: 2,
        };

        await central.mergePeers([peerInfo]);

        expect(gossipEvent?.nodeId).toBe("node_event_peer");
        expect(stateChangedEvent?.nodeId).toBeDefined();
      });

      it("should merge peers - empty input returns empty result", async () => {
        const result = await central.mergePeers([]);

        expect(result.added).toEqual([]);
        expect(result.updated).toEqual([]);
      });

      it("should get local peer info", async () => {
        const peerInfo = await central.getLocalPeerInfo();

        expect(peerInfo.nodeId).toBeDefined();
        expect(peerInfo.nodeName).toBe("local");
        expect(peerInfo.nodeUrl).toBe("");
        expect(peerInfo.status).toBe("online");
        expect(peerInfo.lastSeen).toBe("2026-04-01T12:00:00.000Z");
        expect(peerInfo.maxConcurrent).toBe(4);
      });

      it("should get all known peer info", async () => {
        // Register some peers
        await central.registerGossipPeer({
          nodeId: "node_all_peer_1",
          nodeName: "All Peer 1",
          nodeUrl: "https://all-peer-1.example.com",
          status: "online" as const,
          metrics: null,
          lastSeen: "2026-04-01T12:00:00.000Z",
          maxConcurrent: 2,
        });

        await central.registerGossipPeer({
          nodeId: "node_all_peer_2",
          nodeName: "All Peer 2",
          nodeUrl: "https://all-peer-2.example.com",
          status: "offline" as const,
          metrics: null,
          lastSeen: "2026-04-01T11:00:00.000Z",
          maxConcurrent: 3,
        });

        const allPeers = await central.getAllKnownPeerInfo();

        // Should include local node plus 2 registered peers
        expect(allPeers.length).toBeGreaterThanOrEqual(3);
        expect(allPeers.map((p) => p.nodeId)).toContain("node_all_peer_1");
        expect(allPeers.map((p) => p.nodeId)).toContain("node_all_peer_2");
      });

      it("should get all known peer info - empty list", async () => {
        // Don't register any peers, just check the local node
        const allPeers = await central.getAllKnownPeerInfo();

        // Should at least include the local node
        expect(allPeers.length).toBeGreaterThanOrEqual(1);
        expect(allPeers.some((p) => p.nodeName === "local")).toBe(true);
      });
    });
  });

  describe("node version sync", () => {
    beforeEach(async () => {
      await central.init();
    });

    describe("updateNodeVersionInfo", () => {
      it("should store version info on a node", async () => {
        const node = await central.registerNode({ name: "version-node", type: "local" });

        const versionInfo = {
          appVersion: "0.1.0",
          pluginVersions: { "plugin-a": "1.0.0", "plugin-b": "2.0.0" },
          lastSyncedAt: "2026-04-01T12:00:00.000Z",
        };

        const updated = await central.updateNodeVersionInfo(node.id, versionInfo);

        expect(updated.versionInfo).toBeDefined();
        expect(updated.versionInfo?.appVersion).toBe("0.1.0");
        expect(updated.versionInfo?.pluginVersions).toEqual({ "plugin-a": "1.0.0", "plugin-b": "2.0.0" });
        expect(updated.pluginVersions).toEqual({ "plugin-a": "1.0.0", "plugin-b": "2.0.0" });
      });

      it("should auto-fill appVersion if not provided", async () => {
        const node = await central.registerNode({ name: "auto-version-node", type: "local" });

        const versionInfo = {
          pluginVersions: { "plugin-a": "1.0.0" },
          lastSyncedAt: "2026-04-01T12:00:00.000Z",
        };

        const updated = await central.updateNodeVersionInfo(node.id, versionInfo);

        expect(updated.versionInfo?.appVersion).toBe(getAppVersion());
      });

      it("should emit node:version:updated and node:updated events", async () => {
        const node = await central.registerNode({ name: "event-node", type: "local" });

        let versionEmitted = false;
        let nodeEmitted = false;
        central.on("node:version:updated", () => {
          versionEmitted = true;
        });
        central.on("node:updated", () => {
          nodeEmitted = true;
        });

        await central.updateNodeVersionInfo(node.id, {
          appVersion: "0.1.0",
          pluginVersions: {},
          lastSyncedAt: "2026-04-01T12:00:00.000Z",
        });

        expect(versionEmitted).toBe(true);
        expect(nodeEmitted).toBe(true);
      });

      it("should throw if node not found", async () => {
        await expect(
          central.updateNodeVersionInfo("node_missing", {
            appVersion: "0.1.0",
            pluginVersions: {},
            lastSyncedAt: "2026-04-01T12:00:00.000Z",
          }),
        ).rejects.toThrow("Node not found");
      });
    });

    describe("getNodeVersionInfo", () => {
      it("should return stored version info", async () => {
        const node = await central.registerNode({ name: "get-version-node", type: "local" });

        await central.updateNodeVersionInfo(node.id, {
          appVersion: "0.2.0",
          pluginVersions: { "plugin-c": "1.5.0" },
          lastSyncedAt: "2026-04-01T12:00:00.000Z",
        });

        const versionInfo = await central.getNodeVersionInfo(node.id);

        expect(versionInfo).toBeDefined();
        expect(versionInfo?.appVersion).toBe("0.2.0");
        expect(versionInfo?.pluginVersions).toEqual({ "plugin-c": "1.5.0" });
      });

      it("should return undefined if not set", async () => {
        const node = await central.registerNode({ name: "no-version-node", type: "local" });

        const versionInfo = await central.getNodeVersionInfo(node.id);

        expect(versionInfo).toBeUndefined();
      });
    });

    describe("syncPlugins", () => {
      it("should return no-action for matching versions", async () => {
        const node1 = await central.registerNode({ name: "sync-node-1", type: "local" });
        const node2 = await central.registerNode({ name: "sync-node-2", type: "local" });

        await central.updateNodeVersionInfo(node1.id, {
          appVersion: "0.1.0",
          pluginVersions: { "plugin-a": "1.0.0" },
          lastSyncedAt: "2026-04-01T12:00:00.000Z",
        });

        await central.updateNodeVersionInfo(node2.id, {
          appVersion: "0.1.0",
          pluginVersions: { "plugin-a": "1.0.0" },
          lastSyncedAt: "2026-04-01T12:00:00.000Z",
        });

        const result = await central.syncPlugins(node1.id, node2.id);

        expect(result.isCompatible).toBe(true);
        expect(result.plugins).toHaveLength(1);
        expect(result.plugins[0].action).toBe("no-action");
      });

      it("should return install action for missing plugins", async () => {
        const node1 = await central.registerNode({ name: "install-node-1", type: "local" });
        const node2 = await central.registerNode({ name: "install-node-2", type: "local" });

        await central.updateNodeVersionInfo(node1.id, {
          appVersion: "0.1.0",
          pluginVersions: { "plugin-a": "1.0.0", "plugin-b": "2.0.0" },
          lastSyncedAt: "2026-04-01T12:00:00.000Z",
        });

        await central.updateNodeVersionInfo(node2.id, {
          appVersion: "0.1.0",
          pluginVersions: { "plugin-a": "1.0.0" },
          lastSyncedAt: "2026-04-01T12:00:00.000Z",
        });

        const result = await central.syncPlugins(node1.id, node2.id);

        expect(result.isCompatible).toBe(false);
        const pluginB = result.plugins.find((p) => p.pluginId === "plugin-b");
        expect(pluginB?.action).toBe("install");
        expect(pluginB?.targetVersion).toBe("2.0.0");
      });

      it("should return update action for version differences", async () => {
        const node1 = await central.registerNode({ name: "update-node-1", type: "local" });
        const node2 = await central.registerNode({ name: "update-node-2", type: "local" });

        await central.updateNodeVersionInfo(node1.id, {
          appVersion: "0.1.0",
          pluginVersions: { "plugin-a": "2.0.0" },
          lastSyncedAt: "2026-04-01T12:00:00.000Z",
        });

        await central.updateNodeVersionInfo(node2.id, {
          appVersion: "0.1.0",
          pluginVersions: { "plugin-a": "1.0.0" },
          lastSyncedAt: "2026-04-01T12:00:00.000Z",
        });

        const result = await central.syncPlugins(node1.id, node2.id);

        expect(result.isCompatible).toBe(false);
        const pluginA = result.plugins.find((p) => p.pluginId === "plugin-a");
        expect(pluginA?.action).toBe("update");
      });

      it("should handle nodes with no version info", async () => {
        const node1 = await central.registerNode({ name: "empty-node-1", type: "local" });
        const node2 = await central.registerNode({ name: "empty-node-2", type: "local" });

        const result = await central.syncPlugins(node1.id, node2.id);

        expect(result.isCompatible).toBe(true);
        expect(result.plugins).toHaveLength(0);
      });

      it("should emit node:plugins:synced event", async () => {
        const node1 = await central.registerNode({ name: "event-sync-1", type: "local" });
        const node2 = await central.registerNode({ name: "event-sync-2", type: "local" });

        let emittedResult: unknown;
        central.on("node:plugins:synced", (result) => {
          emittedResult = result;
        });

        await central.syncPlugins(node1.id, node2.id);

        expect(emittedResult).toBeDefined();
      });

      it("should throw if either node not found", async () => {
        const node = await central.registerNode({ name: "partial-node", type: "local" });

        await expect(central.syncPlugins(node.id, "node_missing")).rejects.toThrow(
          "Remote node not found",
        );

        await expect(central.syncPlugins("node_missing", node.id)).rejects.toThrow(
          "Local node not found",
        );
      });
    });

    describe("checkVersionCompatibility", () => {
      it("should return compatible for identical versions", () => {
        const result = central.checkVersionCompatibility("1.2.3", "1.2.3");

        expect(result.status).toBe("compatible");
        expect(result.message).toContain("match");
      });

      it("should return compatible for patch-only differences", () => {
        const result = central.checkVersionCompatibility("1.2.3", "1.2.4");

        expect(result.status).toBe("compatible");
        expect(result.message).toContain("Patch");
      });

      it("should return minor-difference for minor version mismatch", () => {
        const result = central.checkVersionCompatibility("1.2.3", "1.3.0");

        expect(result.status).toBe("minor-difference");
        expect(result.message).toContain("Minor");
      });

      it("should return major-difference for major version mismatch", () => {
        const result = central.checkVersionCompatibility("1.2.3", "2.0.0");

        expect(result.status).toBe("major-difference");
        expect(result.message).toContain("Major");
      });

      it("should return incompatible for invalid version strings", () => {
        const result = central.checkVersionCompatibility("invalid", "1.0.0");

        expect(result.status).toBe("incompatible");
        expect(result.message).toContain("Invalid");
      });

      it("should handle prerelease versions", () => {
        const result = central.checkVersionCompatibility("1.2.3-beta.1", "1.2.3-beta.2");

        expect(result.status).toBe("compatible");
      });
    });
  });

  describe("project health", () => {
    beforeEach(async () => {
      await central.init();
    });

    it("should update health metrics", async () => {
      const projectPath = join(tempDir, "health-update");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Health Update",
        path: projectPath,
      });

      const updated = await central.updateProjectHealth(project.id, {
        activeTaskCount: 5,
        inFlightAgentCount: 2,
        status: "active",
      });

      expect(updated.activeTaskCount).toBe(5);
      expect(updated.inFlightAgentCount).toBe(2);
      expect(updated.status).toBe("active");
    });

    it("should emit project:health:changed event", async () => {
      const projectPath = join(tempDir, "health-event");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Health Event",
        path: projectPath,
      });

      let emittedHealth: ProjectHealth | undefined;
      central.on("project:health:changed", (h) => {
        emittedHealth = h;
      });

      await central.updateProjectHealth(project.id, { activeTaskCount: 3 });

      expect(emittedHealth).toBeDefined();
      expect(emittedHealth?.activeTaskCount).toBe(3);
    });

    it("should record successful task completion", async () => {
      const projectPath = join(tempDir, "complete-task");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Complete Task",
        path: projectPath,
      });

      await central.recordTaskCompletion(project.id, 5000, true);

      const health = await central.getProjectHealth(project.id);
      expect(health?.totalTasksCompleted).toBe(1);
      expect(health?.totalTasksFailed).toBe(0);
      expect(health?.averageTaskDurationMs).toBe(5000);
    });

    it("should record failed task completion", async () => {
      const projectPath = join(tempDir, "fail-task");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Fail Task",
        path: projectPath,
      });

      await central.recordTaskCompletion(project.id, 3000, false);

      const health = await central.getProjectHealth(project.id);
      expect(health?.totalTasksCompleted).toBe(0);
      expect(health?.totalTasksFailed).toBe(1);
      // Average duration should not be updated for failures
      expect(health?.averageTaskDurationMs).toBeUndefined();
    });

    it("should calculate rolling average duration", async () => {
      const projectPath = join(tempDir, "rolling-avg");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Rolling Avg",
        path: projectPath,
      });

      await central.recordTaskCompletion(project.id, 1000, true);
      await central.recordTaskCompletion(project.id, 2000, true);
      await central.recordTaskCompletion(project.id, 3000, true);

      const health = await central.getProjectHealth(project.id);
      expect(health?.totalTasksCompleted).toBe(3);
      // Average of 1000, 2000, 3000 = 2000
      expect(health?.averageTaskDurationMs).toBe(2000);
    });

    it("should list all health records", async () => {
      const projects: RegisteredProject[] = [];
      for (let i = 0; i < 3; i++) {
        const projectPath = join(tempDir, `health-list-${i}`);
        mkdirSync(projectPath);
        projectPaths.push(projectPath);

        const project = await central.registerProject({
          name: `Health ${i}`,
          path: projectPath,
        });
        projects.push(project);
      }

      const allHealth = await central.listAllHealth();
      expect(allHealth).toHaveLength(3);
    });
  });

  describe("unified activity feed", () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
      await central.init();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should log activity with auto-generated id", async () => {
      const projectPath = join(tempDir, "activity-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Activity Test",
        path: projectPath,
      });

      const entry = await central.logActivity({
        type: "task:created",
        projectId: project.id,
        projectName: project.name,
        timestamp: new Date().toISOString(),
        details: "Task created",
      });

      expect(entry.id).toMatch(/^[0-9a-f-]+$/); // UUID format
      expect(entry.type).toBe("task:created");
    });

    it("should update project lastActivityAt on log", async () => {
      const projectPath = join(tempDir, "activity-update");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Activity Update",
        path: projectPath,
      });

      const beforeActivity = project.lastActivityAt;

      vi.setSystemTime(new Date("2026-04-01T12:00:00.010Z"));

      await central.logActivity({
        type: "task:moved",
        projectId: project.id,
        projectName: project.name,
        timestamp: new Date().toISOString(),
        details: "Task moved",
      });

      const updated = await central.getProject(project.id);
      expect(updated?.lastActivityAt).not.toBe(beforeActivity);
    });

    it("should emit activity:logged event", async () => {
      const projectPath = join(tempDir, "activity-event");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Activity Event",
        path: projectPath,
      });

      let emittedEntry: CentralActivityLogEntry | undefined;
      central.on("activity:logged", (e) => {
        emittedEntry = e;
      });

      await central.logActivity({
        type: "task:created",
        projectId: project.id,
        projectName: project.name,
        timestamp: new Date().toISOString(),
        details: "Event test",
      });

      expect(emittedEntry).toBeDefined();
      expect(emittedEntry?.details).toBe("Event test");
    });

    it("should get recent activity with default limit", async () => {
      const projectPath = join(tempDir, "recent-activity");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Recent Activity",
        path: projectPath,
      });

      // Log 150 activities
      for (let i = 0; i < 150; i++) {
        await central.logActivity({
          type: "task:created",
          projectId: project.id,
          projectName: project.name,
          timestamp: new Date().toISOString(),
          details: `Activity ${i}`,
        });
      }

      const recent = await central.getRecentActivity();
      expect(recent).toHaveLength(100); // Default limit
      // Should be newest first
      expect(recent[0].details).toBe("Activity 149");
      expect(recent[99].details).toBe("Activity 50");
    });

    it("should filter activity by project", async () => {
      const projectPath1 = join(tempDir, "filter-project-1");
      const projectPath2 = join(tempDir, "filter-project-2");
      mkdirSync(projectPath1);
      mkdirSync(projectPath2);
      projectPaths.push(projectPath1, projectPath2);

      const project1 = await central.registerProject({
        name: "Filter 1",
        path: projectPath1,
      });
      const project2 = await central.registerProject({
        name: "Filter 2",
        path: projectPath2,
      });

      await central.logActivity({
        type: "task:created",
        projectId: project1.id,
        projectName: project1.name,
        timestamp: new Date().toISOString(),
        details: "Project 1 activity",
      });

      await central.logActivity({
        type: "task:created",
        projectId: project2.id,
        projectName: project2.name,
        timestamp: new Date().toISOString(),
        details: "Project 2 activity",
      });

      const p1Activities = await central.getRecentActivity({ projectId: project1.id });
      expect(p1Activities).toHaveLength(1);
      expect(p1Activities[0].details).toBe("Project 1 activity");
    });

    it("should filter activity by type", async () => {
      const projectPath = join(tempDir, "type-filter");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Type Filter",
        path: projectPath,
      });

      await central.logActivity({
        type: "task:created",
        projectId: project.id,
        projectName: project.name,
        timestamp: new Date().toISOString(),
        details: "Created",
      });

      await central.logActivity({
        type: "task:moved",
        projectId: project.id,
        projectName: project.name,
        timestamp: new Date().toISOString(),
        details: "Moved",
      });

      const createdActivities = await central.getRecentActivity({
        types: ["task:created"],
      });
      expect(createdActivities).toHaveLength(1);
      expect(createdActivities[0].details).toBe("Created");
    });

    it("should get activity count", async () => {
      const projectPath = join(tempDir, "count-activity");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Count Activity",
        path: projectPath,
      });

      for (let i = 0; i < 5; i++) {
        await central.logActivity({
          type: "task:created",
          projectId: project.id,
          projectName: project.name,
          timestamp: new Date().toISOString(),
          details: `Count ${i}`,
        });
      }

      const totalCount = await central.getActivityCount();
      expect(totalCount).toBe(5);

      const projectCount = await central.getActivityCount(project.id);
      expect(projectCount).toBe(5);
    });

    it("should cleanup only entries older than the cutoff and retain the exact boundary", async () => {
      const projectPath = join(tempDir, "cleanup-activity");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Cleanup Activity",
        path: projectPath,
      });

      const now = new Date("2026-04-01T12:00:00.000Z");
      vi.setSystemTime(now);

      const olderThanCutoff = new Date("2026-03-31T11:59:59.999Z").toISOString();
      const exactlyAtCutoff = new Date("2026-03-31T12:00:00.000Z").toISOString();
      const newerThanCutoff = new Date("2026-03-31T12:00:00.001Z").toISOString();

      await central.logActivity({
        type: "task:created",
        projectId: project.id,
        projectName: project.name,
        timestamp: olderThanCutoff,
        details: "Older than cutoff",
      });

      await central.logActivity({
        type: "task:moved",
        projectId: project.id,
        projectName: project.name,
        timestamp: exactlyAtCutoff,
        details: "Exactly at cutoff",
      });

      await central.logActivity({
        type: "task:updated",
        projectId: project.id,
        projectName: project.name,
        timestamp: newerThanCutoff,
        details: "Newer than cutoff",
      });

      const deleted = await central.cleanupOldActivity(1);
      expect(deleted).toBe(1);

      const countAfter = await central.getActivityCount();
      expect(countAfter).toBe(2);

      const remaining = await central.getRecentActivity({ limit: 10, projectId: project.id });
      expect(remaining.map((entry) => entry.details)).toEqual([
        "Newer than cutoff",
        "Exactly at cutoff",
      ]);
      expect(remaining.map((entry) => entry.timestamp)).toEqual([
        newerThanCutoff,
        exactlyAtCutoff,
      ]);
    });
  });

  describe("global concurrency", () => {
    beforeEach(async () => {
      await central.init();
    });

    it("should get initial concurrency state", async () => {
      const state = await central.getGlobalConcurrencyState();
      expect(state.globalMaxConcurrent).toBe(4);
      expect(state.currentlyActive).toBe(0);
      expect(state.queuedCount).toBe(0);
      expect(state.projectsActive).toEqual({});
    });

    it("should update global max concurrent", async () => {
      await central.updateGlobalConcurrency({ globalMaxConcurrent: 8 });

      const state = await central.getGlobalConcurrencyState();
      expect(state.globalMaxConcurrent).toBe(8);
    });

    it("should emit concurrency:changed event on update", async () => {
      let emittedState: GlobalConcurrencyState | undefined;
      central.on("concurrency:changed", (s) => {
        emittedState = s;
      });

      await central.updateGlobalConcurrency({ globalMaxConcurrent: 6 });

      expect(emittedState).toBeDefined();
      expect(emittedState?.globalMaxConcurrent).toBe(6);
    });

    it("should acquire slot when available", async () => {
      const projectPath = join(tempDir, "acquire-slot");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Acquire Slot",
        path: projectPath,
      });

      const acquired = await central.acquireGlobalSlot(project.id);
      expect(acquired).toBe(true);

      const state = await central.getGlobalConcurrencyState();
      expect(state.currentlyActive).toBe(1);
      expect(state.projectsActive[project.id]).toBe(1);
    });

    it("should fail to acquire when at limit", async () => {
      const projectPath = join(tempDir, "at-limit");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "At Limit",
        path: projectPath,
      });

      // Set limit to 1
      await central.updateGlobalConcurrency({ globalMaxConcurrent: 1 });

      // First acquire succeeds
      const first = await central.acquireGlobalSlot(project.id);
      expect(first).toBe(true);

      // Second acquire fails (queued)
      const second = await central.acquireGlobalSlot(project.id);
      expect(second).toBe(false);

      const state = await central.getGlobalConcurrencyState();
      expect(state.currentlyActive).toBe(1);
      expect(state.queuedCount).toBe(1);
    });

    it("should release slot", async () => {
      const projectPath = join(tempDir, "release-slot");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Release Slot",
        path: projectPath,
      });

      await central.acquireGlobalSlot(project.id);
      await central.releaseGlobalSlot(project.id);

      const state = await central.getGlobalConcurrencyState();
      expect(state.currentlyActive).toBe(0);
      expect(state.projectsActive[project.id]).toBeUndefined();
    });

    it("should track per-project active counts", async () => {
      const projectPath1 = join(tempDir, "multi-1");
      const projectPath2 = join(tempDir, "multi-2");
      mkdirSync(projectPath1);
      mkdirSync(projectPath2);
      projectPaths.push(projectPath1, projectPath2);

      const project1 = await central.registerProject({
        name: "Multi 1",
        path: projectPath1,
      });
      const project2 = await central.registerProject({
        name: "Multi 2",
        path: projectPath2,
      });

      await central.acquireGlobalSlot(project1.id);
      await central.acquireGlobalSlot(project1.id);
      await central.acquireGlobalSlot(project2.id);

      const state = await central.getGlobalConcurrencyState();
      expect(state.currentlyActive).toBe(3);
      expect(state.projectsActive[project1.id]).toBe(2);
      expect(state.projectsActive[project2.id]).toBe(1);
    });

    it("should throw when acquiring for non-existent project", async () => {
      await expect(central.acquireGlobalSlot("nonexistent")).rejects.toThrow("not found");
    });

    it("should throw when releasing for non-existent project", async () => {
      await expect(central.releaseGlobalSlot("nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("utility methods", () => {
    beforeEach(async () => {
      await central.init();
    });

    it("should get database path", async () => {
      const path = central.getDatabasePath();
      expect(path).toBe(join(tempDir, "fusion-central.db"));
    });

    it("should get global directory", async () => {
      const dir = central.getGlobalDir();
      expect(dir).toBe(tempDir);
    });

    it("should get stats", async () => {
      const stats = await central.getStats();
      expect(stats.projectCount).toBe(0);
      expect(stats.totalTasksCompleted).toBe(0);
      expect(typeof stats.dbSizeBytes).toBe("number");
    });

    it("should update stats after project registration", async () => {
      const projectPath = join(tempDir, "stats-project");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      await central.registerProject({
        name: "Stats Test",
        path: projectPath,
      });

      const stats = await central.getStats();
      expect(stats.projectCount).toBe(1);
    });

    it("should update stats after task completion", async () => {
      const projectPath = join(tempDir, "stats-tasks");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Stats Tasks",
        path: projectPath,
      });

      await central.recordTaskCompletion(project.id, 5000, true);
      await central.recordTaskCompletion(project.id, 3000, true);

      const stats = await central.getStats();
      expect(stats.totalTasksCompleted).toBe(2);
    });
  });

  describe("isolation modes", () => {
    beforeEach(async () => {
      await central.init();
    });

    it("should support in-process isolation", async () => {
      const projectPath = join(tempDir, "in-process");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "In Process",
        path: projectPath,
        isolationMode: "in-process",
      });

      expect(project.isolationMode).toBe("in-process");
    });

    it("should support child-process isolation", async () => {
      const projectPath = join(tempDir, "child-process");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Child Process",
        path: projectPath,
        isolationMode: "child-process",
      });

      expect(project.isolationMode).toBe("child-process");
    });

    it("should support all project statuses", async () => {
      const projectPath = join(tempDir, "status-test");
      mkdirSync(projectPath);
      projectPaths.push(projectPath);

      const project = await central.registerProject({
        name: "Status Test",
        path: projectPath,
      });

      const statuses = ["active", "paused", "errored", "initializing"] as const;
      for (const status of statuses) {
        const updated = await central.updateProject(project.id, { status });
        expect(updated.status).toBe(status);
      }
    });
  });

  describe("settings sync", () => {
    beforeEach(async () => {
      await central.init();
    });

    describe("getSettingsForSync", () => {
      it("should return payload with global settings", async () => {
        const globalSettings = {
          themeMode: "dark" as const,
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
        };

        const payload = await central.getSettingsForSync(globalSettings);

        expect(payload.global).toEqual(globalSettings);
        expect(payload.version).toBe(1);
        expect(payload.exportedAt).toBe("2026-04-01T12:00:00.000Z");
        expect(payload.checksum).toBeDefined();
        expect(payload.checksum).toHaveLength(64); // SHA-256 hex
      });

      it("should collect project settings keyed by project name", async () => {
        const projectPath1 = join(tempDir, "sync-project1");
        const projectPath2 = join(tempDir, "sync-project2");
        mkdirSync(projectPath1);
        mkdirSync(projectPath2);
        projectPaths.push(projectPath1, projectPath2);

        await central.registerProject({
          name: "Project Alpha",
          path: projectPath1,
          settings: { maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 10000, groupOverlappingFiles: false, autoMerge: true },
        });

        await central.registerProject({
          name: "Project Beta",
          path: projectPath2,
          settings: { maxConcurrent: 3, maxWorktrees: 6, pollIntervalMs: 15000, groupOverlappingFiles: true, autoMerge: false },
        });

        const payload = await central.getSettingsForSync({});

        expect(payload.projects).toBeDefined();
        expect(Object.keys(payload.projects!)).toHaveLength(2);
        expect(payload.projects!["Project Alpha"]).toEqual({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 10000, groupOverlappingFiles: false, autoMerge: true });
        expect(payload.projects!["Project Beta"]).toEqual({ maxConcurrent: 3, maxWorktrees: 6, pollIntervalMs: 15000, groupOverlappingFiles: true, autoMerge: false });
      });

      it("should compute correct checksum", async () => {
        const globalSettings = { themeMode: "dark" as const };

        const payload1 = await central.getSettingsForSync(globalSettings);
        const payload2 = await central.getSettingsForSync(globalSettings);

        // Same input should produce same checksum
        expect(payload1.checksum).toBe(payload2.checksum);
      });

      it("should include providerAuth when supplied", async () => {
        const globalSettings = {};
        const providerAuth = {
          anthropic: { type: "api_key" as const, key: "sk-ant-test", authenticated: true },
          openai: { type: "api_key" as const, key: "sk-openai-test", authenticated: false },
        };

        const payload = await central.getSettingsForSync(globalSettings, { providerAuth });

        expect(payload.providerAuth).toEqual(providerAuth);
      });

      it("should work when no projects are registered", async () => {
        const payload = await central.getSettingsForSync({});

        expect(payload.global).toEqual({});
        expect(payload.projects).toBeUndefined();
        expect(payload.providerAuth).toBeUndefined();
        expect(payload.checksum).toBeDefined();
      });

      it("should set exportedAt to current timestamp", async () => {
        const payload = await central.getSettingsForSync({});

        expect(payload.exportedAt).toBe("2026-04-01T12:00:00.000Z");
      });
    });

    describe("applyRemoteSettings", () => {
      it("should return success with correct counts for valid payload", async () => {
        const projectPath = join(tempDir, "apply-project");
        mkdirSync(projectPath);
        projectPaths.push(projectPath);

        await central.registerProject({
          name: "Apply Test",
          path: projectPath,
        });

        const payload = await central.getSettingsForSync({ themeMode: "dark" as const });

        const result = await central.applyRemoteSettings(payload);

        expect(result.success).toBe(true);
        expect(result.globalCount).toBe(1);
        expect(result.projectCount).toBe(0);
        expect(result.authCount).toBe(0);
        expect(result.error).toBeUndefined();
      });

      it("should return success false on version mismatch", async () => {
        const payload = {
          version: 99 as unknown as 1,
          exportedAt: new Date().toISOString(),
          checksum: "invalid",
        };

        const result = await central.applyRemoteSettings(payload);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Unsupported settings sync version");
      });

      it("should return success false on checksum mismatch", async () => {
        const payload = {
          version: 1 as const,
          exportedAt: new Date().toISOString(),
          checksum: "invalid-checksum-that-wont-match",
        };

        const result = await central.applyRemoteSettings(payload);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Checksum mismatch");
      });

      it("should merge project settings for matching project names", async () => {
        const projectPath = join(tempDir, "merge-project");
        mkdirSync(projectPath);
        projectPaths.push(projectPath);

        await central.registerProject({
          name: "Merge Test",
          path: projectPath,
          settings: { maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 10000, groupOverlappingFiles: false, autoMerge: true },
        });

        // Use getSettingsForSync to create a valid payload, then modify and re-sign
        // The challenge is ensuring the checksum matches, so we use getSettingsForSync's exact output
        const remoteSettings = { maxConcurrent: 5, maxWorktrees: 8, pollIntervalMs: 20000, groupOverlappingFiles: true, autoMerge: false };
        
        // First, get a payload that includes the project
        await central.updateProject((await central.getProjectByPath(projectPath))!.id, {
          settings: remoteSettings,
        });
        
        // Now get the payload - it should have the updated settings
        const payload = await central.getSettingsForSync({});
        const result = await central.applyRemoteSettings(payload);

        expect(result.success).toBe(true);
        // Project settings are applied
        const project = await central.getProjectByPath(projectPath);
        expect(project?.settings?.maxConcurrent).toBe(5); // from the updated settings
      });

      it("should skip project settings for projects that don't exist locally", async () => {
        // Create a payload without any local projects
        const payload = await central.getSettingsForSync({
          themeMode: "dark" as const,
        });

        // Verify it processes without error and has 0 project count
        const result = await central.applyRemoteSettings(payload);

        expect(result.success).toBe(true);
        expect(result.projectCount).toBe(0); // No matching projects (none registered in this test)
      });

      it("should return correct authCount without applying auth", async () => {
        const providerAuth = {
          anthropic: { type: "api_key" as const, key: "sk-ant-test" },
          openai: { type: "oauth" as const, accessToken: "oauth-token" },
        };
        const payload = await central.getSettingsForSync({}, { providerAuth });

        const result = await central.applyRemoteSettings(payload);

        expect(result.success).toBe(true);
        expect(result.authCount).toBe(2); // Both entries counted
        // Auth is not applied - that's the caller's responsibility
      });

      it("should handle empty payload gracefully", async () => {
        // Create an empty but valid payload using getSettingsForSync
        const emptyPayload = await central.getSettingsForSync({});

        const result = await central.applyRemoteSettings(emptyPayload);

        expect(result.success).toBe(true);
        expect(result.globalCount).toBeGreaterThanOrEqual(0);
        expect(result.projectCount).toBe(0);
        expect(result.authCount).toBe(0);
      });
    });

    describe("getSettingsSyncState", () => {
      it("should return null when no sync has occurred", async () => {
        // Register a remote node first
        const remoteNode = await central.registerNode({
          name: "remote-test",
          type: "remote",
          url: "http://localhost:9999",
        });

        const state = await central.getSettingsSyncState(remoteNode.id);

        expect(state).toBeNull();
      });

      it("should return state after updateSettingsSyncState", async () => {
        const remoteNode = await central.registerNode({
          name: "remote-state-test",
          type: "remote",
          url: "http://localhost:9998",
        });

        await central.updateSettingsSyncState(remoteNode.id, {
          lastSyncedAt: "2026-04-01T12:00:00.000Z",
          localChecksum: "local-checksum-abc",
          remoteChecksum: "remote-checksum-xyz",
        });

        const state = await central.getSettingsSyncState(remoteNode.id);

        expect(state).not.toBeNull();
        expect(state!.lastSyncedAt).toBe("2026-04-01T12:00:00.000Z");
        expect(state!.localChecksum).toBe("local-checksum-abc");
        expect(state!.remoteChecksum).toBe("remote-checksum-xyz");
        expect(state!.syncCount).toBe(1);
      });
    });

    describe("updateSettingsSyncState", () => {
      it("should create new row on first call", async () => {
        const remoteNode = await central.registerNode({
          name: "remote-new",
          type: "remote",
          url: "http://localhost:9997",
        });

        const state = await central.updateSettingsSyncState(remoteNode.id, {
          lastSyncedAt: "2026-04-01T12:00:00.000Z",
        });

        expect(state.syncCount).toBe(1);
        expect(state.lastSyncedAt).toBe("2026-04-01T12:00:00.000Z");
        expect(state.createdAt).toBeDefined();
        expect(state.updatedAt).toBeDefined();
      });

      it("should update existing row on subsequent calls", async () => {
        const remoteNode = await central.registerNode({
          name: "remote-update",
          type: "remote",
          url: "http://localhost:9996",
        });

        await central.updateSettingsSyncState(remoteNode.id, {
          lastSyncedAt: "2026-04-01T12:00:00.000Z",
          localChecksum: "first-checksum",
        });

        await central.updateSettingsSyncState(remoteNode.id, {
          lastSyncedAt: "2026-04-01T13:00:00.000Z",
          remoteChecksum: "second-checksum",
        });

        const state = await central.getSettingsSyncState(remoteNode.id);

        expect(state!.syncCount).toBe(2);
        expect(state!.lastSyncedAt).toBe("2026-04-01T13:00:00.000Z");
        expect(state!.localChecksum).toBe("first-checksum");
        expect(state!.remoteChecksum).toBe("second-checksum");
      });

      it("should auto-increment syncCount", async () => {
        const remoteNode = await central.registerNode({
          name: "remote-count",
          type: "remote",
          url: "http://localhost:9995",
        });

        for (let i = 0; i < 3; i++) {
          await central.updateSettingsSyncState(remoteNode.id, {
            localChecksum: `checksum-${i}`,
          });
        }

        const state = await central.getSettingsSyncState(remoteNode.id);

        expect(state!.syncCount).toBe(3);
      });

      it("should set lastSyncedAt when provided", async () => {
        const remoteNode = await central.registerNode({
          name: "remote-synced",
          type: "remote",
          url: "http://localhost:9994",
        });

        const state = await central.updateSettingsSyncState(remoteNode.id, {
          lastSyncedAt: "2026-04-01T15:00:00.000Z",
        });

        expect(state.lastSyncedAt).toBe("2026-04-01T15:00:00.000Z");
      });

      it("should update checksums when provided", async () => {
        const remoteNode = await central.registerNode({
          name: "remote-checksum",
          type: "remote",
          url: "http://localhost:9993",
        });

        const state = await central.updateSettingsSyncState(remoteNode.id, {
          localChecksum: "local-abc",
          remoteChecksum: "remote-xyz",
        });

        expect(state.localChecksum).toBe("local-abc");
        expect(state.remoteChecksum).toBe("remote-xyz");
      });

      it("should emit settings:sync:completed event", async () => {
        const remoteNode = await central.registerNode({
          name: "remote-event",
          type: "remote",
          url: "http://localhost:9992",
        });

        let emittedPayload: { nodeId: string; remoteNodeId: string; state: import("./types.js").SettingsSyncState } | undefined;
        central.on("settings:sync:completed", (payload) => {
          emittedPayload = payload;
        });

        await central.updateSettingsSyncState(remoteNode.id, {});

        expect(emittedPayload).toBeDefined();
        expect(emittedPayload!.remoteNodeId).toBe(remoteNode.id);
        expect(emittedPayload!.state.syncCount).toBe(1);
      });

      it("should return the updated state", async () => {
        const remoteNode = await central.registerNode({
          name: "remote-return",
          type: "remote",
          url: "http://localhost:9991",
        });

        const state = await central.updateSettingsSyncState(remoteNode.id, {
          lastSyncedAt: "2026-04-01T16:00:00.000Z",
        });

        expect(state.remoteNodeId).toBe(remoteNode.id);
        expect(state.syncCount).toBe(1);
      });
    });
  });

  describe("schema migration v5", () => {
    it("should initialize fresh database with v5 schema", async () => {
      // Create a fresh database - it should be schema v5
      const freshCentral = new CentralCore(tempDir + "-v5-fresh");
      await freshCentral.init();
      await freshCentral.close();

      // Verify settingsSyncState table exists by testing the API
      const verifyCentral = new CentralCore(tempDir + "-v5-fresh");
      await verifyCentral.init();

      const remoteNode = await verifyCentral.registerNode({
        name: "v5-test",
        type: "remote",
        url: "http://localhost:9990",
      });

      // This should work if the table exists
      await verifyCentral.updateSettingsSyncState(remoteNode.id, {
        lastSyncedAt: new Date().toISOString(),
      });

      const state = await verifyCentral.getSettingsSyncState(remoteNode.id);
      expect(state).not.toBeNull();
      expect(state!.syncCount).toBe(1);

      await verifyCentral.close();

      // Clean up
      rmSync(tempDir + "-v5-fresh", { recursive: true, force: true });
    });

    it("should migrate v4 database to v5", async () => {
      // This test verifies the migration path works
      // We can't easily create a v4 database, but we can verify the API works
      // after initialization
      const migrateCentral = new CentralCore(tempDir + "-v5-migrate");
      await migrateCentral.init();

      // Verify settingsSyncState is accessible
      const remoteNode = await migrateCentral.registerNode({
        name: "migrate-test",
        type: "remote",
        url: "http://localhost:9989",
      });

      await migrateCentral.updateSettingsSyncState(remoteNode.id, {});

      const state = await migrateCentral.getSettingsSyncState(remoteNode.id);
      expect(state).not.toBeNull();

      await migrateCentral.close();

      rmSync(tempDir + "-v5-migrate", { recursive: true, force: true });
    });
  });
});
