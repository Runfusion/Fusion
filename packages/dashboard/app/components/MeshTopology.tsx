import { memo, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { NodeMeshState } from "@fusion/core";

/*
 * FNXC:MeshSharedPg 2026-06-25-00:00:
 * MeshTopology was repurposed for the shared-PostgreSQL mesh. Previously it
 * visualized peer SYNC state (which snapshots were exchanged between nodes);
 * now it visualizes active engine CONNECTIONS — which engines are connected to
 * the shared PG database, what tasks they're executing, and their heartbeat
 * status. The node/peer topology data still comes from NodeMeshState (mDNS
 * discovery + central registry, both PG-backed). The optional `engines` prop
 * surfaces per-engine runtime status (in-flight tasks, active agents, last
 * activity) read directly from shared PG via GET /api/mesh/engines.
 */

/** Per-engine status surfaced from shared PG via GET /api/mesh/engines. */
export interface MeshEngineStatus {
  projectId: string;
  projectName?: string;
  workingDirectory?: string;
  runtimeStatus: string;
  inFlightTasks: number;
  activeAgents: number;
  lastActivityAt?: string;
  nodeId?: string;
}

export interface MeshTopologyProps {
  nodes: NodeMeshState[];
  /** Active engine connections reading from shared PG. Optional for backward compatibility. */
  engines?: MeshEngineStatus[];
  className?: string;
}

const STATUS_COLORS: Record<NodeMeshState["status"], string> = {
  online: "var(--success, var(--color-success))",
  offline: "var(--text-dim)",
  connecting: "var(--color-warning)",
  error: "var(--color-error)",
};

const NODE_RADIUS = 28;
const LABEL_OFFSET = 12;
const MIN_VIEWBOX_SIZE = 300;
const MAX_REMOTE_DISTANCE = 120;

function MeshTopologyInner({ nodes, engines, className }: MeshTopologyProps): ReactElement {
  const { t } = useTranslation("app");
  const localNode = useMemo(() => nodes.find((n) => n.nodeType === "local") ?? nodes[0], [nodes]);
  const remoteNodes = useMemo(() => nodes.filter((n) => n.nodeId !== localNode?.nodeId), [nodes, localNode?.nodeId]);

  const totalInFlight = useMemo(
    () => (engines ?? []).reduce((sum, e) => sum + (e.inFlightTasks ?? 0), 0),
    [engines],
  );
  const totalActiveAgents = useMemo(
    () => (engines ?? []).reduce((sum, e) => sum + (e.activeAgents ?? 0), 0),
    [engines],
  );

  const viewBoxSize = useMemo(() => MIN_VIEWBOX_SIZE + (Math.max(0, remoteNodes.length - 4) * 20), [remoteNodes.length]);
  const centerX = viewBoxSize / 2;
  const centerY = viewBoxSize / 2;

  const nodePositions = useMemo(() => {
    const positions = new Map<string, { x: number; y: number; node: NodeMeshState }>();
    if (localNode) {
      positions.set(localNode.nodeId, { x: centerX, y: centerY, node: localNode });
    }
    if (remoteNodes.length > 0) {
      const distance = Math.min(MAX_REMOTE_DISTANCE, (viewBoxSize / 2) - NODE_RADIUS - 10);
      const angleStep = (2 * Math.PI) / remoteNodes.length;
      const startAngle = -Math.PI / 2;
      remoteNodes.forEach((node, index) => {
        const angle = startAngle + index * angleStep;
        positions.set(node.nodeId, {
          node,
          x: centerX + distance * Math.cos(angle),
          y: centerY + distance * Math.sin(angle),
        });
      });
    }
    return positions;
  }, [centerX, centerY, localNode, remoteNodes, viewBoxSize]);

  const links = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ key: string; from: { x: number; y: number }; to: { x: number; y: number } }> = [];
    for (const node of nodes) {
      const from = nodePositions.get(node.nodeId);
      if (!from) continue;
      for (const peer of node.knownPeers) {
        const to = nodePositions.get(peer.peerNodeId);
        if (!to) continue;
        const key = [node.nodeId, peer.peerNodeId].sort().join("::");
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ key, from, to });
      }
    }
    return result;
  }, [nodePositions, nodes]);

  if (nodes.length === 0) {
    return <div className={`mesh-topology mesh-topology--empty ${className ?? ""}`}><div className="mesh-topology__empty-state"><p>{t("mesh.noNodes", "No nodes to display")}</p></div></div>;
  }

  return (
    <div className={`mesh-topology ${className ?? ""}`}>
      <svg className="mesh-topology__svg" viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`} preserveAspectRatio="xMidYMid meet" aria-label={t("mesh.ariaLabel", "Node mesh topology visualization")}>
        {links.map((link) => (
          <line key={link.key} className="mesh-topology__link mesh-topology__peer-line" x1={link.from.x} y1={link.from.y} x2={link.to.x} y2={link.to.y} />
        ))}

        {Array.from(nodePositions.values()).map(({ node, x, y }) => (
          <g key={node.nodeId} className="mesh-topology__node" transform={`translate(${x}, ${y})`}>
            <circle className="mesh-topology__node-circle" r={NODE_RADIUS} fill={STATUS_COLORS[node.status]} aria-label={`${node.nodeName} (${node.status})`} />
            <text className="mesh-topology__node-label" y={NODE_RADIUS + LABEL_OFFSET} textAnchor="middle">
              {node.nodeName.length > 12 ? `${node.nodeName.slice(0, 10)}…` : node.nodeName}
            </text>
            <g className="mesh-topology__node-type" transform={`translate(0 ${-NODE_RADIUS - 10})`}>
              <circle className="mesh-topology__node-type-badge" r="8" />
              <text className="mesh-topology__node-type-text" textAnchor="middle" dominantBaseline="middle">
                {node.nodeType === "local" ? "L" : "R"}
              </text>
            </g>
          </g>
        ))}
      </svg>

      {(engines ?? []).length > 0 && (
        <div className="mesh-topology__engines" aria-label={t("mesh.enginesAriaLabel", "Active engine connections")}>
          <div className="mesh-topology__engines-summary">
            <span className="mesh-topology__engines-count">
              {t("mesh.enginesConnected", { count: (engines ?? []).length, defaultValue: "{{count}} engine(s) connected to shared PG" })}
            </span>
            <span className="mesh-topology__engines-metric">{t("mesh.inFlightTasks", { count: totalInFlight, defaultValue: "{{count}} in-flight" })}</span>
            <span className="mesh-topology__engines-metric">{t("mesh.activeAgents", { count: totalActiveAgents, defaultValue: "{{count}} agents" })}</span>
          </div>
          <ul className="mesh-topology__engines-list">
            {(engines ?? []).map((engine) => (
              <li key={engine.projectId} className="mesh-topology__engine-item">
                <span className="mesh-topology__engine-name">{engine.projectName ?? engine.projectId}</span>
                <span className="mesh-topology__engine-status" data-runtime-status={engine.runtimeStatus}>{engine.runtimeStatus}</span>
                <span className="mesh-topology__engine-tasks">{engine.inFlightTasks} tasks</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mesh-topology__legend">
        <div className="mesh-topology__legend-item"><span className="mesh-topology__legend-dot" style={{ background: STATUS_COLORS.online }} /><span>{t("mesh.online", "Online")}</span></div>
        <div className="mesh-topology__legend-item"><span className="mesh-topology__legend-dot" style={{ background: STATUS_COLORS.offline }} /><span>{t("mesh.offline", "Offline")}</span></div>
        <div className="mesh-topology__legend-item"><span className="mesh-topology__legend-dot" style={{ background: STATUS_COLORS.connecting }} /><span>{t("mesh.connecting", "Connecting")}</span></div>
        <div className="mesh-topology__legend-item"><span className="mesh-topology__legend-dot" style={{ background: STATUS_COLORS.error }} /><span>{t("mesh.error", "Error")}</span></div>
      </div>
      {links.length === 0 && <p className="mesh-topology__notice">{t("mesh.noPeers", "Peer-to-peer discovery data unavailable.")}</p>}
    </div>
  );
}

export const MeshTopology = memo(MeshTopologyInner);
