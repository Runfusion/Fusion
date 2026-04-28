import "./RoutingTab.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getErrorMessage, type Settings, type Task, type TaskDetail } from "@fusion/core";
import { fetchNodes, updateTask } from "../api";
import type { NodeInfo } from "../api";
import type { ToastType } from "../hooks/useToast";
import { ProjectNodeSelector } from "./ProjectNodeSelector";

interface RoutingTabProps {
  task: Task | TaskDetail;
  settings?: Settings;
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
  onTaskUpdated?: (task: Task) => void;
}

function resolveUnavailablePolicy(policy?: string): string {
  if (policy === "block") return "Block execution";
  if (policy === "fallback-local") return "Fall back to local";
  return "Not configured";
}

export function RoutingTab({ task, settings, projectId, addToast, onTaskUpdated }: RoutingTabProps) {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const isInProgress = task.column === "in-progress";

  useEffect(() => {
    let mounted = true;

    fetchNodes()
      .then((fetchedNodes) => {
        if (mounted) setNodes(fetchedNodes);
      })
      .catch((error) => {
        if (mounted) {
          addToast(`Failed to load nodes: ${getErrorMessage(error)}`, "error");
        }
      });

    return () => {
      mounted = false;
    };
  }, [addToast]);

  const effectiveNodeName = useMemo(() => {
    if (task.nodeId) {
      const taskNode = nodes.find((node) => node.id === task.nodeId);
      return taskNode ? taskNode.name : `${task.nodeId} (unknown node)`;
    }

    if (settings?.defaultNodeId) {
      const defaultNode = nodes.find((node) => node.id === settings.defaultNodeId);
      return defaultNode ? `${defaultNode.name} (project default)` : `${settings.defaultNodeId} (unknown node)`;
    }

    return "Local (no routing configured)";
  }, [nodes, settings?.defaultNodeId, task.nodeId]);

  const routingSource = task.nodeId
    ? "Per-task override"
    : settings?.defaultNodeId
      ? "Project default"
      : "No routing";

  const blockingReason = (task as Task & { blockedReason?: string; statusReason?: string }).blockedReason
    || (task as Task & { statusReason?: string }).statusReason;

  const handleNodeSelect = useCallback(
    async (selectedNodeId: string | null) => {
      try {
        const updated = await updateTask(task.id, { nodeId: selectedNodeId || null });
        addToast("Node override updated", "success");
        onTaskUpdated?.(updated);
      } catch (error) {
        addToast(`Failed to update node override: ${getErrorMessage(error)}`, "error");
      }
    },
    [addToast, onTaskUpdated, task.id],
  );

  const handleClearOverride = useCallback(async () => {
    await handleNodeSelect(null);
  }, [handleNodeSelect]);

  return (
    <div className="routing-tab">
      <div className="routing-tab-summary">
        <h4>Node Routing Summary</h4>
        <dl className="detail-source-grid">
          <div>
            <dt>Effective Node</dt>
            <dd>{effectiveNodeName}</dd>
          </div>
          <div>
            <dt>Routing Source</dt>
            <dd>{routingSource}</dd>
          </div>
          <div>
            <dt>Unavailable Node Policy</dt>
            <dd>{resolveUnavailablePolicy(settings?.unavailableNodePolicy)}</dd>
          </div>
          <div>
            <dt>Blocking Reason</dt>
            <dd>{blockingReason ?? <span className="detail-source-empty">(not blocked)</span>}</dd>
          </div>
        </dl>
      </div>

      <div className="routing-tab-override">
        <h4>Node Override</h4>
        <ProjectNodeSelector
          projectId={projectId ?? ""}
          nodes={nodes}
          currentNodeId={task.nodeId ?? undefined}
          onSelect={(nodeId) => {
            void handleNodeSelect(nodeId);
          }}
          disabled={isInProgress}
        />
        {isInProgress ? (
          <div className="routing-tab-blocked">
            Node override cannot be changed while the task is in progress. Wait for the task to complete or move it
            back to todo first.
          </div>
        ) : null}
        {task.nodeId && !isInProgress ? (
          <div className="routing-tab-actions">
            <button type="button" className="btn btn-sm" onClick={() => void handleClearOverride()}>
              Clear override
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
