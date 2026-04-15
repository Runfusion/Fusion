import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListNodes = vi.fn();
const mockRegisterNode = vi.fn();
const mockGetNode = vi.fn();
const mockGetNodeByName = vi.fn();
const mockUnregisterNode = vi.fn();
const mockCheckNodeHealth = vi.fn();
const mockListProjects = vi.fn();
const mockQuestion = vi.fn();
const mockRlClose = vi.fn();

vi.mock("@fusion/core", () => ({
  CentralCore: vi.fn().mockImplementation(() => ({
    init: mockInit,
    close: mockClose,
    listNodes: mockListNodes,
    registerNode: mockRegisterNode,
    getNode: mockGetNode,
    getNodeByName: mockGetNodeByName,
    unregisterNode: mockUnregisterNode,
    checkNodeHealth: mockCheckNodeHealth,
    listProjects: mockListProjects,
  })),
}));

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn().mockImplementation(() => ({
    question: mockQuestion,
    close: mockRlClose,
  })),
}));

import {
  runNodeList,
  runNodeConnect,
  runNodeDisconnect,
  runNodeShow,
  runNodeHealth,
  runMeshStatus,
  maskApiKey,
  formatBytes,
  formatUptime,
  formatStatusBar,
  formatLastActivity,
  // Legacy aliases
  runNodeAdd,
  runNodeRemove,
} from "../node.js";

function makeNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "node_123",
    name: "local-node",
    type: "local" as const,
    status: "offline" as const,
    maxConcurrent: 2,
    capabilities: ["executor"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    apiKey: undefined,
    url: undefined,
    systemMetrics: undefined,
    knownPeers: undefined,
    ...overrides,
  };
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj_123",
    name: "test-project",
    path: "/path/to/project",
    status: "active" as const,
    isolationMode: "in-process" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("node commands", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);

  beforeEach(() => {
    vi.clearAllMocks();
    mockListNodes.mockResolvedValue([]);
    mockRegisterNode.mockResolvedValue(makeNode());
    mockGetNode.mockResolvedValue(undefined);
    mockGetNodeByName.mockResolvedValue(undefined);
    mockUnregisterNode.mockResolvedValue(undefined);
    mockCheckNodeHealth.mockResolvedValue("online");
    mockListProjects.mockResolvedValue([]);
    mockQuestion.mockResolvedValue("y");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Helper Function Tests ──────────────────────────────────────────────────

  describe("maskApiKey", () => {
    it("returns 'none' for undefined", () => {
      expect(maskApiKey(undefined)).toBe("none");
    });

    it("returns 'none' for empty string", () => {
      expect(maskApiKey("")).toBe("none");
    });

    it("returns '****' for keys less than 4 chars", () => {
      expect(maskApiKey("abc")).toBe("****");
      expect(maskApiKey("ab")).toBe("****");
    });

    it("shows last 4 chars for keys >= 4 chars", () => {
      expect(maskApiKey("secret1234")).toBe("****1234");
      expect(maskApiKey("abcd")).toBe("****abcd");
      expect(maskApiKey("abcdefgh")).toBe("****efgh");
    });
  });

  describe("formatBytes", () => {
    it("formats bytes correctly", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(500)).toBe("500 B");
      expect(formatBytes(1024)).toBe("1.00 KB");
      expect(formatBytes(1536)).toBe("1.50 KB");
      expect(formatBytes(1048576)).toBe("1.00 MB");
      expect(formatBytes(1073741824)).toBe("1.00 GB");
      expect(formatBytes(1099511627776)).toBe("1.00 TB");
    });

    it("handles large values with whole number formatting", () => {
      expect(formatBytes(2048)).toBe("2.00 KB");
      expect(formatBytes(2097152)).toBe("2.00 MB");
    });
  });

  describe("formatUptime", () => {
    it("formats milliseconds correctly", () => {
      expect(formatUptime(0)).toBe("0s");
      expect(formatUptime(-1000)).toBe("0s");
      expect(formatUptime(1000)).toBe("1s");
      expect(formatUptime(60000)).toBe("1m");
      expect(formatUptime(90000)).toBe("1m 30s");
      expect(formatUptime(3600000)).toBe("1h");
      expect(formatUptime(3660000)).toBe("1h 1m");
      expect(formatUptime(86400000)).toBe("1d");
      expect(formatUptime(90000000)).toBe("1d 1h");
      expect(formatUptime(90120000)).toBe("1d 1h 2m");
    });

    it("omits zero segments", () => {
      expect(formatUptime(3600000)).toBe("1h");
      expect(formatUptime(86400000)).toBe("1d");
      expect(formatUptime(90060000)).toBe("1d 1h 1m");
    });
  });

  describe("formatStatusBar", () => {
    it("formats percentage with default width", () => {
      expect(formatStatusBar(0)).toBe("[░░░░░░░░] 0%");
      expect(formatStatusBar(50)).toBe("[████░░░░] 50%");
      expect(formatStatusBar(100)).toBe("[████████] 100%");
    });

    it("formats percentage with custom width", () => {
      expect(formatStatusBar(50, 4)).toBe("[██░░] 50%");
      expect(formatStatusBar(75, 4)).toBe("[███░] 75%");
    });

    it("clamps values outside 0-100", () => {
      expect(formatStatusBar(-10)).toBe("[░░░░░░░░] 0%");
      expect(formatStatusBar(150)).toBe("[████████] 100%");
    });
  });

  describe("formatLastActivity", () => {
    it("returns 'never' for null/undefined", () => {
      expect(formatLastActivity(null)).toBe("never");
      expect(formatLastActivity(undefined)).toBe("never");
    });

    it("returns 'just now' for very recent timestamps", () => {
      const now = new Date().toISOString();
      expect(formatLastActivity(now)).toBe("just now");
    });

    it("returns minutes ago for recent timestamps", () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      expect(formatLastActivity(fiveMinutesAgo)).toBe("5m ago");
    });

    it("returns hours ago for older timestamps", () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      expect(formatLastActivity(twoHoursAgo)).toBe("2h ago");
    });

    it("returns days ago for even older timestamps", () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      expect(formatLastActivity(threeDaysAgo)).toBe("3d ago");
    });
  });

  // ── runNodeList Tests ─────────────────────────────────────────────────────

  it("runNodeList prints table output with nodes", async () => {
    mockListNodes.mockResolvedValue([
      makeNode({ name: "b-node" }),
      makeNode({ name: "a-node" }),
    ]);

    await runNodeList();

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Registered Nodes");
    expect(output).toContain("a-node");
    expect(output).toContain("b-node");
  });

  it("runNodeList supports JSON output", async () => {
    const nodes = [makeNode({ name: "json-node" })];
    mockListNodes.mockResolvedValue(nodes);

    await runNodeList({ json: true });

    // JSON output should have masked API key
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("json-node");
    expect(parsed[0].apiKey).toBe("none");
  });

  it("runNodeList masks API keys in JSON output", async () => {
    const nodes = [makeNode({ apiKey: "secret1234" })];
    mockListNodes.mockResolvedValue(nodes);

    await runNodeList({ json: true });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("****1234");
    expect(output).not.toContain("secret1234");
  });

  it("runNodeList prints empty message when no nodes", async () => {
    mockListNodes.mockResolvedValue([]);

    await runNodeList();

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("No nodes registered");
  });

  it("runNodeList shows status indicators", async () => {
    mockListNodes.mockResolvedValue([
      makeNode({ name: "online-node", status: "online" }),
      makeNode({ name: "offline-node", status: "offline" }),
      makeNode({ name: "error-node", status: "error" }),
    ]);

    await runNodeList();

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("● online");
    expect(output).toContain("○ offline");
    expect(output).toContain("✕ error");
  });

  // ── runNodeConnect Tests ─────────────────────────────────────────────────

  it("runNodeConnect registers remote node and runs health check", async () => {
    mockRegisterNode.mockResolvedValue(
      makeNode({
        id: "node_remote",
        name: "remote-node",
        type: "remote",
        url: "https://node.example.com",
      }),
    );
    mockCheckNodeHealth.mockResolvedValue("online");

    await runNodeConnect("remote-node", {
      url: "https://node.example.com",
      apiKey: "secret",
      maxConcurrent: 4,
    });

    expect(mockRegisterNode).toHaveBeenCalledWith({
      name: "remote-node",
      type: "remote",
      url: "https://node.example.com",
      apiKey: "secret",
      maxConcurrent: 4,
    });
    expect(mockCheckNodeHealth).toHaveBeenCalledWith("node_remote");
  });

  it("runNodeConnect masks API key in output", async () => {
    mockRegisterNode.mockResolvedValue(
      makeNode({
        id: "node_remote",
        name: "remote-node",
        type: "remote",
        url: "https://node.example.com",
        apiKey: "secret1234",
      }),
    );
    mockCheckNodeHealth.mockResolvedValue("online");

    await runNodeConnect("remote-node", {
      url: "https://node.example.com",
      apiKey: "secret1234",
    });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("****1234");
    expect(output).not.toContain("secret1234");
  });

  it("runNodeConnect exits with error if URL is missing", async () => {
    await expect(runNodeConnect("remote-node", { url: "" })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("runNodeConnect exits with error if name is missing", async () => {
    await expect(runNodeConnect("", { url: "https://example.com" })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("runNodeConnect validates name format", async () => {
    await expect(runNodeConnect("invalid name", { url: "https://example.com" })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── runNodeDisconnect Tests ─────────────────────────────────────────────

  it("runNodeDisconnect removes with --force", async () => {
    mockGetNode.mockResolvedValue(makeNode({ id: "node_123", name: "to-remove" }));

    await runNodeDisconnect("node_123", { force: true });

    expect(mockUnregisterNode).toHaveBeenCalledWith("node_123");
    expect(mockQuestion).not.toHaveBeenCalled();
  });

  it("runNodeDisconnect prompts without --force", async () => {
    mockGetNodeByName.mockResolvedValue(makeNode({ id: "node_222", name: "prompt-node" }));
    mockQuestion.mockResolvedValue("y");

    await runNodeDisconnect("prompt-node", { force: false });

    expect(mockQuestion).toHaveBeenCalled();
    expect(mockUnregisterNode).toHaveBeenCalledWith("node_222");
  });

  it("runNodeDisconnect cancels on 'n' answer", async () => {
    mockGetNodeByName.mockResolvedValue(makeNode({ id: "node_222", name: "prompt-node" }));
    mockQuestion.mockResolvedValue("n");

    await runNodeDisconnect("prompt-node", { force: false });

    expect(mockUnregisterNode).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("Cancelled.");
  });

  it("runNodeDisconnect rejects unknown node", async () => {
    mockGetNode.mockResolvedValue(undefined);
    mockGetNodeByName.mockResolvedValue(undefined);

    await expect(runNodeDisconnect("missing", { force: true })).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith("Error: Node 'missing' not found.");
  });

  it("runNodeDisconnect exits with error if name is missing", async () => {
    await expect(runNodeDisconnect("", { force: false })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── runNodeShow Tests ───────────────────────────────────────────────────

  it("runNodeShow displays node details with masked API key", async () => {
    mockGetNodeByName.mockResolvedValue(
      makeNode({
        id: "node_remote",
        name: "remote-node",
        type: "remote",
        url: "https://node.example.com",
        apiKey: "secret1234",
      }),
    );

    await runNodeShow("remote-node");

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Node: remote-node");
    expect(output).toContain("URL: https://node.example.com");
    expect(output).toContain("****1234");
    expect(output).not.toContain("secret1234");
  });

  it("runNodeShow supports JSON output", async () => {
    mockGetNodeByName.mockResolvedValue(
      makeNode({
        id: "node_remote",
        name: "remote-node",
        type: "remote",
        url: "https://node.example.com",
      }),
    );

    await runNodeShow("remote-node", { json: true });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("\"name\": \"remote-node\"");
  });

  it("runNodeShow shows assigned projects", async () => {
    mockGetNodeByName.mockResolvedValue(
      makeNode({
        id: "node_local",
        name: "local-node",
        type: "local",
      }),
    );
    mockListProjects.mockResolvedValue([
      makeProject({ id: "proj_1", name: "project-1", nodeId: "node_local" }),
      makeProject({ id: "proj_2", name: "project-2", nodeId: "node_other" }),
      makeProject({ id: "proj_3", name: "project-3", nodeId: undefined }),
    ]);

    await runNodeShow("local-node");

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("project-1");
    expect(output).not.toContain("project-2");
    expect(output).not.toContain("project-3");
  });

  it("runNodeShow displays system metrics when available", async () => {
    mockGetNodeByName.mockResolvedValue(
      makeNode({
        id: "node_local",
        name: "local-node",
        type: "local",
        systemMetrics: {
          cpuUsage: 45,
          memoryUsed: 4 * 1024 * 1024 * 1024,
          memoryTotal: 16 * 1024 * 1024 * 1024,
          storageUsed: 100 * 1024 * 1024 * 1024,
          storageTotal: 500 * 1024 * 1024 * 1024,
          uptime: 86400000,
          reportedAt: new Date().toISOString(),
        },
      }),
    );

    await runNodeShow("local-node");

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("System Metrics:");
    expect(output).toContain("Memory:");
    expect(output).toContain("Storage:");
    expect(output).toContain("Uptime:");
  });

  it("runNodeShow shows 'not available' when metrics are missing", async () => {
    mockGetNodeByName.mockResolvedValue(
      makeNode({
        id: "node_local",
        name: "local-node",
        type: "local",
      }),
    );

    await runNodeShow("local-node");

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("System Metrics: not available");
  });

  it("runNodeShow picks local node when no name provided", async () => {
    mockListNodes.mockResolvedValue([
      makeNode({ id: "node_remote", name: "remote", type: "remote", url: "https://remote" }),
      makeNode({ id: "node_local", name: "local", type: "local" }),
    ]);

    await runNodeShow();

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Node: local");
  });

  it("runNodeShow rejects unknown node", async () => {
    mockGetNode.mockResolvedValue(undefined);
    mockGetNodeByName.mockResolvedValue(undefined);

    await expect(runNodeShow("missing")).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith("Error: Node 'missing' not found.");
  });

  // ── runNodeHealth Tests ──────────────────────────────────────────────────

  it("runNodeHealth reports node health status", async () => {
    mockGetNodeByName.mockResolvedValue(makeNode({ id: "node_1", name: "health-node", status: "offline" }));
    mockCheckNodeHealth.mockResolvedValue("online");

    await runNodeHealth("health-node");

    expect(mockCheckNodeHealth).toHaveBeenCalledWith("node_1");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("online"));
  });

  it("runNodeHealth shows previous and current status", async () => {
    mockGetNodeByName.mockResolvedValue(makeNode({ id: "node_1", name: "health-node", status: "offline" }));
    mockCheckNodeHealth.mockResolvedValue("online");

    await runNodeHealth("health-node");

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Previous:");
    expect(output).toContain("Current:");
  });

  it("runNodeHealth handles unknown node", async () => {
    mockGetNode.mockResolvedValue(undefined);
    mockGetNodeByName.mockResolvedValue(undefined);

    await expect(runNodeHealth("missing")).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith("Error: Node 'missing' not found.");
  });

  it("runNodeHealth exits with error if name is missing", async () => {
    await expect(runNodeHealth("")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── runMeshStatus Tests ─────────────────────────────────────────────────

  it("runMeshStatus shows summary counts", async () => {
    mockListNodes.mockResolvedValue([
      makeNode({ name: "online-node", status: "online" }),
      makeNode({ name: "offline-node", status: "offline" }),
      makeNode({ name: "error-node", status: "error" }),
    ]);

    await runMeshStatus();

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Mesh Status:");
    expect(output).toContain("Total: 3");
    expect(output).toContain("Online: 1");
    expect(output).toContain("Offline: 1");
    expect(output).toContain("Error: 1");
  });

  it("runMeshStatus supports JSON output", async () => {
    mockListNodes.mockResolvedValue([
      makeNode({ name: "node-1", status: "online" }),
    ]);

    await runMeshStatus({ json: true });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.summary.total).toBe(1);
    expect(parsed.summary.online).toBe(1);
    expect(parsed.nodes).toHaveLength(1);
  });

  it("runMeshStatus shows empty message when no nodes", async () => {
    mockListNodes.mockResolvedValue([]);

    await runMeshStatus();

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("No nodes in mesh");
  });

  it("runMeshStatus sorts online nodes first", async () => {
    mockListNodes.mockResolvedValue([
      makeNode({ name: "zzz-node", status: "offline" }),
      makeNode({ name: "aaa-node", status: "online" }),
    ]);

    await runMeshStatus();

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    const onlineIndex = output.indexOf("aaa-node");
    const offlineIndex = output.indexOf("zzz-node");
    expect(onlineIndex).toBeLessThan(offlineIndex);
  });

  it("runMeshStatus masks API keys in JSON output", async () => {
    mockListNodes.mockResolvedValue([
      makeNode({ name: "secure-node", apiKey: "supersecret123" }),
    ]);

    await runMeshStatus({ json: true });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    // supersecret123.slice(-4) = "t123", so mask should be ****t123
    expect(output).toContain("****t123");
    expect(output).not.toContain("supersecret123");
  });

  it("runMeshStatus shows mesh connections when peers exist", async () => {
    mockListNodes.mockResolvedValue([
      makeNode({ id: "node_1", name: "node-a", status: "online", knownPeers: ["node_2"] }),
      makeNode({ id: "node_2", name: "node-b", status: "online", knownPeers: ["node_1"] }),
    ]);

    await runMeshStatus();

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Mesh Connections:");
    expect(output).toContain("node-a");
    expect(output).toContain("node-b");
  });

  // ── Legacy Alias Tests ───────────────────────────────────────────────────

  it("runNodeAdd is alias for runNodeConnect", async () => {
    mockRegisterNode.mockResolvedValue(
      makeNode({
        id: "node_legacy",
        name: "legacy-node",
        type: "remote",
        url: "https://legacy.example.com",
      }),
    );
    mockCheckNodeHealth.mockResolvedValue("online");

    await runNodeAdd("legacy-node", {
      url: "https://legacy.example.com",
    });

    expect(mockRegisterNode).toHaveBeenCalled();
    expect(mockCheckNodeHealth).toHaveBeenCalled();
  });

  it("runNodeRemove is alias for runNodeDisconnect", async () => {
    mockGetNode.mockResolvedValue(makeNode({ id: "node_legacy", name: "legacy-remove" }));

    await runNodeRemove("node_legacy", { force: true });

    expect(mockUnregisterNode).toHaveBeenCalledWith("node_legacy");
  });

  // ── Error Handling Tests ────────────────────────────────────────────────

  it("handles CentralCore initialization errors gracefully", async () => {
    mockInit.mockRejectedValue(new Error("Database error"));

    await expect(runNodeList()).rejects.toThrow();
  });

  it("handles API errors gracefully", async () => {
    mockListNodes.mockRejectedValue(new Error("Network error"));

    await expect(runNodeList()).rejects.toThrow();
  });
});

describe("daemon-aware node connect", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);

  beforeEach(() => {
    vi.clearAllMocks();
    mockListNodes.mockResolvedValue([]);
    mockRegisterNode.mockResolvedValue(makeNode());
    mockGetNode.mockResolvedValue(undefined);
    mockGetNodeByName.mockResolvedValue(undefined);
    mockUnregisterNode.mockResolvedValue(undefined);
    mockCheckNodeHealth.mockResolvedValue("online");
    mockListProjects.mockResolvedValue([]);
    mockQuestion.mockResolvedValue("y");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows '(authenticated)' when apiKey provided and health check succeeds", async () => {
    mockRegisterNode.mockResolvedValue(
      makeNode({
        id: "node_remote",
        name: "daemon-node",
        type: "remote",
        url: "https://daemon.example.com",
      }),
    );
    mockCheckNodeHealth.mockResolvedValue("online");

    await runNodeConnect("daemon-node", {
      url: "https://daemon.example.com",
      apiKey: "fn_daemontoken123456",
    });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("(authenticated)");
    expect(output).toContain("daemon-node");
  });

  it("shows standard success message when no apiKey provided", async () => {
    mockRegisterNode.mockResolvedValue(
      makeNode({
        id: "node_remote",
        name: "regular-node",
        type: "remote",
        url: "https://regular.example.com",
      }),
    );
    mockCheckNodeHealth.mockResolvedValue("online");

    await runNodeConnect("regular-node", {
      url: "https://regular.example.com",
    });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Node connected successfully");
    expect(output).not.toContain("(authenticated)");
  });

  it("shows auth failure hint when apiKey provided but node is offline", async () => {
    mockRegisterNode.mockResolvedValue(
      makeNode({
        id: "node_remote",
        name: "offline-daemon",
        type: "remote",
        url: "https://offline.example.com",
      }),
    );
    mockCheckNodeHealth.mockResolvedValue("offline");

    await runNodeConnect("offline-daemon", {
      url: "https://offline.example.com",
      apiKey: "fn_wrongtoken123456",
    });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("API key may be incorrect");
    expect(output).toContain("offline");
  });

  it("shows auth failure hint when apiKey provided but health check returns error", async () => {
    mockRegisterNode.mockResolvedValue(
      makeNode({
        id: "node_remote",
        name: "error-daemon",
        type: "remote",
        url: "https://error.example.com",
      }),
    );
    mockCheckNodeHealth.mockResolvedValue("error");

    await runNodeConnect("error-daemon", {
      url: "https://error.example.com",
      apiKey: "fn_badtoken123456",
    });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("API key may be incorrect");
    expect(output).toContain("error");
  });

  it("registers node with apiKey when connecting to daemon", async () => {
    mockRegisterNode.mockResolvedValue(
      makeNode({
        id: "node_remote",
        name: "auth-node",
        type: "remote",
        url: "https://auth.example.com",
      }),
    );
    mockCheckNodeHealth.mockResolvedValue("online");

    await runNodeConnect("auth-node", {
      url: "https://auth.example.com",
      apiKey: "fn_secret1234567890",
      maxConcurrent: 3,
    });

    expect(mockRegisterNode).toHaveBeenCalledWith({
      name: "auth-node",
      type: "remote",
      url: "https://auth.example.com",
      apiKey: "fn_secret1234567890",
      maxConcurrent: 3,
    });
  });
});
