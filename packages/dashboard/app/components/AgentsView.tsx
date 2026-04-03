import { useState, useEffect, useCallback, useRef } from "react";
import type { JSX } from "react";
import { Plus, Play, Pause, Square, Activity, Heart, Trash2, RefreshCw, Bot, LayoutGrid, List, ChevronRight, Filter } from "lucide-react";
import type { Agent, AgentCapability, AgentState } from "../api";
import { fetchAgents, createAgent, updateAgent, updateAgentState, deleteAgent } from "../api";
import { AgentDetailView } from "./AgentDetailView";

export interface AgentsViewProps {
  addToast: (message: string, type?: "success" | "error") => void;
  projectId?: string;
}

const AGENT_ROLES: { value: AgentCapability; label: string; icon: string }[] = [
  { value: "triage", label: "Triage", icon: "🔍" },
  { value: "executor", label: "Executor", icon: "⚡" },
  { value: "reviewer", label: "Reviewer", icon: "👁" },
  { value: "merger", label: "Merger", icon: "🔀" },
  { value: "scheduler", label: "Scheduler", icon: "⏰" },
  { value: "custom", label: "Custom", icon: "🔧" },
];

const STATE_COLORS: Record<AgentState, { bg: string; text: string; border: string }> = {
  idle: { bg: "var(--state-idle-bg)", text: "var(--state-idle-text)", border: "var(--state-idle-border)" },
  active: { bg: "var(--state-active-bg)", text: "var(--state-active-text)", border: "var(--state-active-border)" },
  paused: { bg: "var(--state-paused-bg)", text: "var(--state-paused-text)", border: "var(--state-paused-border)" },
  terminated: { bg: "var(--state-error-bg)", text: "var(--state-error-text)", border: "var(--state-error-border)" },
};

export function AgentsView({ addToast, projectId }: AgentsViewProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentRole, setNewAgentRole] = useState<AgentCapability>("custom");
  const [filterState, setFilterState] = useState<AgentState | "all">("all");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentView, setAgentView] = useState<"board" | "list">(() => {
    if (typeof window === "undefined") return "list";
    const saved = localStorage.getItem("kb-agent-view");
    return (saved === "board" || saved === "list") ? saved : "list";
  });

  // Persist view preference to localStorage
  useEffect(() => {
    localStorage.setItem("kb-agent-view", agentView);
  }, [agentView]);

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
    void loadAgents();
  }, [loadAgents]);

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

  const handleRoleKeyDown = (e: React.KeyboardEvent, _agentId: string) => {
    if (e.key === "Escape") {
      setEditingRoleForAgent(null);
    }
  };

  const getRoleLabel = (role: AgentCapability) => AGENT_ROLES.find(r => r.value === role)?.label ?? role;
  const getRoleIcon = (role: AgentCapability) => AGENT_ROLES.find(r => r.value === role)?.icon ?? "🤖";

  const getHealthStatus = (agent: Agent): { label: string; icon: JSX.Element; color: string } => {
    if (agent.state === "terminated") {
      return { label: "Terminated", icon: <Square size={14} />, color: "var(--state-error-text)" };
    }
    if (agent.state === "paused") {
      return { label: "Paused", icon: <Pause size={14} />, color: "var(--state-paused-text)" };
    }
    if (!agent.lastHeartbeatAt) {
      return { label: agent.state === "active" ? "Starting..." : "Idle", icon: <Bot size={14} />, color: "var(--text-secondary)" };
    }
    const lastHeartbeat = new Date(agent.lastHeartbeatAt).getTime();
    const elapsed = Date.now() - lastHeartbeat;
    const timeoutMs = 60000; // 60 second timeout
    if (elapsed > timeoutMs) {
      return { label: "Unresponsive", icon: <Activity size={14} />, color: "var(--state-error-text)" };
    }
    return { label: "Healthy", icon: <Heart size={14} />, color: "var(--state-active-text)" };
  };

  return (
    <div className="agents-view">
      <div className="agents-view-header">
        <div className="agents-view-title">
          <Bot size={20} />
          <h2>Agents</h2>
        </div>
        <div className="agents-view-controls">
          <div className="view-toggle">
            <button
              className={`view-toggle-btn${agentView === "board" ? " active" : ""}`}
              onClick={() => setAgentView("board")}
              title="Board view"
              aria-label="Board view"
              aria-pressed={agentView === "board"}
            >
              <LayoutGrid size={16} />
            </button>
            <button
              className={`view-toggle-btn${agentView === "list" ? " active" : ""}`}
              onClick={() => setAgentView("list")}
              title="List view"
              aria-label="List view"
              aria-pressed={agentView === "list"}
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
        </div>
      </div>

      <div className="agents-view-content">
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
              <option value="paused">Paused</option>
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
              onKeyDown={(e) => e.key === "Enter" && void handleCreate()}
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
        <div className={agentView === "board" ? "agent-board" : "agent-list"}>
          {agents.length === 0 ? (
            <div className="agent-empty">
              <Bot size={48} opacity={0.3} />
              <p>No agents found</p>
              <p className="text-secondary">Create an agent to get started</p>
            </div>
          ) : agentView === "board" ? (
            // Board view: compact grid layout
            agents.map(agent => {
              const health = getHealthStatus(agent);
              const stateStyle = STATE_COLORS[agent.state];
              return (
                <div key={agent.id} className="agent-board-card" style={{ borderColor: stateStyle.border }}>
                  <div 
                    className="agent-board-clickable"
                    onClick={() => setSelectedAgentId(agent.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && setSelectedAgentId(agent.id)}
                  >
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
                  </div>
                  <div className="agent-board-actions">
                    {agent.state === "idle" && (
                      <button
                        className="btn btn--sm"
                        onClick={() => void handleStateChange(agent.id, "active")}
                        title="Activate"
                      >
                        <Play size={14} />
                      </button>
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
                    <div 
                      className="agent-info agent-info--clickable"
                      onClick={() => setSelectedAgentId(agent.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && setSelectedAgentId(agent.id)}
                    >
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
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingRoleForAgent(agent.id);
                          }}
                          title="Click to change role"
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.stopPropagation();
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
                      <ChevronRight size={20} className="agent-card-chevron" />
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
                      <button
                        className="btn btn--sm"
                        onClick={() => void handleStateChange(agent.id, "active")}
                        title="Activate"
                      >
                        <Play size={14} /> Start
                      </button>
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
                    {agent.state === "terminated" && (
                      <button
                        className="btn btn--sm btn--danger"
                        onClick={() => void handleDelete(agent.id, agent.name)}
                        title="Delete"
                      >
                        <Trash2 size={14} /> Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Agent Detail Modal */}
      {selectedAgentId && (
        <AgentDetailView
          agentId={selectedAgentId}
          projectId={projectId}
          onClose={() => setSelectedAgentId(null)}
          addToast={addToast}
        />
      )}

      <style>{`
        .agents-view {
          display: flex;
          flex-direction: column;
          height: calc(100% - var(--executor-footer-height, 0px));
          overflow: hidden;

          /* Agent state CSS variables - define fallback values */
          --state-idle-bg: rgba(139, 148, 158, 0.15);
          --state-idle-text: #8b949e;
          --state-idle-border: #8b949e;
          --state-active-bg: rgba(46, 160, 67, 0.15);
          --state-active-text: #3fb950;
          --state-active-border: #3fb950;
          --state-paused-bg: rgba(227, 179, 65, 0.15);
          --state-paused-text: #e3b541;
          --state-paused-border: #e3b541;
          --state-error-bg: rgba(248, 81, 73, 0.15);
          --state-error-text: #f85149;
          --state-error-border: #f85149;
          --text-secondary: var(--text-muted, #8b949e);
        }

        .agents-view-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-primary);
        }

        .agents-view-title {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .agents-view-title h2 {
          font-size: 18px;
          font-weight: 600;
          margin: 0;
        }

        .agents-view-controls {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .agents-view-content {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
        }

        .agent-controls {
          display: flex;
          gap: 12px;
          margin-bottom: 16px;
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

        .agent-create-form {
          display: flex;
          gap: 12px;
          margin-bottom: 16px;
          padding: 16px;
          background: var(--bg-secondary);
          border-radius: 8px;
        }

        .agent-create-form .input {
          flex: 1;
        }

        .agent-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .agent-board {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 16px;
        }

        .agent-board-card {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 12px;
          background: var(--bg-primary);
          border: 1px solid var(--border);
          border-top-width: 3px;
          border-radius: 8px;
          transition: background var(--transition-fast), border-color var(--transition-fast);
        }

        .agent-board-card:hover {
          background: var(--card-hover);
          border-color: var(--text-muted);
        }

        .agent-board-header {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .agent-board-icon {
          font-size: 20px;
          line-height: 1;
        }

        .agent-board-badge {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          padding: 2px 6px;
          border-radius: 4px;
          margin-left: auto;
        }

        .agent-board-health {
          display: flex;
          align-items: center;
        }

        .agent-board-name {
          font-weight: 600;
          font-size: 14px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .agent-board-id {
          font-size: 11px;
          font-family: var(--font-mono);
          color: var(--text-secondary);
        }

        .agent-board-clickable {
          cursor: pointer;
        }

        .agent-board-clickable:hover .agent-board-name {
          color: var(--accent);
        }

        .agent-board-actions {
          display: flex;
          gap: 6px;
          margin-top: 4px;
          padding-top: 8px;
          border-top: 1px solid var(--border);
        }

        .agent-board-actions .btn {
          flex: 1;
          justify-content: center;
        }

        .agent-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 48px;
          color: var(--text-secondary);
        }

        .agent-card {
          border: 1px solid var(--border);
          border-left-width: 4px;
          border-radius: 8px;
          padding: 16px;
          background: var(--bg-primary);
        }

        .agent-card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 12px;
        }

        .agent-info {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .agent-icon {
          font-size: 24px;
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
          outline: 2px solid var(--accent, #58a6ff);
          outline-offset: 2px;
          border-radius: 4px;
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
        }

        .agent-info--clickable {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 12px;
          cursor: pointer;
          padding: 4px;
          margin: -4px;
          border-radius: 4px;
          transition: background 0.15s ease;
        }

        .agent-info--clickable:hover {
          background: var(--bg-hover);
        }

        .agent-info--clickable:hover .agent-name {
          color: var(--accent);
        }

        .agent-card-chevron {
          color: var(--text-muted);
          margin-left: auto;
          opacity: 0;
          transition: opacity 0.15s ease;
        }

        .agent-info--clickable:hover .agent-card-chevron {
          opacity: 1;
        }

        .agent-name {
          font-weight: 600;
          font-size: 16px;
        }

        .agent-id {
          font-size: 12px;
          font-family: var(--font-mono);
        }

        .agent-badges {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }

        .agent-card-body {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-bottom: 12px;
          padding: 8px;
          background: var(--bg-secondary);
          border-radius: 4px;
          font-size: 13px;
        }

        .agent-task,
        .agent-heartbeat {
          display: flex;
          gap: 8px;
        }

        .agent-card-actions {
          display: flex;
          gap: 8px;
        }

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
      `}</style>
    </div>
  );
}
