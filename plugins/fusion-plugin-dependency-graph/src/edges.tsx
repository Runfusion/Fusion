import type { GraphEdge, GraphPosition } from "./types.js";
import "./GraphHighlight.css";

interface GraphEdgesProps {
  edges: GraphEdge[];
  positions: Map<string, GraphPosition>;
  nodeWidth?: number;
  nodeHeight?: number;
  nodeHeights?: ReadonlyMap<string, number>;
  highlightedEdgeIds?: Set<string>;
}

const DEFAULT_NODE_WIDTH = 280;
const DEFAULT_NODE_HEIGHT = 100;

/**
 * FNXC:DependencyGraphEdges 2026-06-19-08:59:
 * Browser SVG presentation attributes do not resolve CSS custom properties, so dependency edge theme paint and widths must travel through real CSS via inline style or classes.
 * Keep only literal SVG-safe values such as fill="none" as presentation attributes so dependency connector strokes and arrowheads remain visible across default, highlighted, and dimmed states.
 */
export function GraphEdges({
  edges,
  positions,
  nodeWidth = DEFAULT_NODE_WIDTH,
  nodeHeight = DEFAULT_NODE_HEIGHT,
  nodeHeights,
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
          <path d="M 0 0 L 10 3.5 L 0 7 z" style={{ fill: "var(--border)" }} />
        </marker>
      </defs>
      {edges.map((edge) => {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) return null;

        const edgeId = `${edge.source}->${edge.target}`;
        const isActiveHighlight = hasHighlights && (highlightedEdgeIds?.has(edgeId) ?? false);
        const x1 = source.x + nodeWidth / 2;
        const y1 = source.y + (nodeHeights?.get(edge.source) ?? nodeHeight);
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
            markerEnd="url(#dependency-graph-arrowhead)"
            style={{
              opacity: hasHighlights && !isActiveHighlight ? 0.15 : 1,
              stroke: isActiveHighlight ? "var(--todo)" : "var(--border)",
              strokeWidth: isActiveHighlight ? "var(--space-xs)" : "var(--btn-border-width)",
              transition: "opacity var(--transition-fast), stroke var(--transition-fast), stroke-width var(--transition-fast)",
            }}
          />
        );
      })}
    </svg>
  );
}
