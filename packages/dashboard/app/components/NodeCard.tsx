import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Box, Play, RotateCw, Server, Settings, Shield, Square, Trash2 } from "lucide-react";
import type { ManagedDockerNodeInfo, NodeInfo, ProjectInfo } from "../api";
import { getProjectCountForNode } from "../utils/nodeProjectAssignment";
import type { ComputedNodeSyncStatus } from "../hooks/useNodeSettingsSync";
import { formatRelativeTime, getSyncStateColor } from "../hooks/useNodeSettingsSync";

export interface NodeCardProps {
  node: NodeInfo;
  projects: ProjectInfo[];
  onHealthCheck: (id: string) => void;
  onEdit: (node: NodeInfo) => void;
  onRemove: (id: string) => void;
  isLoading?: boolean;
  syncStatus?: ComputedNodeSyncStatus;
  /** Auth credential sync state for this node. Only meaningful for remote nodes. */
  authSyncState?: "match" | "differs" | "not-synced";
  /** Per-provider auth match details for tooltip. Map of provider name (e.g. "anthropic") to its match status. */
  authSyncProviders?: Record<string, "match" | "differs">;
  managedDockerNode?: ManagedDockerNodeInfo;
}

function getStatusConfig(t: ReturnType<typeof useTranslation>["t"]): Record<string, { label: string; color: string; className: string }> {
  return {
    online: { label: t("nodes.status.online", "Online"), color: "var(--color-success)", className: "node-card__status--online" },
    offline: { label: t("nodes.status.offline", "Offline"), color: "var(--color-error)", className: "node-card__status--offline" },
    connecting: { label: t("nodes.status.connecting", "Connecting"), color: "var(--color-warning)", className: "node-card__status--connecting" },
    error: { label: t("nodes.status.error", "Error"), color: "var(--color-error)", className: "node-card__status--error" },
    creating: { label: t("nodes.status.creating", "Creating"), color: "var(--color-warning)", className: "node-card__status--creating" },
    recreating: { label: t("nodes.status.recreating", "Recreating"), color: "var(--color-warning)", className: "node-card__status--recreating" },
    deleting: { label: t("nodes.status.deleting", "Deleting"), color: "var(--color-error)", className: "node-card__status--deleting" },
    running: { label: t("nodes.status.running", "Running"), color: "var(--color-success)", className: "node-card__status--online" },
    stopped: { label: t("nodes.status.stopped", "Stopped"), color: "var(--color-error)", className: "node-card__status--offline" },
    exited: { label: t("nodes.status.exited", "Exited"), color: "var(--color-error)", className: "node-card__status--offline" },
  };
}

const AUTH_SYNC_COLORS: Record<string, string> = {
  match: "var(--color-success)",
  differs: "var(--color-warning)",
  "not-synced": "var(--text-muted)",
};

function buildAuthTooltip(
  state: "match" | "differs" | "not-synced",
  providers?: Record<string, "match" | "differs">,
  t?: ReturnType<typeof useTranslation>["t"],
): string {
  if (state === "match") return t ? t("nodes.auth.match", "Auth credentials match") : "Auth credentials match";
  if (state === "not-synced") return t ? t("nodes.auth.notSynced", "Auth not synced") : "Auth not synced";
  // state === "differs"
  if (providers && Object.keys(providers).length > 0) {
    const differing = Object.entries(providers)
      .filter(([, status]) => status === "differs")
      .map(([name]) => name);
    if (differing.length > 0) {
      return t ? t("nodes.auth.differProviders", "Auth credentials differ: {{providers}}", { providers: differing.join(", ") }) : `Auth credentials differ: ${differing.join(", ")}`;
    }
  }
  return t ? t("nodes.auth.differ", "Auth credentials differ") : "Auth credentials differ";
}

function truncateUrl(url: string, maxLength: number = 42): string {
  if (url.length <= maxLength) return url;
  return `${url.slice(0, maxLength - 3)}...`;
}

function areNodeCardPropsEqual(previous: NodeCardProps, next: NodeCardProps): boolean {
  const prevNode = previous.node;
  const nextNode = next.node;

  if (prevNode.id !== nextNode.id) return false;
  if (prevNode.name !== nextNode.name) return false;
  if (prevNode.type !== nextNode.type) return false;
  if (prevNode.url !== nextNode.url) return false;
  if (prevNode.status !== nextNode.status) return false;
  if (prevNode.maxConcurrent !== nextNode.maxConcurrent) return false;
  if (prevNode.updatedAt !== nextNode.updatedAt) return false;
  if (previous.isLoading !== next.isLoading) return false;

  const prevDocker = previous.managedDockerNode;
  const nextDocker = next.managedDockerNode;
  if (!!prevDocker !== !!nextDocker) return false;
  if (prevDocker && nextDocker) {
    if (prevDocker.id !== nextDocker.id) return false;
    if (prevDocker.status !== nextDocker.status) return false;
    if (prevDocker.imageTag !== nextDocker.imageTag) return false;
    if (prevDocker.updatedAt !== nextDocker.updatedAt) return false;
  }

  // Compare sync status
  const prevSync = previous.syncStatus;
  const nextSync = next.syncStatus;
  if (!prevSync && !nextSync) {
    // Both undefined - equal
  } else if (!prevSync || !nextSync) {
    return false; // One defined, one not
  } else {
    if (prevSync.syncState !== nextSync.syncState) return false;
    if (prevSync.lastSyncAt !== nextSync.lastSyncAt) return false;
    if (prevSync.diffCount !== nextSync.diffCount) return false;
  }

  // Compare auth sync state
  if (previous.authSyncState !== next.authSyncState) return false;
  // Shallow compare authSyncProviders
  const prevProviders = previous.authSyncProviders;
  const nextProviders = next.authSyncProviders;
  if (prevProviders === nextProviders) {
    // same ref or both undefined - equal
  } else if (!prevProviders || !nextProviders) {
    return false; // one defined, one not
  } else {
    const prevKeys = Object.keys(prevProviders);
    const nextKeys = Object.keys(nextProviders);
    if (prevKeys.length !== nextKeys.length) return false;
    if (prevKeys.some((k) => prevProviders[k] !== nextProviders[k])) return false;
  }

  // Compare project counts using the canonical counting function
  const previousCount = getProjectCountForNode(previous.projects, prevNode);
  const nextCount = getProjectCountForNode(next.projects, nextNode);
  return previousCount === nextCount;
}

function NodeCardInner({
  node,
  projects,
  onHealthCheck,
  onEdit,
  onRemove,
  isLoading = false,
  syncStatus,
  authSyncState,
  authSyncProviders,
  managedDockerNode,
}: NodeCardProps) {
  const { t } = useTranslation("app");
  const [removeArmed, setRemoveArmed] = useState(false);
  const statusConfigMap = getStatusConfig(t);
  const statusConfig = statusConfigMap[node.status] ?? statusConfigMap.offline;
  const dockerStatusConfig = managedDockerNode ? (statusConfigMap[managedDockerNode.status] ?? statusConfigMap.error) : null;
  const dockerHost = managedDockerNode?.hostConfig.type === "remote"
    ? t("nodes.dockerHost.remote", "Remote: {{host}}", { host: managedDockerNode.hostConfig.host ?? "unknown" })
    : t("nodes.dockerHost.local", "Local Docker");

  const assignedProjectCount = useMemo(() => {
    return getProjectCountForNode(projects, node);
  }, [projects, node]);

  const handleOpenDetails = useCallback(() => {
    onEdit(node);
  }, [onEdit, node]);

  const handleHealthCheck = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onHealthCheck(node.id);
  }, [onHealthCheck, node.id]);

  const handleEdit = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    onEdit(node);
  }, [onEdit, node]);

  const handleRemove = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    if (!removeArmed) {
      setRemoveArmed(true);
      return;
    }

    onRemove(node.id);
    setRemoveArmed(false);
  }, [removeArmed, onRemove, node.id]);

  const handleCardKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onEdit(node);
    }
  }, [onEdit, node]);

  return (
    <article
      className={`node-card ${isLoading ? "node-card--loading" : ""}`}
      data-node-id={node.id}
      role="button"
      tabIndex={0}
      onClick={handleOpenDetails}
      onKeyDown={handleCardKeyDown}
    >
      <header className="node-card__header">
        <div className="node-card__title-wrap">
          <div className="node-card__icon">
            <Server size={18} />
          </div>
          <div>
            <h3 className="node-card__name" title={node.name}>{node.name}</h3>
            <div className="node-card__meta-row">
              <span className="node-card__type-badge">{node.type === "local" ? t("nodes.type.local", "Local") : t("nodes.type.remote", "Remote")}</span>
              {managedDockerNode && (
                <span className="node-card__docker-badge" title={t("nodes.dockerBadge", "Managed Docker node")}>
                  <Box size={12} aria-hidden />
                  {t("nodes.dockerLabel", "Docker")}
                </span>
              )}
              <span
                className={`node-card__status ${statusConfig.className}`}
                style={{ color: statusConfig.color }}
                data-status={node.status}
              >
                <span className="node-card__status-indicator" style={{ backgroundColor: statusConfig.color }} aria-hidden />
                {statusConfig.label}
              </span>
              {managedDockerNode && dockerStatusConfig && (
                <span
                  className={`node-card__status ${dockerStatusConfig.className}`}
                  style={{ color: dockerStatusConfig.color }}
                  data-status={managedDockerNode.status}
                >
                  <span className="node-card__status-indicator" style={{ backgroundColor: dockerStatusConfig.color }} aria-hidden />
                  {dockerStatusConfig.label}
                </span>
              )}
              {node.type === "remote" && authSyncState && (
                <span
                  className={`node-card__auth-indicator node-card__auth-indicator--${authSyncState}`}
                  title={buildAuthTooltip(authSyncState, authSyncProviders, t)}
                  aria-label={t("nodes.authSync.label", "Auth sync: {{status}}", {
                    status: authSyncState === "match" ? t("nodes.authSync.match", "credentials match") : authSyncState === "differs" ? t("nodes.authSync.differ", "credentials differ") : t("nodes.authSync.notSynced", "not synced")
                  })}
                  style={{ color: AUTH_SYNC_COLORS[authSyncState] }}
                >
                  <Shield size={14} />
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="node-card__body">
        {node.type === "remote" && node.url && (
          <div className="node-card__url" title={node.url}>
            {truncateUrl(node.url)}
          </div>
        )}
        {managedDockerNode && (
          <div className="node-card__docker-meta">
            <span title={`${managedDockerNode.imageName}:${managedDockerNode.imageTag}`}>
              {managedDockerNode.imageName}:{managedDockerNode.imageTag}
            </span>
            <span title={dockerHost}>{dockerHost}</span>
          </div>
        )}

        <div className="node-card__metrics">
          <div className="node-card__metric">
            <span className="node-card__metric-label">{t("nodes.metrics.projects", "Projects")}</span>
            <span className="node-card__metric-value">{assignedProjectCount}</span>
          </div>
          <div className="node-card__metric">
            <span className="node-card__metric-label">{t("nodes.metrics.concurrency", "Concurrency")}</span>
            <span className="node-card__metric-value">{node.maxConcurrent}</span>
          </div>
        </div>

        {/* Sync status indicator — only for remote nodes with sync data */}
        {node.type === "remote" && syncStatus && (
          <div
            className="node-card__sync"
            data-sync-state={syncStatus.syncState}
            data-testid="node-card-sync"
          >
            <span
              className="node-card__sync-dot"
              style={{ backgroundColor: getSyncStateColor(syncStatus.syncState) }}
              aria-hidden
            />
            <span className="node-card__sync-time">
              {formatRelativeTime(syncStatus.lastSyncAt)}
            </span>
          </div>
        )}
      </div>

      <footer className="node-card__actions">
        <button
          className="btn btn-sm node-card__action"
          type="button"
          onClick={handleHealthCheck}
          disabled={isLoading}
          aria-label={t("nodes.actions.health.ariaLabel", "Run node health check")}
          title={t("nodes.actions.health.title", "Health Check")}
        >
          <Activity size={14} />
          <span>{t("nodes.actions.health.label", "Health")}</span>
        </button>

        <button
          className="btn btn-sm node-card__action"
          type="button"
          onClick={handleEdit}
          disabled={isLoading}
          aria-label={t("nodes.actions.edit.ariaLabel", "Edit node")}
          title={t("nodes.actions.edit.title", "Edit")}
        >
          <Settings size={14} />
          <span>{t("nodes.actions.edit.label", "Edit")}</span>
        </button>

        {managedDockerNode && (
          <>
            <button
              className="btn btn-sm node-card__action"
              type="button"
              disabled
              aria-label={t("nodes.actions.start.ariaLabel", "Start node container")}
              title={t("nodes.actions.start.title", "Available after FN-3113")}
            >
              <Play size={14} />
              <span>{t("nodes.actions.start.label", "Start")}</span>
            </button>

            <button
              className="btn btn-sm node-card__action"
              type="button"
              disabled
              aria-label={t("nodes.actions.stop.ariaLabel", "Stop node container")}
              title={t("nodes.actions.stop.title", "Available after FN-3113")}
            >
              <Square size={14} />
              <span>{t("nodes.actions.stop.label", "Stop")}</span>
            </button>

            <button
              className="btn btn-sm node-card__action"
              type="button"
              disabled
              aria-label={t("nodes.actions.restart.ariaLabel", "Restart node container")}
              title={t("nodes.actions.restart.title", "Available after FN-3113")}
            >
              <RotateCw size={14} />
              <span>{t("nodes.actions.restart.label", "Restart")}</span>
            </button>
          </>
        )}

        <button
          className={`btn btn-sm node-card__action node-card__action--remove ${removeArmed ? "btn-danger is-armed" : ""}`}
          type="button"
          onClick={handleRemove}
          disabled={isLoading}
          aria-label={removeArmed ? t("nodes.actions.remove.ariaLabelConfirm", "Confirm remove node") : t("nodes.actions.remove.ariaLabel", "Remove node")}
          title={removeArmed ? t("nodes.actions.remove.titleConfirm", "Confirm remove") : t("nodes.actions.remove.title", "Remove")}
        >
          <Trash2 size={14} />
          <span>{removeArmed ? t("nodes.actions.remove.labelConfirm", "Confirm") : t("nodes.actions.remove.label", "Remove")}</span>
        </button>
      </footer>
    </article>
  );
}

export const NodeCard = memo(NodeCardInner, areNodeCardPropsEqual);
