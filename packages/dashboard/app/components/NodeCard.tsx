import { memo, useCallback, useMemo, useState } from "react";
import { Activity, Server, Settings, Trash2 } from "lucide-react";
import type { NodeInfo, ProjectInfo } from "../api";
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
}

const STATUS_CONFIG: Record<NodeInfo["status"], { label: string; color: string; className: string }> = {
  online: { label: "Online", color: "var(--success)", className: "node-card__status--online" },
  offline: { label: "Offline", color: "var(--color-error)", className: "node-card__status--offline" },
  connecting: { label: "Connecting", color: "var(--warning)", className: "node-card__status--connecting" },
  error: { label: "Error", color: "var(--color-error)", className: "node-card__status--error" },
};

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
}: NodeCardProps) {
  const [removeArmed, setRemoveArmed] = useState(false);
  const statusConfig = STATUS_CONFIG[node.status];

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
              <span className="node-card__type-badge">{node.type === "local" ? "Local" : "Remote"}</span>
              <span
                className={`node-card__status ${statusConfig.className}`}
                style={{ color: statusConfig.color }}
                data-status={node.status}
              >
                <span className="node-card__status-indicator" style={{ backgroundColor: statusConfig.color }} aria-hidden />
                {statusConfig.label}
              </span>
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

        <div className="node-card__metrics">
          <div className="node-card__metric">
            <span className="node-card__metric-label">Projects</span>
            <span className="node-card__metric-value">{assignedProjectCount}</span>
          </div>
          <div className="node-card__metric">
            <span className="node-card__metric-label">Concurrency</span>
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
          className="node-card__action"
          type="button"
          onClick={handleHealthCheck}
          disabled={isLoading}
          aria-label="Run node health check"
          title="Health Check"
        >
          <Activity size={14} />
          <span>Health</span>
        </button>

        <button
          className="node-card__action"
          type="button"
          onClick={handleEdit}
          disabled={isLoading}
          aria-label="Edit node"
          title="Edit"
        >
          <Settings size={14} />
          <span>Edit</span>
        </button>

        <button
          className={`node-card__action node-card__action--remove ${removeArmed ? "is-armed" : ""}`}
          type="button"
          onClick={handleRemove}
          disabled={isLoading}
          aria-label={removeArmed ? "Confirm remove node" : "Remove node"}
          title={removeArmed ? "Confirm remove" : "Remove"}
        >
          <Trash2 size={14} />
          <span>{removeArmed ? "Confirm" : "Remove"}</span>
        </button>
      </footer>
    </article>
  );
}

export const NodeCard = memo(NodeCardInner, areNodeCardPropsEqual);
