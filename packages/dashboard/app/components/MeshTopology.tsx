import { memo, useMemo } from "react";
import type { NodeInfo } from "../api";

interface MeshTopologyProps {
  nodes: NodeInfo[];
  className?: string;
}

/** Get status color for a node */
function getStatusColor(status: NodeInfo["status"]): string {
  switch (status) {
    case "online":
      return "var(--color-success)";
    case "offline":
      return "var(--text-dim)";
    case "connecting":
      return "var(--warning)";
    case "error":
      return "var(--color-error)";
    default:
      return "var(--text-dim)";
  }
}

const MeshTopologyInner = ({ nodes, className = "" }: MeshTopologyProps) => {
  // Calculate positions for nodes in a circular layout
  const { positions, svgSize } = useMemo(() => {
    if (nodes.length === 0) {
      return { positions: [], svgSize: 200 };
    }

    const PADDING = 40;
    const NODE_RADIUS = 24;
    const LABEL_OFFSET = 35;
    const CENTER = 100;
    const MAX_RADIUS = 60;

    // First node is local, rest are remote
    const remoteNodes = nodes.filter((n) => n.type === "remote");
    const localNode = nodes.find((n) => n.type === "local");

    const positions: Array<{
      id: string;
      name: string;
      type: "local" | "remote";
      status: NodeInfo["status"];
      x: number;
      y: number;
    }> = [];

    // Local node at center
    if (localNode) {
      positions.push({
        id: localNode.id,
        name: localNode.name,
        type: "local",
        status: localNode.status,
        x: CENTER,
        y: CENTER,
      });
    }

    // Remote nodes arranged in a circle
    if (remoteNodes.length > 0) {
      const radius = Math.min(MAX_RADIUS, 20 + remoteNodes.length * 8);
      const angleStep = (2 * Math.PI) / remoteNodes.length;

      remoteNodes.forEach((node, index) => {
        const angle = angleStep * index - Math.PI / 2; // Start from top
        positions.push({
          id: node.id,
          name: node.name,
          type: "remote",
          status: node.status,
          x: CENTER + radius * Math.cos(angle),
          y: CENTER + radius * Math.sin(angle),
        });
      });
    }

    const size = (CENTER + MAX_RADIUS + LABEL_OFFSET) * 2 + PADDING * 2;
    return { positions, svgSize: size };
  }, [nodes]);

  // Generate lines from local node to all other nodes
  const lines = useMemo(() => {
    const localPos = positions.find((p) => p.type === "local");
    if (!localPos) return [];

    return positions
      .filter((p) => p.type === "remote")
      .map((remote) => ({
        x1: localPos.x,
        y1: localPos.y,
        x2: remote.x,
        y2: remote.y,
        status: remote.status,
      }));
  }, [positions]);

  if (nodes.length === 0) {
    return (
      <div className={`mesh-topology mesh-topology--empty ${className}`}>
        <div className="mesh-topology__empty-state">
          <p>No nodes to display</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`mesh-topology ${className}`}>
      <svg
        viewBox={`0 0 ${svgSize} ${svgSize}`}
        className="mesh-topology__svg"
        role="img"
        aria-label="Node mesh topology visualization"
      >
        {/* Connection lines */}
        <g className="mesh-topology__connections">
          {lines.map((line, index) => (
            <line
              key={`line-${index}`}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              className="mesh-topology__link"
              style={{
                stroke: getStatusColor(line.status),
                strokeOpacity: 0.5,
              }}
            />
          ))}
        </g>

        {/* Nodes */}
        <g className="mesh-topology__nodes">
          {positions.map((pos) => (
            <g key={pos.id} className="mesh-topology__node-group">
              {/* Node circle */}
              <circle
                cx={pos.x}
                cy={pos.y}
                r={pos.type === "local" ? 28 : 22}
                className={`mesh-topology__node ${pos.type === "local" ? "mesh-topology__node--local" : "mesh-topology__node--remote"}`}
                fill={getStatusColor(pos.status)}
                stroke={pos.type === "local" ? "var(--border)" : "transparent"}
                strokeWidth={2}
              />
              {/* Node icon placeholder */}
              <text
                x={pos.x}
                y={pos.y + 5}
                textAnchor="middle"
                className="mesh-topology__node-icon"
                fill="white"
                fontSize={pos.type === "local" ? 16 : 12}
              >
                {pos.type === "local" ? "●" : "○"}
              </text>
              {/* Node label */}
              <text
                x={pos.x}
                y={pos.y + (pos.type === "local" ? 50 : 42)}
                textAnchor="middle"
                className="mesh-topology__node-label"
                fill="var(--text)"
              >
                {pos.name.length > 12 ? `${pos.name.slice(0, 10)}…` : pos.name}
              </text>
              {/* Type badge */}
              <text
                x={pos.x}
                y={pos.y + (pos.type === "local" ? 64 : 54)}
                textAnchor="middle"
                className="mesh-topology__node-type"
                fill="var(--text-muted)"
                fontSize={10}
              >
                {pos.type === "local" ? "local" : "remote"}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
};

export const MeshTopology = memo(MeshTopologyInner);
