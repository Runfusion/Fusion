import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MeshTopology } from "../MeshTopology";
import type { NodeMeshState } from "@fusion/core";

function makeNode(overrides: Partial<NodeMeshState> = {}): NodeMeshState {
  return {
    nodeId: "local",
    nodeName: "Local",
    nodeUrl: undefined,
    nodeType: "local",
    status: "online",
    metrics: null,
    lastSeen: "2026-01-01T00:00:00.000Z",
    connectedAt: "2026-01-01T00:00:00.000Z",
    knownPeers: [],
    ...overrides,
  };
}

describe("MeshTopology", () => {
  it("renders empty state with no nodes", () => {
    render(<MeshTopology nodes={[]} />);
    expect(screen.getByText("No nodes to display")).toBeInTheDocument();
  });

  it("renders peer-derived links including remote-to-remote edges", () => {
    const nodes: NodeMeshState[] = [
      makeNode({
        nodeId: "local",
        knownPeers: [{ id: "p1", nodeId: "local", peerNodeId: "remote-1", name: "Remote 1", url: "http://r1", status: "online", lastSeen: "2026-01-01T00:00:00.000Z", connectedAt: "2026-01-01T00:00:00.000Z" }],
      }),
      makeNode({
        nodeId: "remote-1",
        nodeName: "Remote 1",
        nodeType: "remote",
        nodeUrl: "http://r1",
        knownPeers: [{ id: "p2", nodeId: "remote-1", peerNodeId: "remote-2", name: "Remote 2", url: "http://r2", status: "online", lastSeen: "2026-01-01T00:00:00.000Z", connectedAt: "2026-01-01T00:00:00.000Z" }],
      }),
      makeNode({ nodeId: "remote-2", nodeName: "Remote 2", nodeType: "remote", nodeUrl: "http://r2" }),
    ];

    render(<MeshTopology nodes={nodes} />);
    expect(document.querySelectorAll(".mesh-topology__peer-line")).toHaveLength(2);
    expect(screen.queryByText("Peer-to-peer discovery data unavailable.")).not.toBeInTheDocument();
  });

  it("shows fallback notice when peer data is unavailable", () => {
    render(<MeshTopology nodes={[makeNode(), makeNode({ nodeId: "remote", nodeType: "remote", nodeName: "Remote" })]} />);
    expect(screen.getByText("Peer-to-peer discovery data unavailable.")).toBeInTheDocument();
  });
});
