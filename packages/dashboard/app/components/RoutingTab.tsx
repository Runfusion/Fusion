import "./RoutingTab.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Settings, Task, TaskDetail } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import { fetchNodes, updateTask } from "../api";
import type { NodeInfo } from "../api";
import type { ToastType } from "../hooks/useToast";
import { NodeHealthDot } from "./NodeHealthDot";
import { ACTIVE_STATUSES } from "../utils/taskActivity";

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

function getRoutingPolicyLabel(policy: RoutingSettings["unavailableNodePolicy"] | undefined, t: (key: string, defaultValue: string) => string): string {
  if (policy === "block") return t("routing.policyLabel.block", "Block execution");
  if (policy === "fallback-local") return t("routing.policyLabel.fallback", "Fall back to local");
  return t("routing.policyLabel.notConfigured", "Not configured");
}

function isUnhealthy(status: NodeInfo["status"] | undefined): boolean {
  return status !== undefined && status !== "online";
}

export function RoutingTab({ task, settings, addToast, onTaskUpdated }: RoutingTabProps) {
  const { t } = useTranslation("app");
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
        setNodesError(getErrorMessage(err) || t("routing.errorLoadingNodes", "Failed to load nodes"));
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
    ? t("routing.source.override", "Per-task override")
    : routingSettings?.defaultNodeId
      ? t("routing.source.projectDefault", "Project default")
      : t("routing.source.noRouting", "No routing");

  const effectiveNode = effectiveNodeId ? nodesById.get(effectiveNodeId) : undefined;
  const effectiveNodeName = effectiveNode
    ? `${effectiveNode.name} (${effectiveNode.type})`
    : effectiveNodeId
      ? `${effectiveNodeId} (${t("routing.nodeUnavailable", "node unavailable or unknown")})`
      : t("routing.localNoConfiguration", "Local (no routing configured)");

  const isTaskActive = task.column === "in-progress" || ACTIVE_STATUSES.has(task.status as string);
  const selectorDisabled = isTaskActive || savingNode || loadingNodes;

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
        addToast(nextValue ? t("routing.overrideUpdated", "Node override updated") : t("routing.overrideCleared", "Node override cleared"), "success");
      } catch (err) {
        if (activeTaskIdRef.current !== requestTaskId) return;
        setSelectedNodeId(previousValue);
        addToast(getErrorMessage(err) || t("routing.errorUpdatingOverride", "Failed to update node override"), "error");
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
      <h4>{t("routing.title", "Task Routing")}</h4>
      <p className="routing-tab__intro">{t("routing.intro", "View the effective execution node and control per-task node override.")}</p>

      <section className="routing-tab__section">
        <h5>{t("routing.summarySection", "Routing Summary")}</h5>
        <div className="routing-summary-grid" role="list">
          <div className="routing-summary-row" role="listitem">
            <span className="routing-summary-label">{t("routing.effectiveNode", "Effective node")}</span>
            <span className="routing-summary-value">
              {effectiveNode ? <NodeHealthDot status={effectiveNode.status} compact /> : null}
              {effectiveNodeName}
              {isUnhealthy(effectiveNode?.status) ? (
                <span className="routing-summary-warning">{t("routing.unhealthy", "Unhealthy")}</span>
              ) : null}
            </span>
          </div>
          <div className="routing-summary-row" role="listitem">
            {/* FNXC:Routing 2026-07-01-00:00: `routing.source` is a nested object (noRouting/override/projectDefault); the label must read the `routing.sourceLabel` leaf or i18next returns "returned an object instead of string" and crashes this tab (issue #1863 bug class). */}
            <span className="routing-summary-label">{t("routing.sourceLabel", "Routing source")}</span>
            <span className="routing-summary-value">{routingSource}</span>
          </div>
          <div className="routing-summary-row" role="listitem">
            <span className="routing-summary-label">{t("routing.unavailablePolicy", "Unavailable-node policy")}</span>
            <span className="routing-summary-value">{getRoutingPolicyLabel(routingSettings?.unavailableNodePolicy, t)}</span>
          </div>
        </div>
        {isTaskActive && effectiveNodeId ? (
          <div className="routing-tab__info-banner">
            {t("routing.lockedWhileActive", "Routing is locked while this task is active. Node override cannot be changed until the task is no longer active.")}
          </div>
        ) : null}
      </section>

      <section className="routing-tab__section">
        <h5>{t("routing.overrideSection", "Node Override")}</h5>
        {isTaskActive ? (
          <div className="routing-tab__warning-banner">
            {t("routing.cannotChangeWhileActive", "Node override cannot be changed while the task is active.")}
          </div>
        ) : null}

        <label className="routing-tab__selector-label" htmlFor={`routing-node-${task.id}`}>
          {t("routing.selectLabel", "Select execution node")}
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
          <option value="">{t("routing.useProjectDefault", "Use project default")}</option>
          {sortedNodes.map((node) => (
            <option key={node.id} value={node.id} title={`Status: ${node.status}`}>
              {t("routing.nodeOptionLabel", "{{name}} ({{type}}) — {{status}}", { name: node.name, type: node.type, status: node.status })}
            </option>
          ))}
        </select>

        {nodesError ? <div className="routing-tab__error">{nodesError}</div> : null}

        {task.nodeId ? (
          <div className="routing-tab__override-row">
            <span className="routing-tab__override-text">
              {t("routing.overrideSetTo", "Override set to")}: {nodesById.get(task.nodeId)?.name ?? task.nodeId}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={isTaskActive || savingNode}
              onClick={clearOverride}
            >
              {t("routing.clearOverride", "Clear override")}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
