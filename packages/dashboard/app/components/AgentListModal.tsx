import "./AgentListModal.css";
// AgentListModal renders agent cards using .agent-board-*, .agent-icon, .agent-state-filter
// rules that live in AgentsView.css. The modal is eager but AgentsView is lazy, so we
// import the styles eagerly here to avoid the modal rendering unstyled.
import "./AgentsView.css";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Plus, Play, Pause, Square, Trash2, RefreshCw, Bot, LayoutGrid, List, Filter } from "lucide-react";
import type { Agent, AgentCapability, AgentState } from "../api";
import { fetchAgents, createAgent, updateAgent, updateAgentState, deleteAgent } from "../api";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";
import { getAgentHealthStatus } from "../utils/agentHealth";
import { getErrorMessage } from "@fusion/core";
import type { AgentHealthStatus } from "../utils/agentHealth";
import { useConfirm } from "../hooks/useConfirm";

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
  const [agents, setAgents] = useState<Agent[]>([]);
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

  // Filter agents for display: hide terminated agents in default "All States" view
  // but show them when the user explicitly filters to "terminated"
  const displayAgents = useMemo(() => {
    if (filterState === "all") {
      return optimisticAgents.filter((a) => a.state !== "terminated");
    }
    return optimisticAgents;
  }, [optimisticAgents, filterState]);

  const loadAgents = useCallback(async () => {
    setIsLoading(true);
    try {
      const filter = filterState !== "all" ? { state: filterState } : undefined;
      const data = await fetchAgents(filter, projectId);
      setAgents(data);
    } catch (err) {
      addToast(`Failed to load agents: ${getErrorMessage(err)}`, "error");
    } finally {
      setIsLoading(false);
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
      addToast(`Agent "${newAgentName}" created`, "success");
      setNewAgentName("");
      setIsCreating(false);
      void loadAgents();
    } catch (err) {
      addToast(`Failed to create agent: ${getErrorMessage(err)}`, "error");
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
      addToast(`Agent state updated to ${newState}`, "success");
      await loadAgents();
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
      addToast(`Failed to update state: ${getErrorMessage(err)}`, "error");
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
      title: "Delete Agent",
      message: `Delete agent "${agentName}"? This cannot be undone.`,
      danger: true,
    });
    if (!shouldDelete) return;
    try {
      await deleteAgent(agentId, projectId);
      addToast(`Agent "${agentName}" deleted`, "success");
      void loadAgents();
    } catch (err) {
      addToast(`Failed to delete agent: ${getErrorMessage(err)}`, "error");
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
      addToast(`Agent role updated to ${AGENT_ROLES.find(r => r.value === newRole)?.label ?? newRole}`, "success");
      setEditingRoleForAgent(null);
      void loadAgents();
    } catch (err) {
      addToast(`Failed to update role: ${getErrorMessage(err)}`, "error");
    }
  };

  const handleRoleKeyDown = (e: React.KeyboardEvent, _agentId: string) => {
    if (e.key === "Escape") {
      setEditingRoleForAgent(null);
    }
  };

  const getRoleLabel = (role: AgentCapability) => AGENT_ROLES.find(r => r.value === role)?.label ?? role;
  const getRoleIcon = (role: AgentCapability) => AGENT_ROLES.find(r => r.value === role)?.icon ?? "◆";

  // Use centralized health status utility for consistent labels across all views
  // This fixes the previous hardcoded 60s timeout that was inconsistent with other views
  const getHealthStatus = (agent: Agent): AgentHealthStatus => {
    return getAgentHealthStatus(agent);
  };

  const getHealthTone = (health: AgentHealthStatus): "active" | "paused" | "error" | "muted" => {
    if (health.color === "var(--state-active-text)") return "active";
    if (health.color === "var(--state-paused-text)") return "paused";
    if (health.color === "var(--state-error-text)") return "error";
    return "muted";
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true">
      <div className="modal modal--wide agent-list-modal">
        <div className="modal-header">
          <h2 className="modal-title">
            <Bot size={20} />
            Agents
          </h2>
          <div className="modal-actions">
            <div className="view-toggle">
              <button
                className={`view-toggle-btn${view === "board" ? " active" : ""}`}
                onClick={() => setView("board")}
                title="Board view"
                aria-label="Board view"
                aria-pressed={view === "board"}
              >
                <LayoutGrid size={16} />
              </button>
              <button
                className={`view-toggle-btn${view === "list" ? " active" : ""}`}
                onClick={() => setView("list")}
                title="List view"
                aria-label="List view"
                aria-pressed={view === "list"}
              >
                <List size={16} />
              </button>
            </div>
            <button
              className="btn-icon"
              onClick={() => void loadAgents()}
              title="Refresh"
              disabled={isLoading}
            >
              <RefreshCw size={16} className={isLoading ? "spin" : ""} />
            </button>
            <button className="modal-close" onClick={onClose} aria-label="Close">
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
                aria-label="Filter agents by state"
              >
                <option value="all">All States</option>
                <option value="idle">Idle</option>
                <option value="active">Active</option>
                <option value="running">Running</option>
                <option value="paused">Paused</option>
                <option value="error">Error</option>
                <option value="terminated">Terminated</option>
              </select>
            </div>

            <button
              className="btn btn-task-create btn-sm"
              onClick={() => setIsCreating(!isCreating)}
            >
              <Plus size={16} />
              {isCreating ? "Cancel" : "New Agent"}
            </button>
          </div>

          {/* Create Form */}
          {isCreating && (
            <div className="agent-create-form">
              <input
                type="text"
                placeholder="Agent name..."
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
                    {role.icon} {role.label}
                  </option>
                ))}
              </select>
              <button className="btn btn-task-create btn-sm" onClick={() => void handleCreate()}>
                Create
              </button>
            </div>
          )}

          {/* Agent List */}
          <div className={view === "board" ? "agent-board" : "agent-list"}>
            {displayAgents.length === 0 ? (
              <div className="agent-empty">
                <Bot size={48} opacity={0.3} />
                <p>No agents found</p>
                <p className="text-secondary">Create an agent to get started</p>
              </div>
            ) : view === "board" ? (
              // Board view: compact grid layout
              displayAgents.map(agent => {
                const health = getHealthStatus(agent);
                const healthTone = getHealthTone(health);
                return (
                  <div key={agent.id} className="agent-board-card" data-state={agent.state}>
                    <div className="agent-board-header">
                      <span className="agent-board-icon">{getRoleIcon(agent.role)}</span>
                      <span
                        className="agent-board-badge"
                        data-state={agent.state}
                      >
                        {agent.state}
                      </span>
                      <span className="agent-board-health" data-health={healthTone} title={health.label}>
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
                            title="Activate"
                          >
                            <Play size={14} />
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleDelete(agent.id, agent.name)}
                            title="Delete"
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
                            title="Pause"
                          >
                            <Pause size={14} />
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title="Stop"
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
                            title="Resume"
                          >
                            <Play size={14} />
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title="Stop"
                          >
                            <Square size={14} />
                          </button>
                        </>
                      )}
                      {agent.state === "running" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title="Pause"
                          >
                            <Pause size={14} />
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title="Stop"
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
                            title="Retry"
                          >
                            <Play size={14} />
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title="Stop"
                          >
                            <Square size={14} />
                          </button>
                        </>
                      )}
                      {agent.state === "terminated" && (
                        <button
                          className="btn btn--sm btn--danger"
                          onClick={() => void handleDelete(agent.id, agent.name)}
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              // List view: detailed card layout
              displayAgents.map(agent => {
                const health = getHealthStatus(agent);
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
                                {role.icon} {role.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span
                            className="agent-icon agent-icon--clickable"
                            onClick={() => setEditingRoleForAgent(agent.id)}
                            title="Click to change role"
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                setEditingRoleForAgent(agent.id);
                              }
                            }}
                          >
                            {getRoleIcon(agent.role)}
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
                        <span className="badge agent-list-health-badge" data-health={healthTone} title={health.label}>
                          {health.icon}{!health.stateDerived && ` ${health.label}`}
                        </span>
                        <span className="badge text-secondary">
                          {getRoleLabel(agent.role)}
                        </span>
                      </div>
                    </div>

                    <div className="agent-card-body">
                      {agent.taskId && (
                        <div className="agent-task">
                          <span className="text-secondary">Working on:</span>
                          <span className="badge">{agent.taskId}</span>
                        </div>
                      )}
                      {agent.lastHeartbeatAt && (
                        <div className="agent-heartbeat">
                          <span className="text-secondary">Last heartbeat:</span>
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
                            title="Activate"
                          >
                            <Play size={14} /> Start
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleDelete(agent.id, agent.name)}
                            title="Delete"
                          >
                            <Trash2 size={14} /> Delete
                          </button>
                        </>
                      )}
                      {agent.state === "active" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title="Pause"
                          >
                            <Pause size={14} /> Pause
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title="Stop"
                          >
                            <Square size={14} /> Stop
                          </button>
                        </>
                      )}
                      {agent.state === "paused" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "active")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title="Resume"
                          >
                            <Play size={14} /> Resume
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title="Stop"
                          >
                            <Square size={14} /> Stop
                          </button>
                        </>
                      )}
                      {agent.state === "running" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "paused")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title="Pause"
                          >
                            <Pause size={14} /> Pause
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title="Stop"
                          >
                            <Square size={14} /> Stop
                          </button>
                        </>
                      )}
                      {agent.state === "error" && (
                        <>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleStateChange(agent.id, "active")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title="Retry"
                          >
                            <Play size={14} /> Retry
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title="Stop"
                          >
                            <Square size={14} /> Stop
                          </button>
                        </>
                      )}
                      {agent.state === "terminated" && (
                        <>
                          <button
                            className="btn btn--sm btn-task-create"
                            onClick={() => void handleStateChange(agent.id, "active")}
                            disabled={transitioningAgentIds.has(agent.id)}
                            title="Start"
                          >
                            <Play size={14} /> Start
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleDelete(agent.id, agent.name)}
                            title="Delete"
                          >
                            <Trash2 size={14} /> Delete
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
