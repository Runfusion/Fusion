import { memo, useMemo, type ReactElement } from "react";
import type { NodeInfo } from "../api";

export interface MeshTopologyProps {
  nodes: NodeInfo[];
  className?: string;
}

const STATUS_COLORS: Record<NodeInfo["status"], string> = {
  online: "var(--success, var(--color-success))",
  offline: "var(--text-dim)",
  connecting: "var(--triage)",
  error: "var(--color-error)",
};

const NODE_RADIUS = 28;
const LABEL_OFFSET = 12;
const MIN_VIEWBOX_SIZE = 300;
const MAX_REMOTE_DISTANCE = 120;

function MeshTopologyInner({ nodes, className }: MeshTopologyProps): ReactElement {
  // Find the local node (center)
  const localNode = useMemo(() => {
    return nodes.find((n) => n.type === "local") ?? nodes[0];
  }, [nodes]);

  // Remote nodes arranged in a circle around the local node
  const remoteNodes = useMemo(() => {
    return nodes.filter((n) => n.type === "remote");
  }, [nodes]);

  // Calculate SVG dimensions based on number of remote nodes
  const viewBoxSize = useMemo(() => {
    const baseSize = MIN_VIEWBOX_SIZE;
    const extraForRemotes = Math.max(0, remoteNodes.length - 4) * 20;
    return baseSize + extraForRemotes;
  }, [remoteNodes.length]);

  const centerX = viewBoxSize / 2;
  const centerY = viewBoxSize / 2;

  // Calculate positions for remote nodes in a circle
  const remotePositions = useMemo(() => {
    if (remoteNodes.length === 0) return [];

    const distance = Math.min(MAX_REMOTE_DISTANCE, (viewBoxSize / 2) - NODE_RADIUS - 10);
    const angleStep = (2 * Math.PI) / remoteNodes.length;
    const startAngle = -Math.PI / 2; // Start from top

    return remoteNodes.map((node, index) => {
      const angle = startAngle + index * angleStep;
      return {
        node,
        x: centerX + distance * Math.cos(angle),
        y: centerY + distance * Math.sin(angle),
      };
    });
  }, [remoteNodes, viewBoxSize, centerX, centerY]);

  // Build peer awareness lines (lines between remote nodes that share knowledge)
  const peerLines = useMemo(() => {
    // Simple heuristic: show lines between remote nodes that share knowledge
    const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

    // Only draw peer lines if we have more than 2 remote nodes
    if (remotePositions.length > 2) {
      remotePositions.forEach((rp, index) => {
        // Draw a subtle line to one other node for visual interest
        if (index % 2 === 0 && index + 1 < remotePositions.length) {
          const other = remotePositions[index + 1];
          lines.push({ x1: rp.x, y1: rp.y, x2: other.x, y2: other.y });
        }
      });
    }
    return lines;
  }, [remotePositions]);

  if (nodes.length === 0) {
    return (
      <div className={`mesh-topology mesh-topology--empty ${className ?? ""}`}>
        <div className="mesh-topology__empty-state">
          <p>No nodes to display</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`mesh-topology ${className ?? ""}`}>
      <svg
        className="mesh-topology__svg"
        viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
        preserveAspectRatio="xMidYMid meet"
        aria-label="Node mesh topology visualization"
      >
        {/* Peer awareness lines between remote nodes */}
        {peerLines.map((line, index) => (
          <line
            key={`peer-${index}`}
            className="mesh-topology__peer-line"
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
          />
        ))}

        {/* Lines from local node to remote nodes */}
        {remotePositions.map((rp) => (
          <line
            key={`link-${rp.node.id}`}
            className="mesh-topology__link"
            x1={centerX}
            y1={centerY}
            x2={rp.x}
            y2={rp.y}
          />
        ))}

        {/* Local node (center) */}
        {localNode && (
          <g className="mesh-topology__node" transform={`translate(${centerX}, ${centerY})`}>
            <circle
              className="mesh-topology__node-circle"
              r={NODE_RADIUS}
              fill={STATUS_COLORS[localNode.status]}
              aria-label={`${localNode.name} (${localNode.status})`}
            />
            <text
              className="mesh-topology__node-label"
              y={NODE_RADIUS + LABEL_OFFSET}
              textAnchor="middle"
            >
              {localNode.name.length > 12 ? `${localNode.name.slice(0, 10)}…` : localNode.name}
            </text>
            <text
              className="mesh-topology__node-type"
              y={-NODE_RADIUS - 4}
              textAnchor="middle"
            >
              {localNode.type === "local" ? "🏠" : "🌐"}
            </text>
          </g>
        )}

        {/* Remote nodes */}
        {remotePositions.map((rp) => (
          <g key={rp.node.id} className="mesh-topology__node" transform={`translate(${rp.x}, ${rp.y})`}>
            <circle
              className="mesh-topology__node-circle"
              r={NODE_RADIUS}
              fill={STATUS_COLORS[rp.node.status]}
              aria-label={`${rp.node.name} (${rp.node.status})`}
            />
            <text
              className="mesh-topology__node-label"
              y={NODE_RADIUS + LABEL_OFFSET}
              textAnchor="middle"
            >
              {rp.node.name.length > 12 ? `${rp.node.name.slice(0, 10)}…` : rp.node.name}
            </text>
            <text
              className="mesh-topology__node-type"
              y={-NODE_RADIUS - 4}
              textAnchor="middle"
            >
              🌐
            </text>
          </g>
        ))}
      </svg>

      {/* Legend */}
      <div className="mesh-topology__legend">
        <div className="mesh-topology__legend-item">
          <span className="mesh-topology__legend-dot" style={{ background: STATUS_COLORS.online }} />
          <span>Online</span>
        </div>
        <div className="mesh-topology__legend-item">
          <span className="mesh-topology__legend-dot" style={{ background: STATUS_COLORS.offline }} />
          <span>Offline</span>
        </div>
        <div className="mesh-topology__legend-item">
          <span className="mesh-topology__legend-dot" style={{ background: STATUS_COLORS.connecting }} />
          <span>Connecting</span>
        </div>
        <div className="mesh-topology__legend-item">
          <span className="mesh-topology__legend-dot" style={{ background: STATUS_COLORS.error }} />
          <span>Error</span>
        </div>
      </div>
    </div>
  );
}

export const MeshTopology = memo(MeshTopologyInner);
