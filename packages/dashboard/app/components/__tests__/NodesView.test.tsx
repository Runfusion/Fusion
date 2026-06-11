import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NodesView } from "../NodesView";
import type { NodeInfo, ProjectInfoWithSource } from "../../api";
import { useNodes } from "../../hooks/useNodes";
import { useProjects } from "../../hooks/useProjects";
import { useNodeSettingsSync } from "../../hooks/useNodeSettingsSync";
import { useManagedDockerNodes } from "../../hooks/useManagedDockerNodes";
import { useMeshState } from "../../hooks/useMeshState";
import type { NodeSettingsSyncStatus } from "../../api-node";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("../../hooks/useNodes", () => ({
  useNodes: vi.fn(),
}));

vi.mock("../../hooks/useProjects", () => ({
  useProjects: vi.fn(),
}));

vi.mock("../../hooks/useNodeSettingsSync", () => ({
  useNodeSettingsSync: vi.fn(),
  computeSyncState: vi.fn((status: NodeSettingsSyncStatus) => {
    if (!status) return { syncState: "never-synced" as const, lastSyncAt: null, diffCount: 0 };
    if (status.lastSyncAt === null) return { syncState: "never-synced" as const, lastSyncAt: null, diffCount: 0 };
    if (!status.remoteReachable) return { syncState: "error" as const, lastSyncAt: status.lastSyncAt, diffCount: 0 };
    const diffCount = status.diff.global.length + status.diff.project.length;
    if (diffCount > 0) return { syncState: "diff" as const, lastSyncAt: status.lastSyncAt, diffCount };
    return { syncState: "synced" as const, lastSyncAt: status.lastSyncAt, diffCount: 0 };
  }),
  getSyncStateColor: vi.fn((state: string) => {
    switch (state) {
      case "synced": return "var(--color-success)";
      case "diff": return "var(--warning)";
      case "error": return "var(--color-error)";
      default: return "var(--text-muted)";
    }
  }),
  formatRelativeTime: vi.fn((ts: string | null) => {
    if (!ts) return "Never synced";
    return "Synced 2m ago";
  }),
}));

vi.mock("../../hooks/useManagedDockerNodes", () => ({
  useManagedDockerNodes: vi.fn(),
}));

vi.mock("../../hooks/useMeshState", () => ({
  useMeshState: vi.fn(),
}));

const mockUseNodes = vi.mocked(useNodes);
const mockUseProjects = vi.mocked(useProjects);
const mockUseNodeSettingsSync = vi.mocked(useNodeSettingsSync);
const mockUseManagedDockerNodes = vi.mocked(useManagedDockerNodes);
const mockUseMeshState = vi.mocked(useMeshState);

function makeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "node-1",
    name: "Primary Node",
    type: "local",
    status: "online",
    maxConcurrent: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectInfoWithSource> = {}): ProjectInfoWithSource {
  const project: ProjectInfoWithSource = {
    id: "proj-1",
    name: "Project One",
    path: "/workspace/project-one",
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };

  if (!project.nodeMappings && project.nodeId) {
    project.nodeMappings = [{ nodeId: project.nodeId, path: project.path, available: true }];
  }

  return project;
}

function makeUseNodesResult(overrides: Partial<ReturnType<typeof useNodes>> = {}): ReturnType<typeof useNodes> {
  return {
    nodes: [],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue(makeNode()),
    update: vi.fn().mockResolvedValue(makeNode()),
    unregister: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(undefined),
    fetchDockerConfig: vi.fn().mockResolvedValue(null),
    patchDockerConfig: vi.fn().mockResolvedValue({}),
    fetchDockerDiff: vi.fn().mockResolvedValue({ persistedVersion: 0, deployedVersion: null, needsRecreate: false }),
    discoverRemoteProjects: vi.fn().mockResolvedValue({ projects: [] }),
    ...overrides,
  };
}

function extractMediaBlocks(css: string, regex: RegExp): string {
  const blocks: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(css)) !== null) {
    const startIdx = match.index + match[0].length;
    let braceCount = 1;
    let endIdx = startIdx;

    while (braceCount > 0 && endIdx < css.length) {
      if (css[endIdx] === "{") braceCount += 1;
      if (css[endIdx] === "}") braceCount -= 1;
      endIdx += 1;
    }

    if (braceCount === 0) {
      blocks.push(css.slice(startIdx, endIdx - 1));
    }
  }

  return blocks.join("\n");
}

function extractMobileMediaBlocks(css: string): string {
  return extractMediaBlocks(css, /@media[^{]*\(max-width: 768px\)[^{]*\{/g);
}

function extractTabletMediaBlocks(css: string): string {
  return extractMediaBlocks(css, /@media[^{]*\(min-width: 769px\)[^{]*\(max-width: 1024px\)[^{]*\{/g);
}

function extractRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g"))];
  return matches.at(-1)?.[1] ?? "";
}

beforeEach(() => {
  mockUseProjects.mockReturnValue({
    projects: [],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    register: vi.fn(),
    update: vi.fn(),
    unregister: vi.fn(),
  });

  mockUseNodeSettingsSync.mockReturnValue({
    syncStatusMap: {},
    loading: false,
    actionLoading: {},
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    trackNode: vi.fn(),
    untrackNode: vi.fn(),
    pushSettings: vi.fn().mockResolvedValue({ success: true }),
    pullSettings: vi.fn().mockResolvedValue({ success: true }),
    syncAuth: vi.fn().mockResolvedValue({ success: true, syncedProviders: [] }),
    getAuthSyncState: vi.fn().mockReturnValue(undefined),
    getAuthProviders: vi.fn().mockReturnValue(undefined),
  });

  mockUseManagedDockerNodes.mockReturnValue({
    dockerNodes: [],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    getContainerStatus: vi.fn().mockResolvedValue({ running: true, status: "running" }),
    getLogs: vi.fn().mockResolvedValue(""),
    create: vi.fn().mockResolvedValue(undefined),
  });

  mockUseMeshState.mockReturnValue({
    meshState: [],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  });
});

describe("NodesView", () => {
  it("defines nodes overlay as a fixed fullscreen mobile panel", () => {
    const mobileCss = extractMobileMediaBlocks(loadAllAppCss());
    const overlayRule = extractRuleBlock(mobileCss, ".nodes-management-overlay");

    expect(overlayRule).toContain("position: fixed;");
    expect(overlayRule).toContain("inset: 0;");
    expect(overlayRule).toContain("z-index: 50;");
    expect(overlayRule).toContain("background: var(--bg);");
    expect(overlayRule).toContain("padding-top: max(var(--space-sm), env(safe-area-inset-top, 0px));");
    expect(overlayRule).toContain("padding-bottom: calc(var(--mobile-nav-height, 0px) + max(env(safe-area-inset-bottom, 0px), 12px));");
    expect(overlayRule).toContain("overflow-y: auto;");
    expect(overlayRule).toContain("-webkit-overflow-scrolling: touch;");

    mockUseNodes.mockReturnValue(makeUseNodesResult({ nodes: [] }));
    render(<div className="nodes-management-overlay"><NodesView addToast={vi.fn()} onClose={vi.fn()} /></div>);

    const overlay = document.querySelector(".nodes-management-overlay");
    expect(overlay).toContainElement(screen.getByTestId("nodes-view"));
    expect(screen.getByRole("button", { name: "Close nodes view" })).toBeInTheDocument();
  });

  it("defines nodes overlay as a fixed fullscreen tablet panel", () => {
    const tabletCss = extractTabletMediaBlocks(loadAllAppCss());
    const overlayRule = extractRuleBlock(tabletCss, ".nodes-management-overlay");

    expect(overlayRule).toContain("position: fixed;");
    expect(overlayRule).toContain("inset: 0;");
    expect(overlayRule).toContain("z-index: 50;");
    expect(overlayRule).toContain("background: var(--bg);");
    expect(overlayRule).toContain("overflow-y: auto;");
    expect(overlayRule).toContain("-webkit-overflow-scrolling: touch;");
  });

  it("renders docker stat and passes docker data to matching node card", () => {
    mockUseNodes.mockReturnValue(makeUseNodesResult({
      nodes: [makeNode({ id: "node-1", name: "Alpha", type: "remote", url: "https://alpha.node" })],
    }));
    mockUseManagedDockerNodes.mockReturnValue({
      dockerNodes: [{
        id: "mdn-1",
        nodeId: "node-1",
        name: "Docker Alpha",
        status: "running",
        hostConfig: { type: "local" },
        envVars: {},
        imageName: "runfusion/fusion",
        imageTag: "latest",
        volumeMounts: [],
        persistentStorage: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
      getContainerStatus: vi.fn().mockResolvedValue({ running: true, status: "running" }),
      getLogs: vi.fn().mockResolvedValue(""),
      create: vi.fn().mockResolvedValue(undefined),
    });

    render(<NodesView addToast={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByTestId("nodes-stat-docker").textContent).toContain("1");
    expect(screen.getAllByText("Docker").length).toBeGreaterThan(0);
    expect(screen.getByText("runfusion/fusion:latest")).toBeInTheDocument();
  });

  it("renders node cards and stats", () => {
    mockUseProjects.mockReturnValue({
      projects: [makeProject({ nodeId: "node-1" }), makeProject({ id: "proj-2", nodeId: "node-2" })],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
      register: vi.fn(),
      update: vi.fn(),
      unregister: vi.fn(),
    });

    mockUseNodes.mockReturnValue(makeUseNodesResult({
      nodes: [
        makeNode({ id: "node-1", name: "Alpha", status: "online", type: "local" }),
        makeNode({ id: "node-2", name: "Beta", status: "offline", type: "remote", url: "https://beta.node" }),
      ],
    }));
    mockUseMeshState.mockReturnValue({
      meshState: [
        { nodeId: "node-1", nodeName: "Alpha", nodeUrl: undefined, nodeType: "local", status: "online", metrics: null, lastSeen: "2026-01-01T00:00:00.000Z", connectedAt: "2026-01-01T00:00:00.000Z", knownPeers: [] },
        { nodeId: "node-2", nodeName: "Beta", nodeUrl: "https://beta.node", nodeType: "remote", status: "offline", metrics: null, lastSeen: "2026-01-01T00:00:00.000Z", connectedAt: "2026-01-01T00:00:00.000Z", knownPeers: [] },
      ],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<NodesView addToast={vi.fn()} onClose={vi.fn()} />);

    // Check node cards are rendered - use the node card class to find elements
    const nodeCards = document.querySelectorAll(".node-card");
    expect(nodeCards).toHaveLength(2);
    expect(screen.getByText("2 registered")).toBeDefined();
    expect(screen.getByTestId("nodes-stat-total").textContent).toContain("2");
    expect(screen.getByTestId("nodes-stat-online").textContent).toContain("1");
    expect(screen.getByTestId("nodes-stat-offline").textContent).toContain("1");
    expect(screen.getByTestId("nodes-stat-remote").textContent).toContain("1");

    // Check mesh topology is rendered
    const svg = document.querySelector(".mesh-topology__svg");
    expect(svg).toBeInTheDocument();
  });

  it("renders empty state when there are no nodes", () => {
    mockUseNodes.mockReturnValue(makeUseNodesResult({ nodes: [] }));

    render(<NodesView addToast={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText("No nodes are registered yet.")).toBeDefined();
    expect(screen.getByText("Add First Node")).toBeDefined();

    // Mesh topology should not be rendered when there are no nodes
    const svg = document.querySelector(".mesh-topology__svg");
    expect(svg).not.toBeInTheDocument();
  });

  it("opens Add Node modal when Add Node button is clicked", () => {
    mockUseNodes.mockReturnValue(makeUseNodesResult({ nodes: [] }));

    render(<NodesView addToast={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("Add Node"));
    expect(screen.getByRole("dialog", { name: "Add Node" })).toBeDefined();
  });

  it("refreshes projects after node registration succeeds", async () => {
    const register = vi.fn().mockResolvedValue(makeNode({ id: "node-new", name: "New Node" }));
    const refreshProjects = vi.fn().mockResolvedValue(undefined);
    mockUseNodes.mockReturnValue(makeUseNodesResult({ nodes: [], register }));
    mockUseProjects.mockReturnValue({
      projects: [makeProject()],
      loading: false,
      error: null,
      refresh: refreshProjects,
      register: vi.fn(),
      update: vi.fn(),
      unregister: vi.fn(),
    });

    render(<NodesView addToast={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("Add Node"));
    fireEvent.change(screen.getByPlaceholderText("Build Machine"), { target: { value: "New Node" } });
    fireEvent.click(screen.getByTestId("add-node-submit"));

    await waitFor(() => {
      expect(register).toHaveBeenCalledWith(expect.objectContaining({
        name: "New Node",
        projectMappings: [],
      }));
      expect(refreshProjects).toHaveBeenCalledTimes(1);
    });
  });

  it("opens Node Detail modal when a node card is clicked", () => {
    mockUseProjects.mockReturnValue({
      projects: [makeProject({ nodeId: "node-1" })],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
      register: vi.fn(),
      update: vi.fn(),
      unregister: vi.fn(),
    });

    mockUseNodes.mockReturnValue(makeUseNodesResult({
      nodes: [makeNode({ id: "node-1", name: "Detail Node" })],
    }));

    render(<NodesView addToast={vi.fn()} onClose={vi.fn()} />);

    // Click on the node card (not the topology node)
    const nodeCard = document.querySelector(".node-card");
    expect(nodeCard).toBeInTheDocument();
    fireEvent.click(nodeCard!);
    expect(screen.getByRole("dialog", { name: "Node details for Detail Node" })).toBeDefined();
  });

  it("local node detail modal only counts projects with available mappings", () => {
    mockUseProjects.mockReturnValue({
      projects: [
        makeProject({ id: "proj-1", nodeId: "node-1" }),
        makeProject({ id: "proj-2", nodeMappings: [{ nodeId: "node-1", path: "/workspace/project-two", available: false }] }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
      register: vi.fn(),
      update: vi.fn(),
      unregister: vi.fn(),
    });

    mockUseNodes.mockReturnValue(makeUseNodesResult({
      nodes: [makeNode({ id: "node-1", name: "Local Node", type: "local" })],
    }));

    render(<NodesView addToast={vi.fn()} onClose={vi.fn()} />);

    // Click on the node card to open detail modal
    const nodeCard = document.querySelector(".node-card");
    expect(nodeCard).toBeInTheDocument();
    fireEvent.click(nodeCard!);

    expect(screen.getByText("Projects (1)")).toBeDefined();
  });

  it("renders close button and calls onClose when clicked", () => {
    mockUseNodes.mockReturnValue(makeUseNodesResult({ nodes: [] }));

    const onClose = vi.fn();
    render(<NodesView addToast={vi.fn()} onClose={onClose} />);

    const closeButton = screen.getByRole("button", { name: "Close nodes view" });
    expect(closeButton).toBeInTheDocument();

    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("multi-node dashboard scenarios", () => {
    it("renders 6 sample nodes with correct stats and mesh topology", () => {
      // Mock 6 nodes matching the seed data: 1 local + 5 remote
      const sampleNodes = [
        makeNode({ id: "node-local", name: "local", type: "local", status: "online", maxConcurrent: 4 }),
        makeNode({ id: "node-staging", name: "Staging Server", type: "remote", url: "https://staging.runfusion.ai", status: "online", maxConcurrent: 4 }),
        makeNode({ id: "node-build", name: "Build Machine", type: "remote", url: "https://build.runfusion.ai", status: "online", maxConcurrent: 8 }),
        makeNode({ id: "node-gpu", name: "GPU Cluster", type: "remote", url: "https://gpu.runfusion.ai", status: "offline", maxConcurrent: 16 }),
        makeNode({ id: "node-dev", name: "Dev Box (John)", type: "remote", url: "http://192.168.1.100:4040", status: "error", maxConcurrent: 2 }),
        makeNode({ id: "node-qa", name: "QA Environment", type: "remote", url: "https://qa.runfusion.ai", status: "connecting", maxConcurrent: 4 }),
      ];

      mockUseNodes.mockReturnValue(makeUseNodesResult({ nodes: sampleNodes }));
      mockUseMeshState.mockReturnValue({
        meshState: sampleNodes.map((node) => ({
          nodeId: node.id,
          nodeName: node.name,
          nodeUrl: node.url,
          nodeType: node.type,
          status: node.status,
          metrics: null,
          lastSeen: node.updatedAt,
          connectedAt: node.createdAt,
          knownPeers: [],
        })),
        loading: false,
        error: null,
        refresh: vi.fn().mockResolvedValue(undefined),
      });

      render(<NodesView addToast={vi.fn()} onClose={vi.fn()} />);

      // Check stats bar shows correct counts
      expect(screen.getByTestId("nodes-stat-total").textContent).toContain("6");
      expect(screen.getByTestId("nodes-stat-online").textContent).toContain("3"); // local + 2 remote
      expect(screen.getByTestId("nodes-stat-offline").textContent).toContain("2"); // error + offline
      expect(screen.getByTestId("nodes-stat-remote").textContent).toContain("5");

      // Check 6 node cards are rendered
      const nodeCards = document.querySelectorAll(".node-card");
      expect(nodeCards).toHaveLength(6);

      // Check mesh topology is visible
      const svg = document.querySelector(".mesh-topology__svg");
      expect(svg).toBeInTheDocument();

      // Check header shows correct count
      expect(screen.getByText("6 registered")).toBeDefined();
    });

    it("renders all node names and statuses correctly", () => {
      const sampleNodes = [
        makeNode({ id: "node-alpha-xyz", name: "Alpha Node Xyz", status: "online", type: "local" }),
        makeNode({ id: "node-beta-uvw", name: "Beta Node Uvw", status: "offline", type: "remote", url: "https://beta.node" }),
        makeNode({ id: "node-gamma-rst", name: "Gamma Node Rst", status: "error", type: "remote", url: "https://gamma.node" }),
        makeNode({ id: "node-delta-opq", name: "Delta Node Opq", status: "connecting", type: "remote", url: "https://delta.node" }),
      ];

      mockUseNodes.mockReturnValue(makeUseNodesResult({ nodes: sampleNodes }));

      render(<NodesView addToast={vi.fn()} onClose={vi.fn()} />);

      // Verify all node names are displayed (unique names to avoid collisions)
      expect(screen.getByText("Alpha Node Xyz", { exact: true })).toBeDefined();
      expect(screen.getByText("Beta Node Uvw", { exact: true })).toBeDefined();
      expect(screen.getByText("Gamma Node Rst", { exact: true })).toBeDefined();
      expect(screen.getByText("Delta Node Opq", { exact: true })).toBeDefined();

      // Verify statuses are displayed (check existence)
      const onlineElements = document.querySelectorAll(".node-card__status--online");
      const offlineElements = document.querySelectorAll(".node-card__status--offline");
      const errorElements = document.querySelectorAll(".node-card__status--error");
      const connectingElements = document.querySelectorAll(".node-card__status--connecting");

      expect(onlineElements.length).toBe(1);
      expect(offlineElements.length).toBe(1);
      expect(errorElements.length).toBe(1);
      expect(connectingElements.length).toBe(1);
    });

    it("shows empty state mesh topology indicator when only local node exists", () => {
      mockUseNodes.mockReturnValue(makeUseNodesResult({
        nodes: [makeNode({ id: "node-local", name: "local", type: "local", status: "online" })],
      }));

      render(<NodesView addToast={vi.fn()} onClose={vi.fn()} />);

      // Stats should show only local
      expect(screen.getByTestId("nodes-stat-total").textContent).toContain("1");
      expect(screen.getByTestId("nodes-stat-online").textContent).toContain("1");
      expect(screen.getByTestId("nodes-stat-offline").textContent).toContain("0");
      expect(screen.getByTestId("nodes-stat-remote").textContent).toContain("0");
    });
  });

  describe("sync status", () => {
    it("renders Synced stat in stats row", () => {
      const syncedStatus: NodeSettingsSyncStatus = {
        lastSyncAt: new Date(Date.now() - 60000).toISOString(),
        lastSyncDirection: "push",
        localUpdatedAt: new Date().toISOString(),
        remoteReachable: true,
        diff: { global: [], project: [], workflowSettings: {} },
      };

      mockUseNodeSettingsSync.mockReturnValue({
        syncStatusMap: {
          "node-remote": syncedStatus,
        },
        loading: false,
        actionLoading: {},
        error: null,
        refresh: vi.fn().mockResolvedValue(undefined),
        trackNode: vi.fn(),
        untrackNode: vi.fn(),
        pushSettings: vi.fn().mockResolvedValue({ success: true }),
        pullSettings: vi.fn().mockResolvedValue({ success: true }),
        syncAuth: vi.fn().mockResolvedValue({ success: true, syncedProviders: [] }),
        getAuthSyncState: vi.fn().mockReturnValue(undefined),
        getAuthProviders: vi.fn().mockReturnValue(undefined),
      });

      mockUseNodes.mockReturnValue(makeUseNodesResult({
        nodes: [
          makeNode({ id: "node-remote", name: "Remote Node", type: "remote", status: "online" }),
        ],
      }));

      render(<NodesView addToast={vi.fn()} onClose={vi.fn()} />);

      expect(screen.getByTestId("nodes-stat-synced")).toBeInTheDocument();
      expect(screen.getByTestId("nodes-stat-synced").textContent).toContain("1");
    });

    it("Synced count is 0 when no remote nodes are synced", () => {
      const diffStatus: NodeSettingsSyncStatus = {
        lastSyncAt: new Date(Date.now() - 60000).toISOString(),
        lastSyncDirection: "push",
        localUpdatedAt: new Date().toISOString(),
        remoteReachable: true,
        diff: { global: ["theme"], project: [], workflowSettings: {} },
      };

      mockUseNodeSettingsSync.mockReturnValue({
        syncStatusMap: {
          "node-remote": diffStatus,
        },
        loading: false,
        actionLoading: {},
        error: null,
        refresh: vi.fn().mockResolvedValue(undefined),
        trackNode: vi.fn(),
        untrackNode: vi.fn(),
        pushSettings: vi.fn().mockResolvedValue({ success: true }),
        pullSettings: vi.fn().mockResolvedValue({ success: true }),
        syncAuth: vi.fn().mockResolvedValue({ success: true, syncedProviders: [] }),
        getAuthSyncState: vi.fn().mockReturnValue(undefined),
        getAuthProviders: vi.fn().mockReturnValue(undefined),
      });

      mockUseNodes.mockReturnValue(makeUseNodesResult({
        nodes: [
          makeNode({ id: "node-remote", name: "Remote Node", type: "remote", status: "online" }),
        ],
      }));

      render(<NodesView addToast={vi.fn()} onClose={vi.fn()} />);

      expect(screen.getByTestId("nodes-stat-synced").textContent).toContain("0");
    });

    it("Synced count excludes local nodes", () => {
      const syncedStatus: NodeSettingsSyncStatus = {
        lastSyncAt: new Date(Date.now() - 60000).toISOString(),
        lastSyncDirection: "push",
        localUpdatedAt: new Date().toISOString(),
        remoteReachable: true,
        diff: { global: [], project: [], workflowSettings: {} },
      };

      mockUseNodeSettingsSync.mockReturnValue({
        syncStatusMap: {
          "node-local": syncedStatus,
        },
        loading: false,
        actionLoading: {},
        error: null,
        refresh: vi.fn().mockResolvedValue(undefined),
        trackNode: vi.fn(),
        untrackNode: vi.fn(),
        pushSettings: vi.fn().mockResolvedValue({ success: true }),
        pullSettings: vi.fn().mockResolvedValue({ success: true }),
        syncAuth: vi.fn().mockResolvedValue({ success: true, syncedProviders: [] }),
        getAuthSyncState: vi.fn().mockReturnValue(undefined),
        getAuthProviders: vi.fn().mockReturnValue(undefined),
      });

      mockUseNodes.mockReturnValue(makeUseNodesResult({
        nodes: [
          makeNode({ id: "node-local", name: "Local Node", type: "local", status: "online" }),
        ],
      }));

      render(<NodesView addToast={vi.fn()} onClose={vi.fn()} />);

      // Local nodes should not be counted in synced
      expect(screen.getByTestId("nodes-stat-synced").textContent).toContain("0");
      expect(screen.getByTestId("nodes-stat-remote").textContent).toContain("0");
    });

    it("passes syncStatus to NodeCard components for remote nodes", () => {
      const syncedStatus: NodeSettingsSyncStatus = {
        lastSyncAt: new Date(Date.now() - 60000).toISOString(),
        lastSyncDirection: "push",
        localUpdatedAt: new Date().toISOString(),
        remoteReachable: true,
        diff: { global: [], project: [], workflowSettings: {} },
      };

      mockUseNodeSettingsSync.mockReturnValue({
        syncStatusMap: {
          "node-remote": syncedStatus,
        },
        loading: false,
        actionLoading: {},
        error: null,
        refresh: vi.fn().mockResolvedValue(undefined),
        trackNode: vi.fn(),
        untrackNode: vi.fn(),
        pushSettings: vi.fn().mockResolvedValue({ success: true }),
        pullSettings: vi.fn().mockResolvedValue({ success: true }),
        syncAuth: vi.fn().mockResolvedValue({ success: true, syncedProviders: [] }),
        getAuthSyncState: vi.fn().mockReturnValue(undefined),
        getAuthProviders: vi.fn().mockReturnValue(undefined),
      });

      mockUseNodes.mockReturnValue(makeUseNodesResult({
        nodes: [
          makeNode({ id: "node-local", name: "Local Node", type: "local", status: "online" }),
          makeNode({ id: "node-remote", name: "Remote Node", type: "remote", status: "online" }),
        ],
      }));

      render(<NodesView addToast={vi.fn()} onClose={vi.fn()} />);

      // Remote node card should have sync indicator
      const remoteNodeCard = document.querySelector('[data-node-id="node-remote"]');
      expect(remoteNodeCard).toBeInTheDocument();
      const syncIndicator = remoteNodeCard?.querySelector('[data-testid="node-card-sync"]');
      expect(syncIndicator).toBeInTheDocument();
      expect(syncIndicator).toHaveAttribute("data-sync-state", "synced");

      // Local node card should not have sync indicator
      const localNodeCard = document.querySelector('[data-node-id="node-local"]');
      expect(localNodeCard).toBeInTheDocument();
      const localSyncIndicator = localNodeCard?.querySelector('[data-testid="node-card-sync"]');
      expect(localSyncIndicator).not.toBeInTheDocument();
    });
  });
});
