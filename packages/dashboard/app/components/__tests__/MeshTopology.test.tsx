import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MeshTopology } from "../MeshTopology";
import type { NodeInfo } from "../../api";

function makeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "node_test",
    name: "Test Node",
    type: "local",
    status: "online",
    maxConcurrent: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("MeshTopology", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when no nodes provided", () => {
    render(<MeshTopology nodes={[]} />);
    expect(screen.getByText("No nodes to display")).toBeInTheDocument();
  });

  it("renders empty state when empty array provided", () => {
    render(<MeshTopology nodes={[]} />);
    const svg = document.querySelector(".mesh-topology__svg");
    expect(svg).not.toBeInTheDocument();
  });

  it("renders local node with correct status color", () => {
    const nodes = [makeNode({ id: "local", name: "Local", type: "local", status: "online" })];
    render(<MeshTopology nodes={nodes} />);

    const circles = document.querySelectorAll(".mesh-topology__node-circle");
    expect(circles).toHaveLength(1);
    expect(circles[0]).toHaveAttribute("fill", expect.stringContaining("var(--success"));
  });

  it("renders remote nodes in circular arrangement", () => {
    const nodes = [
      makeNode({ id: "local", name: "Local", type: "local", status: "online" }),
      makeNode({ id: "remote1", name: "Remote 1", type: "remote", status: "online" }),
      makeNode({ id: "remote2", name: "Remote 2", type: "remote", status: "offline" }),
    ];
    render(<MeshTopology nodes={nodes} />);

    const circles = document.querySelectorAll(".mesh-topology__node-circle");
    expect(circles).toHaveLength(3); // 1 local + 2 remote
  });

  it("renders link lines between local and remote nodes", () => {
    const nodes = [
      makeNode({ id: "local", name: "Local", type: "local" }),
      makeNode({ id: "remote", name: "Remote", type: "remote" }),
    ];
    render(<MeshTopology nodes={nodes} />);

    const links = document.querySelectorAll(".mesh-topology__link");
    expect(links).toHaveLength(1); // One line from local to remote
  });

  it("renders legend with status colors", () => {
    render(<MeshTopology nodes={[makeNode()]} />);

    const legend = document.querySelector(".mesh-topology__legend");
    expect(legend).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("Connecting")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    const { container } = render(<MeshTopology nodes={[]} className="custom-class" />);
    expect(container.firstChild).toHaveClass("custom-class");
    expect(container.firstChild).toHaveClass("mesh-topology");
  });

  it("renders node labels truncated at 12 characters", () => {
    const nodes = [makeNode({ name: "This is a very long node name that should be truncated" })];
    render(<MeshTopology nodes={nodes} />);

    // The label should contain truncated text
    const label = document.querySelector(".mesh-topology__node-label");
    expect(label).toBeInTheDocument();
  });

  it("renders SVG with correct viewBox", () => {
    const nodes = [
      makeNode({ id: "local", name: "Local", type: "local" }),
      makeNode({ id: "remote1", name: "Remote 1", type: "remote" }),
      makeNode({ id: "remote2", name: "Remote 2", type: "remote" }),
      makeNode({ id: "remote3", name: "Remote 3", type: "remote" }),
      makeNode({ id: "remote4", name: "Remote 4", type: "remote" }),
    ];
    render(<MeshTopology nodes={nodes} />);

    const svg = document.querySelector(".mesh-topology__svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("viewBox");
  });

  it("renders correct status color for offline nodes", () => {
    const nodes = [makeNode({ id: "offline", name: "Offline Node", status: "offline" })];
    render(<MeshTopology nodes={nodes} />);

    const circles = document.querySelectorAll(".mesh-topology__node-circle");
    expect(circles).toHaveLength(1);
    expect(circles[0]).toHaveAttribute("fill", expect.stringContaining("var(--text-dim"));
  });

  it("renders correct status color for error nodes", () => {
    const nodes = [makeNode({ id: "error", name: "Error Node", status: "error" })];
    render(<MeshTopology nodes={nodes} />);

    const circles = document.querySelectorAll(".mesh-topology__node-circle");
    expect(circles).toHaveLength(1);
    expect(circles[0]).toHaveAttribute("fill", expect.stringContaining("var(--color-error"));
  });

  it("renders correct status color for connecting nodes", () => {
    const nodes = [makeNode({ id: "connecting", name: "Connecting Node", status: "connecting" })];
    render(<MeshTopology nodes={nodes} />);

    const circles = document.querySelectorAll(".mesh-topology__node-circle");
    expect(circles).toHaveLength(1);
    expect(circles[0]).toHaveAttribute("fill", expect.stringContaining("var(--triage"));
  });
});
