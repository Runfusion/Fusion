import "./RoutingTab.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Settings, Task, TaskDetail } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import { fetchNodes, updateTask } from "../api";
import type { NodeInfo } from "../api";
import type { ToastType } from "../hooks/useToast";

interface RoutingTabProps {
  task: Task | TaskDetail;
  settings?: Settings;
  addToast: (message: string, type?: ToastType) => void;
  onTaskUpdated?: (task: Task) => void;
}

type RoutingSettings = Settings & {
  defaultNodeId?: string;
  unavailableNodePolicy?: "block" | "fallback-local";
};

function getRoutingPolicyLabel(policy: RoutingSettings["unavailableNodePolicy"] | undefined): string {
  if (policy === "block") return "Block execution";
  if (policy === "fallback-local") return "Fall back to local";
  return "Not configured";
}

function isUnhealthy(status: NodeInfo["status"] | undefined): boolean {
  return status !== undefined && status !== "online";
}

export function RoutingTab({ task, settings, addToast, onTaskUpdated }: RoutingTabProps) {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(false);
  const [nodesError, setNodesError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string>(task.nodeId ?? "");
  const [savingNode, setSavingNode] = useState(false);

  const activeTaskIdRef = useRef(task.id);

  useEffect(() => {
    activeTaskIdRef.current = task.id;
    setSelectedNodeId(task.nodeId ?? "");
    setSavingNode(false);
  }, [task.id, task.nodeId]);

  useEffect(() => {
    setLoadingNodes(true);
    setNodesError(null);

    fetchNodes()
      .then((result) => {
        setNodes(result);
      })
      .catch((err) => {
        setNodesError(getErrorMessage(err) || "Failed to load nodes");
      })
      .finally(() => {
        setLoadingNodes(false);
      });
  }, []);

  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const sortedNodes = useMemo(
    () => [...nodes].sort((a, b) => a.name.localeCompare(b.name)),
    [nodes],
  );

  const routingSettings = settings as RoutingSettings | undefined;
  const effectiveNodeId = task.nodeId ?? routingSettings?.defaultNodeId ?? null;
  const routingSource = task.nodeId
    ? "Per-task override"
    : routingSettings?.defaultNodeId
      ? "Project default"
      : "No routing";

  const effectiveNode = effectiveNodeId ? nodesById.get(effectiveNodeId) : undefined;
  const effectiveNodeName = effectiveNode
    ? `${effectiveNode.name} (${effectiveNode.type}) — ${effectiveNode.status}`
    : effectiveNodeId
      ? `${effectiveNodeId} (node unavailable or unknown)`
      : "Local (no routing configured)";

  const taskInProgress = task.column === "in-progress";
  const selectorDisabled = taskInProgress || savingNode || loadingNodes;

  const handleNodeSelect = useCallback(
    async (nextValue: string) => {
      if (nextValue === selectedNodeId) {
        return;
      }

      const requestTaskId = task.id;
      const previousValue = selectedNodeId;
      setSelectedNodeId(nextValue);
      setSavingNode(true);

      try {
        const updatedTask = await updateTask(requestTaskId, { nodeId: nextValue || null });
        if (activeTaskIdRef.current !== requestTaskId) return;

        setSelectedNodeId(updatedTask.nodeId ?? "");
        onTaskUpdated?.(updatedTask);
        addToast(nextValue ? "Node override updated" : "Node override cleared", "success");
      } catch (err) {
        if (activeTaskIdRef.current !== requestTaskId) return;
        setSelectedNodeId(previousValue);
        addToast(getErrorMessage(err) || "Failed to update node override", "error");
      } finally {
        if (activeTaskIdRef.current === requestTaskId) {
          setSavingNode(false);
        }
      }
    },
    [addToast, onTaskUpdated, selectedNodeId, task.id],
  );

  const clearOverride = useCallback(() => {
    void handleNodeSelect("");
  }, [handleNodeSelect]);

  return (
    <div className="routing-tab">
      <h4>Task Routing</h4>
      <p className="routing-tab__intro">View the effective execution node and control per-task node override.</p>

      <section className="routing-tab__section">
        <h5>Routing Summary</h5>
        <div className="routing-summary-grid" role="list">
          <div className="routing-summary-row" role="listitem">
            <span className="routing-summary-label">Effective node</span>
            <span className="routing-summary-value">
              {effectiveNodeName}
              {isUnhealthy(effectiveNode?.status) ? (
                <span className="routing-summary-warning">Unhealthy</span>
              ) : null}
            </span>
          </div>
          <div className="routing-summary-row" role="listitem">
            <span className="routing-summary-label">Routing source</span>
            <span className="routing-summary-value">{routingSource}</span>
          </div>
          <div className="routing-summary-row" role="listitem">
            <span className="routing-summary-label">Unavailable-node policy</span>
            <span className="routing-summary-value">{getRoutingPolicyLabel(routingSettings?.unavailableNodePolicy)}</span>
          </div>
        </div>
        {taskInProgress && effectiveNodeId ? (
          <div className="routing-tab__info-banner">
            Routing is locked while this task is active. Node override cannot be changed until the task leaves in-progress.
          </div>
        ) : null}
      </section>

      <section className="routing-tab__section">
        <h5>Node Override</h5>
        {taskInProgress ? (
          <div className="routing-tab__warning-banner">
            Node override cannot be changed while the task is in progress.
          </div>
        ) : null}

        <label className="routing-tab__selector-label" htmlFor={`routing-node-${task.id}`}>
          Select execution node
        </label>
        <select
          id={`routing-node-${task.id}`}
          className="select routing-tab__selector"
          value={selectedNodeId}
          disabled={selectorDisabled}
          onChange={(event) => {
            void handleNodeSelect(event.target.value);
          }}
        >
          <option value="">Use project default</option>
          {sortedNodes.map((node) => (
            <option key={node.id} value={node.id} title={`Status: ${node.status}`}>
              {node.name} ({node.type}) — {node.status}
            </option>
          ))}
        </select>

        {nodesError ? <div className="routing-tab__error">{nodesError}</div> : null}

        {task.nodeId ? (
          <div className="routing-tab__override-row">
            <span className="routing-tab__override-text">
              Override set to: {nodesById.get(task.nodeId)?.name ?? task.nodeId}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={taskInProgress || savingNode}
              onClick={clearOverride}
            >
              Clear override
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
