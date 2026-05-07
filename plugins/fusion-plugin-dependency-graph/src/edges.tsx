import type { GraphEdge, GraphPosition } from "./types";
import "./GraphHighlight.css";

interface GraphEdgesProps {
  edges: GraphEdge[];
  positions: Map<string, GraphPosition>;
  nodeWidth?: number;
  nodeHeight?: number;
  highlightedEdgeIds?: Set<string>;
}

const DEFAULT_NODE_WIDTH = 280;
const DEFAULT_NODE_HEIGHT = 100;

export function GraphEdges({
  edges,
  positions,
  nodeWidth = DEFAULT_NODE_WIDTH,
  nodeHeight = DEFAULT_NODE_HEIGHT,
  highlightedEdgeIds,
}: GraphEdgesProps) {
  const hasHighlights = Boolean(highlightedEdgeIds && highlightedEdgeIds.size > 0);

  return (
    <svg className="dependency-graph-edges" aria-hidden="true">
      <defs>
        <marker
          id="dependency-graph-arrowhead"
          markerWidth="10"
          markerHeight="7"
          refX="10"
          refY="3.5"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M 0 0 L 10 3.5 L 0 7 z" fill="var(--border)" />
        </marker>
      </defs>
      {edges.map((edge) => {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) return null;

        const edgeId = `${edge.source}->${edge.target}`;
        const isActiveHighlight = hasHighlights && (highlightedEdgeIds?.has(edgeId) ?? false);
        const x1 = source.x + nodeWidth / 2;
        const y1 = source.y + nodeHeight;
        const x2 = target.x + nodeWidth / 2;
        const y2 = target.y;
        const controlY = y1 + (y2 - y1) / 2;

        return (
          <path
            key={edgeId}
            data-testid="dependency-edge"
            data-edge-id={edgeId}
            className={`dependency-graph-edge${isActiveHighlight ? " graph-edge--highlighted" : ""}${hasHighlights && !isActiveHighlight ? " graph-edge--dimmed" : ""}`}
            d={`M ${x1} ${y1} C ${x1} ${controlY}, ${x2} ${controlY}, ${x2} ${y2}`}
            fill="none"
            stroke={isActiveHighlight ? "var(--todo)" : "var(--border)"}
            strokeWidth={isActiveHighlight ? "var(--space-xs)" : "var(--btn-border-width)"}
            opacity={hasHighlights && !isActiveHighlight ? 0.15 : 1}
            markerEnd="url(#dependency-graph-arrowhead)"
            style={{ transition: "opacity var(--transition-fast), stroke var(--transition-fast), stroke-width var(--transition-fast)" }}
          />
        );
      })}
    </svg>
  );
}
