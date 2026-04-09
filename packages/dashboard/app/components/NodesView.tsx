import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Server, Wifi, WifiOff, Globe, RefreshCw } from "lucide-react";
import { useNodes } from "../hooks/useNodes";
import { useProjects } from "../hooks/useProjects";
import type { NodeInfo, NodeUpdateInput } from "../api";
import { NodeCard } from "./NodeCard";
import { MeshTopology } from "./MeshTopology";
import { AddNodeModal, type AddNodeInput } from "./AddNodeModal";
import { NodeDetailModal } from "./NodeDetailModal";
import type { ToastType } from "../hooks/useToast";

interface NodesViewProps {
  addToast: (message: string, type?: ToastType) => void;
}

export function NodesView({ addToast }: NodesViewProps) {
  const { nodes, loading, error, refresh, register, update, unregister, healthCheck } = useNodes();
  const { projects } = useProjects();
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<NodeInfo | null>(null);

  useEffect(() => {
    if (!selectedNode) return;
    const latest = nodes.find((node) => node.id === selectedNode.id) ?? null;
    setSelectedNode(latest);
  }, [nodes, selectedNode]);

  const stats = useMemo(() => {
    const total = nodes.length;
    const online = nodes.filter((node) => node.status === "online").length;
    const offline = nodes.filter((node) => node.status === "offline" || node.status === "error").length;
    const remote = nodes.filter((node) => node.type === "remote").length;
    return { total, online, offline, remote };
  }, [nodes]);

  const handleRegister = useCallback(async (input: AddNodeInput) => {
    await register(input);
  }, [register]);

  const handleRefresh = useCallback(async () => {
    try {
      await refresh();
    } catch {
      addToast("Failed to refresh nodes", "error");
    }
  }, [addToast, refresh]);

  const handleHealthCheck = useCallback(async (id: string) => {
    try {
      await healthCheck(id);
      addToast("Node health check complete", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Health check failed";
      addToast(message, "error");
    }
  }, [addToast, healthCheck]);

  const handleUnregister = useCallback(async (id: string) => {
    try {
      await unregister(id);
      addToast("Node removed", "success");
      if (selectedNode?.id === id) {
        setSelectedNode(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to remove node";
      addToast(message, "error");
    }
  }, [addToast, selectedNode?.id, unregister]);

  const handleUpdate = useCallback(async (id: string, updates: NodeUpdateInput) => {
    await update(id, updates);
  }, [update]);

  return (
    <div className="nodes-view" data-testid="nodes-view">
      <div className="nodes-view-header">
        <div className="nodes-view-title">
          <h2>
            <Server size={20} />
            Nodes
          </h2>
          <span className="nodes-view-count">{nodes.length} registered</span>
        </div>

        <div className="nodes-view-actions">
          <button className="btn btn-sm" onClick={() => void handleRefresh()} disabled={loading}>
            <RefreshCw size={14} className={loading ? "spin" : ""} />
            Refresh
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setAddModalOpen(true)}>
            <Plus size={14} />
            Add Node
          </button>
        </div>
      </div>

      <div className="nodes-view-stats">
        <div className="nodes-view-stat" data-testid="nodes-stat-total">
          <span>Total</span>
          <strong>{stats.total}</strong>
        </div>
        <div className="nodes-view-stat nodes-view-stat--online" data-testid="nodes-stat-online">
          <span><Wifi size={14} /> Online</span>
          <strong>{stats.online}</strong>
        </div>
        <div className="nodes-view-stat nodes-view-stat--offline" data-testid="nodes-stat-offline">
          <span><WifiOff size={14} /> Offline</span>
          <strong>{stats.offline}</strong>
        </div>
        <div className="nodes-view-stat" data-testid="nodes-stat-remote">
          <span><Globe size={14} /> Remote</span>
          <strong>{stats.remote}</strong>
        </div>
      </div>

      {error && <div className="nodes-view-error">{error}</div>}

      {/* Mesh Topology Visualization */}
      {!loading && nodes.length > 0 && (
        <section className="nodes-view-topology" aria-label="Mesh Topology">
          <h3 className="nodes-view-section-title">Mesh Topology</h3>
          <MeshTopology nodes={nodes} />
        </section>
      )}

      {loading ? (
        <div className="nodes-view-grid">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="node-card node-card--loading" aria-hidden />
          ))}
        </div>
      ) : nodes.length === 0 ? (
        <div className="nodes-view-empty">
          <p>No nodes are registered yet.</p>
          <button className="btn btn-primary" onClick={() => setAddModalOpen(true)}>
            <Plus size={14} />
            Add First Node
          </button>
        </div>
      ) : (
        <div className="nodes-view-grid">
          {nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              projects={projects}
              onHealthCheck={(id) => { void handleHealthCheck(id); }}
              onEdit={(selected) => setSelectedNode(selected)}
              onRemove={(id) => { void handleUnregister(id); }}
              isLoading={loading}
            />
          ))}
        </div>
      )}

      <AddNodeModal
        isOpen={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onSubmit={handleRegister}
        addToast={addToast}
      />

      <NodeDetailModal
        isOpen={selectedNode !== null}
        onClose={() => setSelectedNode(null)}
        node={selectedNode}
        projects={projects}
        onUpdate={handleUpdate}
        onHealthCheck={handleHealthCheck}
        addToast={addToast}
      />
    </div>
  );
}
