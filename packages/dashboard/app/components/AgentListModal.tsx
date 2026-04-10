import { useState, useEffect, useCallback, useRef } from "react";
import type { JSX } from "react";
import { X, Plus, Play, Pause, Square, Activity, Heart, Trash2, RefreshCw, Bot, LayoutGrid, List, Filter } from "lucide-react";
import type { Agent, AgentCapability, AgentState } from "../api";
import { fetchAgents, createAgent, updateAgent, updateAgentState, deleteAgent } from "../api";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";
import { getAgentHealthStatus } from "../utils/agentHealth";

interface AgentListModalProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: "success" | "error") => void;
  projectId?: string;
}

const AGENT_ROLES: { value: AgentCapability; label: string; icon: string }[] = [
  { value: "triage", label: "Triage", icon: "🔍" },
  { value: "executor", label: "Executor", icon: "⚡" },
  { value: "reviewer", label: "Reviewer", icon: "👁" },
  { value: "merger", label: "Merger", icon: "🔀" },
  { value: "scheduler", label: "Scheduler", icon: "⏰" },
  { value: "engineer", label: "Engineer", icon: "🛠" },
  { value: "custom", label: "Custom", icon: "🔧" },
];

const STATE_COLORS: Record<AgentState, { bg: string; text: string; border: string }> = {
  idle: { bg: "var(--state-idle-bg)", text: "var(--state-idle-text)", border: "var(--state-idle-border)" },
  active: { bg: "var(--state-active-bg)", text: "var(--state-active-text)", border: "var(--state-active-border)" },
  running: { bg: "var(--state-active-bg)", text: "var(--state-active-text)", border: "var(--state-active-border)" },
  paused: { bg: "var(--state-paused-bg)", text: "var(--state-paused-text)", border: "var(--state-paused-border)" },
  terminated: { bg: "var(--state-error-bg)", text: "var(--state-error-text)", border: "var(--state-error-border)" },
  error: { bg: "var(--state-error-bg)", text: "var(--state-error-text)", border: "var(--state-error-border)" },
};

export function AgentListModal({ isOpen, onClose, addToast, projectId }: AgentListModalProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentRole, setNewAgentRole] = useState<AgentCapability>("custom");
  const [filterState, setFilterState] = useState<AgentState | "all">("all");
  const [view, setView] = useState<"board" | "list">(() => {
    if (typeof window === "undefined") return "list";
    const saved = getScopedItem("kb-agent-view", projectId);
    return (saved === "board" || saved === "list") ? saved : "list";
  });

  useEffect(() => {
    const saved = getScopedItem("kb-agent-view", projectId);
    if (saved === "board" || saved === "list") {
      setView(saved);
      return;
    }
    setView("list");
  }, [projectId]);

  // Persist view preference to localStorage
  useEffect(() => {
    setScopedItem("kb-agent-view", view, projectId);
  }, [projectId, view]);

  const [editingRoleForAgent, setEditingRoleForAgent] = useState<string | null>(null);
  const roleSelectRef = useRef<HTMLSelectElement>(null);

  const loadAgents = useCallback(async () => {
    setIsLoading(true);
    try {
      const filter = filterState !== "all" ? { state: filterState } : undefined;
      const data = await fetchAgents(filter, projectId);
      setAgents(data);
    } catch (err: any) {
      addToast(`Failed to load agents: ${err.message}`, "error");
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
    } catch (err: any) {
      addToast(`Failed to create agent: ${err.message}`, "error");
    }
  };

  const handleStateChange = async (agentId: string, newState: AgentState) => {
    try {
      await updateAgentState(agentId, newState, projectId);
      addToast(`Agent state updated to ${newState}`, "success");
      void loadAgents();
    } catch (err: any) {
      addToast(`Failed to update state: ${err.message}`, "error");
    }
  };

  const handleDelete = async (agentId: string, agentName: string) => {
    if (!confirm(`Delete agent "${agentName}"? This cannot be undone.`)) return;
    try {
      await deleteAgent(agentId, projectId);
      addToast(`Agent "${agentName}" deleted`, "success");
      void loadAgents();
    } catch (err: any) {
      addToast(`Failed to delete agent: ${err.message}`, "error");
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
    } catch (err: any) {
      addToast(`Failed to update role: ${err.message}`, "error");
    }
  };

  const handleRoleKeyDown = (e: React.KeyboardEvent, agentId: string) => {
    if (e.key === "Escape") {
      setEditingRoleForAgent(null);
    }
  };

  const getRoleLabel = (role: AgentCapability) => AGENT_ROLES.find(r => r.value === role)?.label ?? role;
  const getRoleIcon = (role: AgentCapability) => AGENT_ROLES.find(r => r.value === role)?.icon ?? "🤖";

  // Use centralized health status utility for consistent labels across all views
  // This fixes the previous hardcoded 60s timeout that was inconsistent with other views
  const getHealthStatus = (agent: Agent): { label: string; icon: JSX.Element; color: string } => {
    return getAgentHealthStatus(agent);
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal--wide">
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
            <button className="btn-icon" onClick={onClose} title="Close">
              <X size={20} />
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
              className="btn btn--primary"
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
              <button className="btn btn--primary" onClick={() => void handleCreate()}>
                Create
              </button>
            </div>
          )}

          {/* Agent List */}
          <div className={view === "board" ? "agent-board" : "agent-list"}>
            {agents.length === 0 ? (
              <div className="agent-empty">
                <Bot size={48} opacity={0.3} />
                <p>No agents found</p>
                <p className="text-secondary">Create an agent to get started</p>
              </div>
            ) : view === "board" ? (
              // Board view: compact grid layout
              agents.map(agent => {
                const health = getHealthStatus(agent);
                const stateStyle = STATE_COLORS[agent.state];
                return (
                  <div key={agent.id} className="agent-board-card" style={{ borderColor: stateStyle.border }}>
                    <div className="agent-board-header">
                      <span className="agent-board-icon">{getRoleIcon(agent.role)}</span>
                      <span
                        className="agent-board-badge"
                        style={{
                          background: stateStyle.bg,
                          color: stateStyle.text,
                          border: `1px solid ${stateStyle.border}`,
                        }}
                      >
                        {agent.state}
                      </span>
                      <span className="agent-board-health" style={{ color: health.color }} title={health.label}>
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
                            title="Pause"
                          >
                            <Pause size={14} />
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
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
                            title="Resume"
                          >
                            <Play size={14} />
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
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
                            title="Pause"
                          >
                            <Pause size={14} />
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
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
                            title="Retry"
                          >
                            <Play size={14} />
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
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
              agents.map(agent => {
                const health = getHealthStatus(agent);
                const stateStyle = STATE_COLORS[agent.state];
                return (
                  <div key={agent.id} className="agent-card" style={{ borderLeftColor: stateStyle.border }}>
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
                          className="badge"
                          style={{
                            background: stateStyle.bg,
                            color: stateStyle.text,
                            border: `1px solid ${stateStyle.border}`,
                          }}
                        >
                          {agent.state}
                        </span>
                        <span className="badge" style={{ color: health.color }}>
                          {health.icon} {health.label}
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
                            title="Pause"
                          >
                            <Pause size={14} /> Pause
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
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
                            title="Resume"
                          >
                            <Play size={14} /> Resume
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
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
                            title="Pause"
                          >
                            <Pause size={14} /> Pause
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
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
                            title="Retry"
                          >
                            <Play size={14} /> Retry
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => void handleStateChange(agent.id, "terminated")}
                            title="Stop"
                          >
                            <Square size={14} /> Stop
                          </button>
                        </>
                      )}
                      {agent.state === "terminated" && (
                        <>
                          <button
                            className="btn btn--sm btn--primary"
                            onClick={() => void handleStateChange(agent.id, "active")}
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

      <style>{`
        :host, .modal--wide {
          /* Scoped alias — maps to the global --text-muted defined in styles.css */
          --text-secondary: var(--text-muted);
        }

        /* === Modal shell === */
        .modal--wide {
          width: 90vw;
          max-width: 900px;
          max-height: 80vh;
        }

        .modal-title {
          display: flex;
          align-items: center;
          gap: var(--space-sm, 8px);
          font-size: 15px;
          font-weight: 600;
          letter-spacing: 0.3px;
          margin: 0;
        }

        /* === Content area === */
        .agent-modal-content {
          padding: var(--space-xl, 24px) 20px;
          overflow-y: auto;
        }

        /* === Controls bar === */
        .agent-controls {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-md, 12px);
          margin-bottom: var(--space-lg, 16px);
        }

        .agent-state-filter {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text-muted);
          transition: border-color var(--transition-fast), color var(--transition-fast);
        }

        .agent-state-filter:hover {
          border-color: var(--text-dim);
          color: var(--text);
        }

        .agent-state-filter:focus-within {
          border-color: var(--todo);
          box-shadow: var(--focus-ring);
        }

        .agent-state-filter-select {
          appearance: none;
          background: transparent;
          border: none;
          color: var(--text);
          font-size: 13px;
          font-family: var(--font-primary);
          cursor: pointer;
          outline: none;
          padding-right: 4px;
        }

        /* === Create form === */
        .agent-create-form {
          display: flex;
          gap: var(--space-md, 12px);
          align-items: center;
          margin-bottom: var(--space-lg, 16px);
          padding: var(--space-lg, 16px);
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: var(--radius-md, 8px);
        }

        .agent-create-form .input {
          flex: 1;
          min-width: 0;
          background: var(--surface);
          color: var(--text);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 6px 10px;
          font-size: 13px;
          font-family: var(--font-primary);
          outline: none;
          transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
        }

        .agent-create-form .input:focus {
          border-color: var(--todo);
          box-shadow: var(--focus-ring);
        }

        .agent-create-form .input::placeholder {
          color: var(--text-dim);
        }

        .agent-create-form .select {
          background: var(--surface);
          color: var(--text);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 6px 10px;
          font-size: 13px;
          font-family: var(--font-primary);
          cursor: pointer;
          outline: none;
          transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
        }

        .agent-create-form .select:focus {
          border-color: var(--todo);
          box-shadow: var(--focus-ring);
        }

        /* === Agent list (default view) === */
        .agent-list {
          display: flex;
          flex-direction: column;
          gap: var(--space-md, 12px);
        }

        /* === Agent board (grid view) === */
        .agent-board {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: var(--space-lg, 16px);
        }

        /* === Board cards === */
        .agent-board-card {
          display: flex;
          flex-direction: column;
          gap: var(--space-sm, 8px);
          padding: var(--space-lg, 16px);
          background: var(--surface, var(--bg-primary));
          border: 1px solid var(--border);
          border-top-width: 3px;
          border-radius: var(--radius-md, 8px);
          transition: background var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);
        }

        .agent-board-card:hover {
          background: var(--card-hover);
          border-color: var(--text-muted);
          box-shadow: var(--shadow-sm);
        }

        .agent-board-card:focus-within {
          box-shadow: var(--focus-ring);
        }

        .agent-board-header {
          display: flex;
          align-items: center;
          gap: var(--space-sm, 8px);
        }

        .agent-board-icon {
          font-size: 20px;
          line-height: 1;
        }

        .agent-board-badge {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          padding: 2px 6px;
          border-radius: var(--radius-sm);
          margin-left: auto;
        }

        .agent-board-health {
          display: flex;
          align-items: center;
        }

        .agent-board-name {
          font-weight: 600;
          font-size: 14px;
          line-height: 1.3;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .agent-board-id {
          font-size: 11px;
          font-family: var(--font-mono);
          color: var(--text-secondary);
          line-height: 1.3;
        }

        .agent-board-actions {
          display: flex;
          gap: 6px;
          margin-top: var(--space-xs, 4px);
          padding-top: var(--space-sm, 8px);
          border-top: 1px solid var(--border);
        }

        .agent-board-actions .btn {
          flex: 1;
          justify-content: center;
        }

        /* === Empty state === */
        .agent-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-sm, 8px);
          padding: 48px 20px;
          color: var(--text-secondary);
          text-align: center;
        }

        .agent-empty p {
          margin: 0;
        }

        /* === List cards === */
        .agent-card {
          border: 1px solid var(--border);
          border-left-width: 4px;
          border-radius: var(--radius-md, 8px);
          padding: var(--space-lg, 16px);
          background: var(--surface, var(--bg-primary));
          transition: background var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);
        }

        .agent-card:hover {
          background: var(--card-hover);
        }

        .agent-card:focus-within {
          box-shadow: var(--focus-ring);
        }

        .agent-card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: var(--space-md, 12px);
          margin-bottom: var(--space-md, 12px);
        }

        .agent-info {
          display: flex;
          align-items: center;
          gap: var(--space-md, 12px);
          min-width: 0;
        }

        .agent-icon {
          font-size: 24px;
          flex-shrink: 0;
        }

        .agent-icon--clickable {
          cursor: pointer;
          transition: opacity 0.2s ease, transform 0.2s ease;
          user-select: none;
        }

        .agent-icon--clickable:hover {
          opacity: 0.7;
          transform: scale(1.1);
        }

        .agent-icon--clickable:focus {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
          border-radius: var(--radius-sm);
        }

        .agent-role-select {
          font-size: 14px;
          padding: 4px 8px;
          min-width: 120px;
          width: auto;
          cursor: pointer;
        }

        .agent-meta {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }

        .agent-name {
          font-weight: 600;
          font-size: 15px;
          line-height: 1.3;
        }

        .agent-id {
          font-size: 12px;
          font-family: var(--font-mono);
          line-height: 1.3;
        }

        .agent-badges {
          display: flex;
          gap: var(--space-sm, 8px);
          flex-wrap: wrap;
          align-items: center;
          flex-shrink: 0;
        }

        .agent-badges .badge {
          white-space: nowrap;
        }

        .agent-card-body {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-bottom: var(--space-md, 12px);
          padding: var(--space-sm, 8px);
          background: var(--bg-secondary);
          border-radius: var(--radius-sm);
          font-size: 13px;
          line-height: 1.4;
        }

        .agent-task,
        .agent-heartbeat {
          display: flex;
          gap: var(--space-sm, 8px);
          align-items: baseline;
        }

        .agent-card-actions {
          display: flex;
          gap: var(--space-sm, 8px);
          flex-wrap: wrap;
        }

        .agent-card-actions .btn {
          transition: transform var(--transition-fast);
        }

        .agent-card-actions .btn:active {
          transform: scale(0.97);
        }

        /* === Utility === */
        .spin {
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .text-secondary {
          color: var(--text-secondary);
        }

        /* === Responsive: tablet (<=768px) === */
        @media (max-width: 768px) {
          .modal--wide {
            width: 100%;
            max-width: 100%;
            max-height: 100vh;
            max-height: 100dvh;
            border-radius: 0;
          }

          .agent-modal-content {
            padding: var(--space-lg, 16px) var(--space-lg, 16px);
            padding-bottom: max(var(--space-lg, 16px), env(safe-area-inset-bottom, 0px));
          }

          .agent-state-filter-select {
            font-size: 16px;
            min-height: 44px;
          }

          .agent-board-actions .btn {
            min-height: 44px;
            min-width: 44px;
          }

          .view-toggle-btn {
            min-height: 44px;
            min-width: 44px;
          }

          /* Header actions wrap safely */
          .modal-header .modal-actions {
            flex-wrap: wrap;
            gap: var(--space-xs, 4px);
          }

          /* Board goes to 2-column max */
          .agent-board {
            grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
            gap: var(--space-md, 12px);
          }

          /* List cards stack badges under info */
          .agent-card-header {
            flex-direction: column;
            gap: var(--space-sm, 8px);
          }

          .agent-badges {
            flex-shrink: initial;
          }

          /* Reduce card body padding on mobile */
          .agent-empty {
            padding: var(--space-xl, 24px) var(--space-lg, 16px);
          }
        }

        /* === Responsive: narrow (<=640px) === */
        @media (max-width: 640px) {
          /* Controls stack vertically */
          .agent-controls {
            flex-direction: column;
            align-items: stretch;
          }

          /* Create form stacks fields */
          .agent-create-form {
            flex-direction: column;
            align-items: stretch;
          }

          .agent-create-form .input,
          .agent-create-form .select {
            width: 100%;
            font-size: 16px;
            min-height: 44px;
          }

          .agent-create-form .btn {
            min-height: 44px;
          }

          /* Board goes to single-column */
          .agent-board {
            grid-template-columns: 1fr;
          }

          /* Card actions wrap without overflow */
          .agent-card-actions {
            flex-wrap: wrap;
          }

          .agent-card-actions .btn {
            flex: 1;
            min-width: 0;
          }
        }
      `}</style>
    </div>
  );
}
