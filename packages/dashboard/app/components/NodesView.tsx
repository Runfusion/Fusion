import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Box, Server, Wifi, WifiOff, Globe, RefreshCw } from "lucide-react";
import "./NodesView.css";
import { useNodes } from "../hooks/useNodes";
import { useProjects } from "../hooks/useProjects";
import { useNodeSettingsSync, computeSyncState } from "../hooks/useNodeSettingsSync";
import { useMeshState } from "../hooks/useMeshState";
import { useMeshEngines } from "../hooks/useMeshEngines";
import type { ManagedDockerNodeInfo, NodeInfo, NodeUpdateInput } from "../api";
import { NodeCard } from "./NodeCard";
import { MeshTopology } from "./MeshTopology";
import { AddNodeModal, type AddNodeInput } from "./AddNodeModal";
import { DockerNodeOnboardingModal } from "./DockerNodeOnboardingModal";
import { NodeDetailModal } from "./NodeDetailModal";
import { useManagedDockerNodes } from "../hooks/useManagedDockerNodes";
import type { ManagedDockerNodeInput } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { ViewActionButton } from "./ViewActionButton";
import { ViewHeader } from "./ViewHeader";
import { ViewLayout } from "./ViewLayout";
import { ViewSidebar } from "./ViewSidebar";

interface NodesViewProps {
  addToast: (message: string, type?: ToastType) => void;
  onClose?: () => void;
}

/*
FNXC:Nodes 2026-06-19-00:00:
FN-6717 mounts Nodes inside Command Center while preserving the legacy overlay caller during migration/testing. The close affordance is overlay-only, so tab mode omits it when no onClose handler is provided.
*/
export function NodesView({ addToast, onClose }: NodesViewProps) {
  const { t } = useTranslation("app");
  const {
    nodes,
    loading,
    error,
    refresh,
    register,
    update,
    unregister,
    healthCheck,
    patchDockerConfig,
    fetchDockerDiff,
    discoverRemoteProjects,
  } = useNodes();
  const { projects, refresh: refreshProjects } = useProjects();
  const { meshState, loading: meshLoading, error: meshError } = useMeshState();
  const { engines, loading: enginesLoading, error: enginesError } = useMeshEngines();
  const { syncStatusMap, pushSettings, pullSettings, syncAuth, trackNode, getAuthSyncState, getAuthProviders } = useNodeSettingsSync();
  const {
    dockerNodes,
    loading: dockerLoading,
    refresh: refreshDocker,
    getContainerStatus,
    getLogs,
    create: createDockerNode,
  } = useManagedDockerNodes();
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [dockerOnboardingOpen, setDockerOnboardingOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<NodeInfo | null>(null);
  /*
  FNXC:StandardizedViewLayout 2026-09-13-20:32:
  The registered nodes are the destination collection, so they live in the shared rail while the content pane shows
  the focused node. Rail focus is deliberately separate from `selectedNode`, which still owns the node detail modal,
  so navigating the collection never mutates or opens an editing surface on its own.
  */
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  // Track remote nodes for sync status polling
  useEffect(() => {
    const remoteNodes = nodes.filter((node) => node.type === "remote");
    for (const node of remoteNodes) {
      trackNode(node.id);
    }
  }, [nodes, trackNode]);

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
    const synced = nodes.filter(
      (node) => node.type === "remote" && syncStatusMap[node.id] && computeSyncState(syncStatusMap[node.id]).syncState === "synced"
    ).length;
    const docker = dockerNodes.length;
    return { total, online, offline, remote, synced, docker };
  }, [dockerNodes.length, nodes, syncStatusMap]);

  const handleRegister = useCallback(async (input: AddNodeInput) => {
    await register(input);
    await refreshProjects();
  }, [refreshProjects, register]);

  const handleCreateDockerNode = useCallback(async (input: ManagedDockerNodeInput) => {
    try {
      await createDockerNode(input);
      addToast(t("nodes.dockerNodeCreated", `Docker node "{{name}}" created`, { name: input.name }), "success");
      setDockerOnboardingOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("nodes.failedCreateDocker", "Failed to create Docker node");
      addToast(message, "error");
      throw err;
    }
  }, [addToast, createDockerNode, t]);

  const dockerNodeMap = useMemo(() => {
    const map = new Map<string, ManagedDockerNodeInfo>();
    for (const dockerNode of dockerNodes) {
      if (dockerNode.nodeId) {
        map.set(dockerNode.nodeId, dockerNode);
      }
    }
    return map;
  }, [dockerNodes]);

  const handleRefresh = useCallback(async () => {
    try {
      await Promise.all([refresh(), refreshDocker()]);
    } catch {
      addToast(t("nodes.failedRefresh", "Failed to refresh nodes"), "error");
    }
  }, [addToast, refresh, refreshDocker, t]);

  const handleHealthCheck = useCallback(async (id: string) => {
    try {
      await healthCheck(id);
      addToast(t("nodes.healthCheckComplete", "Node health check complete"), "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : t("nodes.healthCheckFailed", "Health check failed");
      addToast(message, "error");
    }
  }, [addToast, healthCheck, t]);

  const handleUnregister = useCallback(async (id: string) => {
    try {
      await unregister(id);
      addToast(t("nodes.removed", "Node removed"), "success");
      if (selectedNode?.id === id) {
        setSelectedNode(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t("nodes.failedRemove", "Failed to remove node");
      addToast(message, "error");
    }
  }, [addToast, selectedNode?.id, unregister, t]);

  const handleUpdate = useCallback(async (id: string, updates: NodeUpdateInput) => {
    await update(id, updates);
  }, [update]);

  const focusedNode = useMemo(
    () => nodes.find((node) => node.id === focusedNodeId) ?? null,
    [focusedNodeId, nodes],
  );

  const renderNodeCard = useCallback((node: NodeInfo) => {
    const nodeSyncStatus = node.type === "remote" && syncStatusMap[node.id]
      ? computeSyncState(syncStatusMap[node.id])
      : undefined;
    return (
      <NodeCard
        key={node.id}
        node={node}
        projects={projects}
        onHealthCheck={(id) => { void handleHealthCheck(id); }}
        onEdit={(selected) => setSelectedNode(selected)}
        onRemove={(id) => { void handleUnregister(id); }}
        isLoading={loading}
        syncStatus={nodeSyncStatus}
        authSyncState={node.type === "remote" ? getAuthSyncState(node.id) : undefined}
        authSyncProviders={node.type === "remote" ? getAuthProviders(node.id) : undefined}
        managedDockerNode={dockerNodeMap.get(node.id)}
      />
    );
  }, [dockerNodeMap, getAuthProviders, getAuthSyncState, handleHealthCheck, handleUnregister, loading, projects, syncStatusMap]);

  /*
  FNXC:StandardizedViewLayout 2026-09-13-20:32:
  Nodes composes the canonical Header → Content zones with the registered-node rail as its collection. Registration
  actions preserve their original callbacks, labels collapse visually (not accessibly) on phones, and the empty
  collection carries no second creation entry competing with the header's canonical one.
  */
  const header = (
      <ViewHeader
        className="nodes-view-header"
        icon={Server}
        title={(
          <>
            <span>{t("nodes.heading", "Nodes")}</span>
            <span className="nodes-view-count">{t("nodes.registeredCount", "{{count}} registered", { count: nodes.length })}</span>
          </>
        )}
        onClose={onClose}
        backAction={focusedNode ? { label: t("actions.back", "Back"), onClick: () => setFocusedNodeId(null), "data-testid": "nodes-back" } : undefined}
        closeButtonProps={{ "aria-label": t("nodes.closeAriaLabel", "Close nodes view") }}
        actions={(
          <>
            <ViewActionButton icon={RefreshCw} label={t("nodes.refresh", "Refresh")} onClick={() => void handleRefresh()} disabled={loading || dockerLoading} />
            <ViewActionButton kind="create" label={t("nodes.addNode", "Add Node")} onClick={() => setAddModalOpen(true)} />
            <ViewActionButton icon={Box} label={t("nodes.addDockerNode", "Add Docker Node")} onClick={() => setDockerOnboardingOpen(true)} title={t("nodes.addDockerNodeTitle", "Add a managed Docker node")} />
          </>
        )}
      />
  );

  const sidebar = (
    <ViewSidebar ariaLabel={t("nodes.heading", "Nodes")} panelTestId="nodes-rail">
      <div className="nodes-view-rail" role="listbox" aria-label={t("nodes.heading", "Nodes")}>
        {nodes.length === 0 ? (
          <p className="nodes-view-rail-empty">{t("nodes.noRegistered", "No nodes are registered yet.")}</p>
        ) : nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            role="option"
            aria-selected={focusedNodeId === node.id}
            data-testid="nodes-rail-item"
            data-status={node.status}
            className={`nodes-view-rail-row${focusedNodeId === node.id ? " active" : ""}`}
            onClick={() => setFocusedNodeId(node.id)}
          >
            <span className="nodes-view-rail-name">{node.name}</span>
            <span className={`nodes-view-rail-status nodes-view-rail-status--${node.status}`}>{node.status}</span>
          </button>
        ))}
      </div>
    </ViewSidebar>
  );

  return (
    <ViewLayout
      className="nodes-view"
      data-testid="nodes-view"
      header={header}
      sidebar={sidebar}
      mobilePane={focusedNode ? "detail" : "list"}
    >
      <div className="nodes-view-stats">
        <div className="nodes-view-stat" data-testid="nodes-stat-total">
          <span>{t("nodes.total", "Total")}</span>
          <strong>{stats.total}</strong>
        </div>
        <div className="nodes-view-stat nodes-view-stat--online" data-testid="nodes-stat-online">
          <span><Wifi size={14} /> {t("nodes.online", "Online")}</span>
          <strong>{stats.online}</strong>
        </div>
        <div className="nodes-view-stat nodes-view-stat--offline" data-testid="nodes-stat-offline">
          <span><WifiOff size={14} /> {t("nodes.offline", "Offline")}</span>
          <strong>{stats.offline}</strong>
        </div>
        <div className="nodes-view-stat" data-testid="nodes-stat-remote">
          <span><Globe size={14} /> {t("nodes.remote", "Remote")}</span>
          <strong>{stats.remote}</strong>
        </div>
        <div className="nodes-view-stat nodes-view-stat--synced" data-testid="nodes-stat-synced">
          <span><RefreshCw size={14} /> {t("nodes.synced", "Synced")}</span>
          <strong>{stats.synced}</strong>
        </div>
        <div className="nodes-view-stat" data-testid="nodes-stat-docker">
          <span><Box size={14} /> {t("nodes.docker", "Docker")}</span>
          <strong>{stats.docker}</strong>
        </div>
      </div>

      {(error || meshError || enginesError) && <div className="nodes-view-error">{error ?? meshError ?? enginesError}</div>}

      {/* Mesh Topology Visualization */}
      {!meshLoading && meshState.length > 0 && (
        <section className="nodes-view-topology" aria-label={t("nodes.meshTopologyAriaLabel", "Mesh Topology")}>
          <h3 className="nodes-view-section-title">{t("nodes.meshTopology", "Mesh Topology")}</h3>
          {/*
            FNXC:MeshSharedPg 2026-06-25-00:00:
            Pass active engine connections (read from shared PG via
            GET /api/mesh/engines) into MeshTopology so the view renders both the
            peer graph and the live engine runtime status. enginesLoading is
            tolerated: stale engine data is preferable to dropping the topology.
          */}
          <MeshTopology nodes={meshState} engines={!enginesLoading ? engines : undefined} />
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
          <p>{t("nodes.noRegistered", "No nodes are registered yet.")}</p>
        </div>
      ) : focusedNode ? (
        <div className="nodes-view-grid" data-testid="nodes-detail">
          {renderNodeCard(focusedNode)}
        </div>
      ) : (
        <div className="nodes-view-empty" data-testid="nodes-no-selection">
          <p>{t("nodes.selectPrompt", "Select a node to inspect its status, projects, and sync state.")}</p>
        </div>
      )}

      <AddNodeModal
        isOpen={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onSubmit={handleRegister}
        onDiscoverRemoteProjects={discoverRemoteProjects}
        addToast={addToast}
        projects={projects}
      />

      <DockerNodeOnboardingModal
        isOpen={dockerOnboardingOpen}
        onClose={() => setDockerOnboardingOpen(false)}
        onSubmit={handleCreateDockerNode}
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
        syncStatus={selectedNode?.type === "remote" && selectedNode && syncStatusMap[selectedNode.id]
          ? computeSyncState(syncStatusMap[selectedNode.id])
          : undefined}
        onPushSettings={pushSettings}
        onPullSettings={pullSettings}
        onSyncAuth={syncAuth}
        managedDockerNode={selectedNode ? dockerNodeMap.get(selectedNode.id) : undefined}
        onFetchContainerStatus={getContainerStatus}
        onFetchLogs={getLogs}
        onUpdateDockerConfig={patchDockerConfig}
        onFetchDockerConfigDiff={fetchDockerDiff}
      />
    </ViewLayout>
  );
}
