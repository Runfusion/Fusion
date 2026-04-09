import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NodesView } from "../NodesView";
import type { NodeInfo, ProjectInfo } from "../../api";
import { useNodes } from "../../hooks/useNodes";
import { useProjects } from "../../hooks/useProjects";

vi.mock("../../hooks/useNodes", () => ({
  useNodes: vi.fn(),
}));

vi.mock("../../hooks/useProjects", () => ({
  useProjects: vi.fn(),
}));

const mockUseNodes = vi.mocked(useNodes);
const mockUseProjects = vi.mocked(useProjects);

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

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "proj-1",
    name: "Project One",
    path: "/workspace/project-one",
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
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
    ...overrides,
  };
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
});

describe("NodesView", () => {
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

    render(<NodesView addToast={vi.fn()} />);

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

    render(<NodesView addToast={vi.fn()} />);

    expect(screen.getByText("No nodes are registered yet.")).toBeDefined();
    expect(screen.getByText("Add First Node")).toBeDefined();

    // Mesh topology should not be rendered when there are no nodes
    const svg = document.querySelector(".mesh-topology__svg");
    expect(svg).not.toBeInTheDocument();
  });

  it("opens Add Node modal when Add Node button is clicked", () => {
    mockUseNodes.mockReturnValue(makeUseNodesResult({ nodes: [] }));

    render(<NodesView addToast={vi.fn()} />);

    fireEvent.click(screen.getByText("Add Node"));
    expect(screen.getByRole("dialog", { name: "Add Node" })).toBeDefined();
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

    render(<NodesView addToast={vi.fn()} />);

    // Click on the node card (not the topology node)
    const nodeCard = document.querySelector(".node-card");
    expect(nodeCard).toBeInTheDocument();
    fireEvent.click(nodeCard!);
    expect(screen.getByRole("dialog", { name: "Node details for Detail Node" })).toBeDefined();
  });
});
