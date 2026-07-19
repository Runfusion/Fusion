import "./AgentListModal.css";
// AgentListModal renders agent cards using .agent-board-*, .agent-icon, .agent-state-filter
// rules that live in AgentsView.css. The modal is eager but AgentsView is lazy, so we
// import the styles eagerly here to avoid the modal rendering unstyled.
import "./AgentsView.css";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Play, Pause, Square, Trash2, RefreshCw, Bot, LayoutGrid, List, Filter } from "lucide-react";
import type { Agent, AgentCapability, AgentState } from "../api";
import { fetchAgents, createAgent, updateAgent, updateAgentState, deleteAgent, fetchSettings } from "../api";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";
import { getAgentHealthStatus } from "../utils/agentHealth";
import { getErrorMessage } from "@fusion/core";
import type { AgentHealthStatus } from "../utils/agentHealth";
import { useConfirm } from "../hooks/useConfirm";
import { AgentAvatar } from "./AgentAvatar";
import { AgentErrorIndicator } from "./AgentErrorDetailsModal";
import { AgentTaskBadge } from "./AgentTaskBadge";

interface AgentListModalProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: "success" | "error") => void;
  projectId?: string;
}

const AGENT_ROLES: { value: AgentCapability; label: string; icon: string }[] = [
  { value: "triage", label: "Triage", icon: "⊕" },
  { value: "executor", label: "Executor", icon: "▶" },
  { value: "reviewer", label: "Reviewer", icon: "⊙" },
  { value: "merger", label: "Merger", icon: "⊞" },
  { value: "scheduler", label: "Scheduler", icon: "◷" },
  { value: "engineer", label: "Engineer", icon: "⎔" },
  { value: "custom", label: "Custom", icon: "✦" },
];

export function AgentListModal({ isOpen, onClose, addToast, projectId }: AgentListModalProps) {
  const { t } = useTranslation("app");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [heartbeatMultiplier, setHeartbeatMultiplier] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentRole, setNewAgentRole] = useState<AgentCapability>("custom");
  const [filterState, setFilterState] = useState<AgentState | "all">("all");
  const [view, setView] = useState<"board" | "list">(() => {
    if (typeof window === "undefined") return "list";
    const saved = getScopedItem("fn-agent-view", projectId);
    return (saved === "board" || saved === "list") ? saved : "list";
  });

  useEffect(() => {
    const saved = getScopedItem("fn-agent-view", projectId);
    if (saved === "board" || saved === "list") {
      setView(saved);
      return;
    }
    setView("list");
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    void fetchSettings(projectId)
      .then((settings) => {
        if (!cancelled) setHeartbeatMultiplier(settings.heartbeatMultiplier ?? 1);
      })
      .catch(() => {
        if (!cancelled) setHeartbeatMultiplier(1);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Persist view preference to localStorage
  useEffect(() => {
    setScopedItem("fn-agent-view", view, projectId);
  }, [projectId, view]);

  const [editingRoleForAgent, setEditingRoleForAgent] = useState<string | null>(null);
  const roleSelectRef = useRef<HTMLSelectElement>(null);
  const [transitioningAgentIds, setTransitioningAgentIds] = useState<Set<string>>(new Set());
  const [optimisticStateOverrides, setOptimisticStateOverrides] = useState<Map<string, AgentState>>(new Map());
  const { confirm } = useConfirm();

  const optimisticAgents = useMemo(() => {
    if (optimisticStateOverrides.size === 0) {
      return agents;
    }

    return agents.map((agent) => {
      const optimisticState = optimisticStateOverrides.get(agent.id);
      return optimisticState ? { ...agent, state: optimisticState } : agent;
    });
  }, [agents, optimisticStateOverrides]);

  // Display ordering: paused agents accumulate over time and would crowd
  // active agents at the top; sort them to the bottom in the default
  // "All States" view, breaking ties by `updatedAt` desc.
  const displayAgents = useMemo(() => {
    if (filterState !== "all") return optimisticAgents;
    return [...optimisticAgents].sort((a, b) => {
      const aPaused = a.state === "paused" ? 1 : 0;
      const bPaused = b.state === "paused" ? 1 : 0;
      if (aPaused !== bPaused) return aPaused - bPaused;
      return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    });
  }, [optimisticAgents, filterState]);

  // Generation counter: every loadAgents call gets a unique id; only the
  // latest call's response is allowed to write state. Prevents a slow poll
  // that started before a mutation from resolving AFTER the post-mutation
  // refetch and overwriting fresh data with stale data.
  const loadAgentsGenRef = useRef(0);

  // forceFresh: pass `true` for refetches that follow a mutation, so we don't
  // join an in-flight pre-mutation request (which would return stale data and
  // hide the just-applied change). Polling uses default (joins in-flight).
  const loadAgents = useCallback(async (forceFresh = false) => {
    const gen = ++loadAgentsGenRef.current;
    setIsLoading(true);
    try {
      const filter = filterState !== "all" ? { state: filterState } : undefined;
      const data = forceFresh
        ? await fetchAgents(filter, projectId, { forceFresh: true })
        : await fetchAgents(filter, projectId);
      // A newer load superseded us — drop this stale response.
      if (gen !== loadAgentsGenRef.current) return;
      setAgents(data);
    } catch (err) {
      addToast(t("agents.loadError", "Failed to load agents: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      if (gen === loadAgentsGenRef.current) setIsLoading(false);
    }
  }, [filterState, addToast, projectId]);

  useEffect(() => {
    if (isOpen) {
      void loadAgents();
    }
  }, [isOpen, loadAgents]);

  // Poll for agent updates to keep health statuses fresh (every 30 seconds)
  // This ensures health badges stay current while the modal is open
  useEffect(() => {
    if (!isOpen) return;

    const pollInterval = setInterval(() => {
      void loadAgents();
    }, 30_000);

    return () => {
      clearInterval(pollInterval);
    };
  }, [isOpen, loadAgents]);

  const handleCreate = async () => {
    if (!newAgentName.trim()) return;
    try {
      await createAgent({ name: newAgentName.trim(), role: newAgentRole }, projectId);
      addToast(t("agents.createSuccess", "Agent \"{{name}}\" created", { name: newAgentName }), "success");
      setNewAgentName("");
      setIsCreating(false);
      void loadAgents(true);
    } catch (err) {
      addToast(t("agents.createError", "Failed to create agent: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  };

  const handleStateChange = async (agentId: string, newState: AgentState) => {
    if (transitioningAgentIds.has(agentId)) return;

    setTransitioningAgentIds((prev) => new Set(prev).add(agentId));
    setOptimisticStateOverrides((prev) => {
      const next = new Map(prev);
      next.set(agentId, newState);
      return next;
    });

    try {
      await updateAgentState(agentId, newState, projectId);
      addToast(t("agents.stateUpdateSuccess", "Agent state updated to {{state}}", { state: newState }), "success");
      await loadAgents(true);
      setOptimisticStateOverrides((prev) => {
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });
    } catch (err) {
      setOptimisticStateOverrides((prev) => {
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });
      addToast(t("agents.stateUpdateError", "Failed to update state: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setTransitioningAgentIds((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  };

  const handleDelete = async (agentId: string, agentName: string) => {
    const shouldDelete = await confirm({
      title: t("agents.deleteTitle", "Delete Agent"),
      message: t("agents.deleteMessage", "Delete agent \"{{name}}\"? This cannot be undone.", { name: agentName }),
      danger: true,
    });
    if (!shouldDelete) return;
    try {
      await deleteAgent(agentId, projectId);
      addToast(t("agents.deleteSuccess", "Agent \"{{name}}\" deleted", { name: agentName }), "success");
      void loadAgents(true);
    } catch (err) {
      addToast(t("agents.deleteError", "Failed to delete agent: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  };

  const handleRoleChange = async (agentId: string, newRole: AgentCapability) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;

    // If same role, just cancel editing without API call
    if (agent.role === newRole) {
      setEditingRoleForAgent(null);
      return;
    }

    try {
      await updateAgent(agentId, { role: newRole }, projectId);
      addToast(t("agents.roleUpdateSuccess", "Agent role updated to {{role}}", { role: getRoleLabel(newRole) }), "success");
      setEditingRoleForAgent(null);
      void loadAgents(true);
    } catch (err) {
      addToast(t("agents.roleUpdateError", "Failed to update role: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  };

  const handleRoleKeyDown = (e: React.KeyboardEvent, _agentId: string) => {
    if (e.key === "Escape") {
      setEditingRoleForAgent(null);
    }
  };

  const ROLE_LABEL_KEYS: Record<string, { key: string; defaultValue: string }> = {
    triage: { key: "agents.roleTriage", defaultValue: "Triage" },
    executor: { key: "agents.roleExecutor", defaultValue: "Executor" },
    reviewer: { key: "agents.roleReviewer", defaultValue: "Reviewer" },
    merger: { key: "agents.roleMerger", defaultValue: "Merger" },
    scheduler: { key: "agents.roleScheduler", defaultValue: "Scheduler" },
    engineer: { key: "agents.roleEngineer", defaultValue: "Engineer" },
    custom: { key: "agents.roleCustom", defaultValue: "Custom" },
  };
  const getRoleLabel = (role: AgentCapability) => {
    const entry = ROLE_LABEL_KEYS[role];
    if (entry) return t(entry.key, entry.defaultValue);
    return role;
  };

  // Use centralized health status utility for consistent labels across all views
  // This fixes the previous hardcoded 60s timeout that was inconsistent with other views
  const getHealthStatus = (agent: Agent): AgentHealthStatus => {
    return getAgentHealthStatus(agent, heartbeatMultiplier);
  };

  const getHealthTone = (health: AgentHealthStatus): "active" | "paused" | "error" | "muted" => {
    if (health.color === "var(--state-active-text)") return "active";
    if (health.color === "var(--state-paused-text)") return "paused";
    if (health.color === "var(--state-error-text)") return "error";
    return "muted";
  };

  const getHealthSummary = (agent: Agent, health: AgentHealthStatus): { title: string | undefined; label: string | null } => {
    if (agent.state === "error") {
      return { title: undefined, label: t("agents.healthError", "Error") };
    }

    return {
      title: health.reason ?? health.label,
      label: health.stateDerived ? null : health.label,
    };
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true">
      <div className="modal modal--wide agent-list-modal">
        <div className="modal-header">
          <h2 className="modal-title">
            <Bot size={20} />
            {t("agents.modalTitle", "Agents")}
          </h2>
          <div className="modal-actions">
            <div className="view-toggle">
              <button
                className={`view-toggle-btn${view === "board" ? " active" : ""}`}
                onClick={() => setView("board")}
                title={t("agents.boardView", "Board view")}
                aria-label={t("agents.boardView", "Board view")}
                aria-pressed={view === "board"}
              >
                <LayoutGrid size={16} />
              </button>
              <button
                className={`view-toggle-btn${view === "list" ? " active" : ""}`}
                onClick={() => setView("list")}
                title={t("agents.listView", "List view")}
                aria-label={t("agents.listView", "List view")}
                aria-pressed={view === "list"}
              >
                <List size={16} />
              </button>
            </div>
            <button
              className="btn-icon"
              onClick={() => void loadAgents()}
              title={t("agents.refresh", "Refresh")}
              disabled={isLoading}
            >
              <RefreshCw size={16} className={isLoading ? "spin" : ""} />
            </button>
            <button className="modal-close" onClick={onClose} aria-label={t("agents.close", "Close")}>
              &times;
            </button>
          </div>
        </div>

        <div className="modal-content agent-modal-content">
          {/* Filter and Create Bar */}
          <div className="agent-controls">
            <div className="agent-state-filter">
              <Filter size={14} />
              <select
                className="agent-state-filter-select"
                value={filterState}
                onChange={(e) => setFilterState(e.target.value as AgentState | "all")}
                aria-label={t("agents.filterByState", "Filter agents by state")}
              >
                <option value="all">{t("agents.filterAll", "All States")}</option>
                <option value="idle">{t("agents.stateIdle", "Idle")}</option>
                <option value="active">{t("agents.stateActive", "Active")}</option>
                <option value="running">{t("agents.stateRunning", "Running")}</option>
                <option value="paused">{t("agents.statePaused", "Paused")}</option>
                <option value="error">{t("agents.stateError", "Error")}</option>
              </select>
            </div>

            <button
              className="btn btn-task-create btn-sm"
              onClick={() => setIsCreating(!isCreating)}
            >
              <Plus size={16} />
              {isCreating ? t("agents.cancel", "Cancel") : t("agents.newAgent", "New Agent")}
            </button>
          </div>

          {/* Create Form */}
          {isCreating && (
            <div className="agent-create-form">
              <input
                type="text"
                placeholder={t("agents.namePlaceholder", "Agent name...")}
                value={newAgentName}
                onChange={(e) => setNewAgentName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                className="input"
                autoFocus
              />
              <select
                className="select"
                value={newAgentRole}
                onChange={(e) => setNewAgentRole(e.target.value as AgentCapability)}
              >
                {AGENT_ROLES.map(role => (
                  <option key={role.value} value={role.value}>
                    {role.icon} {getRoleLabel(role.value)}
                  </option>
                ))}
              </select>
              <button className="btn btn-task-create btn-sm" onClick={() => void handleCreate()}>
                {t("agents.create", "Create")}
              </button>
            </div>
          )}

          {/* Agent List */}
          <div className={view === "board" ? "agent-board" : "agent-list"}>
            {displayAgents.length === 0 ? (
              <div className="agent-empty">
                <Bot size={48} opacity={0.3} />
                <p>{t("agents.emptyTitle", "No agents found")}</p>
                <p className="text-secondary">{t("agents.emptySubtitle", "Create an agent to get started")}</p>
              </div>
            ) : view === "board" ? (
              // Board view: compact grid layout
              displayAgents.map(agent => {
                const health = getHealthStatus(agent);
                const healthSummary = getHealthSummary(agent, health);
                const healthTone = getHealthTone(health);
                return (
                  <div key={agent.id} className="agent-board-card" data-state={agent.state}>
                    <div className="agent-board-header">
                      <span className="agent-board-icon"><AgentAvatar agent={agent} size={20} /></span>
                      <span
                        className="agent-board-badge"
                        data-state={agent.state}
                      >
                        {agent.state}
                      </span>
                      <span className="agent-board-health" data-health={healthTone} title={healthSummary.title}>
                        {health.icon}
                      </span>
                    </div>
                    <div className="agent-board-name" title={agent.name}>
                      {agent.name}
                    </div>
                    <div className="agent-board-id">{agent.id}</div>
                    <div className="agent-board-actions">
                      {agent.state === "idle" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "active")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.activate", "Activate")}
                          >
                            <Play size={14} />
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleDelete(agent.id, agent.name)}
                            title={t("agents.delete", "Delete")}
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                      {agent.state === "active" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.pause", "Pause")}
                          >
                            <Pause size={14} />
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.stop", "Stop")}
                          >
                            <Square size={14} />
                          </button>
                        </>
                      )}
                      {agent.state === "paused" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "active")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.resume", "Resume")}
                          >
                            <Play size={14} />
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleDelete(agent.id, agent.name)}
                            title={t("agents.delete", "Delete")}
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                      {agent.state === "running" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.pause", "Pause")}
                          >
                            <Pause size={14} />
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.stop", "Stop")}
                          >
                            <Square size={14} />
                          </button>
                        </>
                      )}
                      {agent.state === "error" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "active")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.retry", "Retry")}
                          >
                            <Play size={14} />
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.stop", "Stop")}
                          >
                            <Square size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              // List view: detailed card layout
              displayAgents.map(agent => {
                const health = getHealthStatus(agent);
                const healthSummary = getHealthSummary(agent, health);
                const healthTone = getHealthTone(health);
                return (
                  <div key={agent.id} className="agent-card" data-state={agent.state}>
                    <div className="agent-card-header">
                      <div className="agent-info">
                        {editingRoleForAgent === agent.id ? (
                          <select
                            ref={roleSelectRef}
                            className="select agent-role-select"
                            value={agent.role}
                            onChange={(e) => void handleRoleChange(agent.id, e.target.value as AgentCapability)}
                            onKeyDown={(e) => handleRoleKeyDown(e, agent.id)}
                            onBlur={() => setEditingRoleForAgent(null)}
                            autoFocus
                          >
                            {AGENT_ROLES.map(role => (
                              <option key={role.value} value={role.value}>
                                {role.icon} {getRoleLabel(role.value)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span
                            className="agent-icon agent-icon--clickable"
                            onClick={() => setEditingRoleForAgent(agent.id)}
                            title={t("agents.changeRole", "Click to change role")}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                setEditingRoleForAgent(agent.id);
                              }
                            }}
                          >
                            <AgentAvatar agent={agent} size={20} />
                          </span>
                        )}
                        <div className="agent-meta">
                          <span className="agent-name">{agent.name}</span>
                          <span className="agent-id text-secondary">{agent.id}</span>
                        </div>
                      </div>
                      <div className="agent-badges">
                        <span
                          className="badge agent-list-state-badge"
                          data-state={agent.state}
                        >
                          {agent.state}
                        </span>
                        <span className="badge agent-list-health-badge" data-health={healthTone} title={healthSummary.title}>
                          {health.icon}{healthSummary.label ? ` ${healthSummary.label}` : ""}
                        </span>
                        <span className="badge text-secondary">
                          {getRoleLabel(agent.role)}
                        </span>
                      </div>
                    </div>

                    <div className="agent-card-body">
                      {agent.state === "error" && agent.lastError ? (
                        <AgentErrorIndicator
                          errorText={agent.lastError}
                          issueContext={{
                            surface: "AgentListModal list",
                            agentId: agent.id,
                            agentName: agent.name,
                            agentState: agent.state,
                            taskId: agent.taskId,
                          }}
                        />
                      ) : null}
                      {agent.taskId && (
                        <div className="agent-task">
                          <span className="text-secondary">{t("agents.workingOn", "Working on:")}</span>
                          <span className="badge"><AgentTaskBadge taskId={agent.taskId} taskColumn={agent.taskColumn} /></span>
                        </div>
                      )}
                      {agent.lastHeartbeatAt && (
                        <div className="agent-heartbeat">
                          <span className="text-secondary">{t("agents.lastHeartbeat", "Last heartbeat:")}</span>
                          <span>{new Date(agent.lastHeartbeatAt).toLocaleString()}</span>
                        </div>
                      )}
                    </div>

                    <div className="agent-card-actions">
                      {agent.state === "idle" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "active")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.activate", "Activate")}
                          >
                            <Play size={14} /> {t("agents.start", "Start")}
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleDelete(agent.id, agent.name)}
                            title={t("agents.delete", "Delete")}
                          >
                            <Trash2 size={14} /> {t("agents.delete", "Delete")}
                          </button>
                        </>
                      )}
                      {agent.state === "active" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.pause", "Pause")}
                          >
                            <Pause size={14} /> {t("agents.pause", "Pause")}
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.stop", "Stop")}
                          >
                            <Square size={14} /> {t("agents.stop", "Stop")}
                          </button>
                        </>
                      )}
                      {agent.state === "paused" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "active")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.resume", "Resume")}
                          >
                            <Play size={14} /> {t("agents.resume", "Resume")}
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleDelete(agent.id, agent.name)}
                            title={t("agents.delete", "Delete")}
                          >
                            <Trash2 size={14} /> {t("agents.delete", "Delete")}
                          </button>
                        </>
                      )}
                      {agent.state === "running" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.pause", "Pause")}
                          >
                            <Pause size={14} /> {t("agents.pause", "Pause")}
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.stop", "Stop")}
                          >
                            <Square size={14} /> {t("agents.stop", "Stop")}
                          </button>
                        </>
                      )}
                      {agent.state === "error" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "active")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.retry", "Retry")}
                          >
                            <Play size={14} /> {t("agents.retry", "Retry")}
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title={t("agents.stop", "Stop")}
                          >
                            <Square size={14} /> {t("agents.stop", "Stop")}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
   </div>
  );
}
