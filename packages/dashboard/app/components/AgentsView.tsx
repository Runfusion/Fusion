import { useState, useEffect, useCallback, useRef } from "react";
import type { JSX } from "react";
import { Plus, Play, Pause, Square, Activity, Heart, Trash2, RefreshCw, Bot, LayoutGrid, List, ChevronRight, ChevronDown, GitBranch, Filter, Upload } from "lucide-react";
import type { Agent, AgentCapability, AgentState } from "../api";
import { fetchAgents, updateAgent, updateAgentState, deleteAgent, startAgentRun } from "../api";
import { AgentDetailView } from "./AgentDetailView";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";
import { AgentMetricsBar } from "./AgentMetricsBar";
import { useAgents } from "../hooks/useAgents";
import { useAgentHierarchy } from "../hooks/useAgentHierarchy";
import type { AgentNode } from "../hooks/useAgentHierarchy";
import { NewAgentDialog } from "./NewAgentDialog";
import { AgentImportModal } from "./AgentImportModal";

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
  { value: "engineer", label: "Engineer", icon: "🛠" },
  { value: "custom", label: "Custom", icon: "🔧" },
];

const STATE_COLORS: Record<AgentState, { bg: string; text: string; border: string }> = {
  idle: { bg: "var(--state-idle-bg)", text: "var(--state-idle-text)", border: "var(--state-idle-border)" },
  active: { bg: "var(--state-active-bg)", text: "var(--state-active-text)", border: "var(--state-active-border)" },
  running: { bg: "var(--state-active-bg)", text: "var(--state-active-text)", border: "var(--state-active-border)" },
  paused: { bg: "var(--state-paused-bg)", text: "var(--state-paused-text)", border: "var(--state-paused-border)" },
  error: { bg: "var(--state-error-bg)", text: "var(--state-error-text)", border: "var(--state-error-border)" },
  terminated: { bg: "var(--state-error-bg)", text: "var(--state-error-text)", border: "var(--state-error-border)" },
};

/** Recursive tree node component for agent hierarchy */
function AgentTreeNode({
  node,
  onSelect,
  onToggle,
  isExpanded,
  getChildCount,
  getHealthStatus,
  getRoleIcon,
}: {
  node: AgentNode;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  isExpanded: (id: string) => boolean;
  getChildCount: (id: string) => number;
  getHealthStatus: (agent: Agent) => { label: string; icon: JSX.Element; color: string };
  getRoleIcon: (role: AgentCapability) => string;
}) {
  const { agent, children, depth } = node;
  const childCount = getChildCount(agent.id);
  const expanded = isExpanded(agent.id);
  const health = getHealthStatus(agent);
  const stateStyle = STATE_COLORS[agent.state];

  return (
    <>
      <div
        className={`agent-tree__node${agent.reportsTo ? " agent-is-child" : ""} agent-tree__indent--${Math.min(depth, 4)}`}
      >
        <button
          className={`agent-tree__toggle${childCount === 0 ? " agent-tree__toggle--leaf" : ""}`}
          onClick={() => childCount > 0 && onToggle(agent.id)}
          title={childCount > 0 ? (expanded ? "Collapse" : "Expand") : "No children"}
          aria-label={childCount > 0 ? (expanded ? "Collapse" : "Expand") : "No children"}
        >
          {childCount > 0 ? (
            expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />
          ) : (
            <Bot size={14} />
          )}
        </button>
        <div
          className="agent-tree__content"
          onClick={() => onSelect(agent.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && onSelect(agent.id)}
        >
          <span className="agent-tree__icon">{getRoleIcon(agent.role)}</span>
          <span className="agent-tree__name">{agent.name}</span>
          <span
            className="agent-tree__badge"
            style={{
              background: stateStyle.bg,
              color: stateStyle.text,
              border: `1px solid ${stateStyle.border}`,
            }}
          >
            {agent.state}
          </span>
          <span className="agent-tree__health" style={{ color: health.color }} title={health.label}>
            {health.icon}
          </span>
          {childCount > 0 && (
            <span className="agent-tree__count text-secondary">({childCount})</span>
          )}
        </div>
      </div>
      {expanded && children.length > 0 && (
        <div className="agent-tree__children">
          {children.map((child) => (
            <AgentTreeNode
              key={child.agent.id}
              node={child}
              onSelect={onSelect}
              onToggle={onToggle}
              isExpanded={isExpanded}
              getChildCount={getChildCount}
              getHealthStatus={getHealthStatus}
              getRoleIcon={getRoleIcon}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function AgentsView({ addToast, projectId }: AgentsViewProps) {
  const { activeAgents, stats } = useAgents(projectId);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [filterState, setFilterState] = useState<AgentState | "all">("all");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentView, setAgentView] = useState<"board" | "list" | "tree">(() => {
    if (typeof window === "undefined") return "list";
    const saved = localStorage.getItem("kb-agent-view");
    return (saved === "board" || saved === "list" || saved === "tree") ? saved : "list";
  });

  // Persist view preference to localStorage
  useEffect(() => {
    localStorage.setItem("kb-agent-view", agentView);
  }, [agentView]);

  const [editingRoleForAgent, setEditingRoleForAgent] = useState<string | null>(null);
  const roleSelectRef = useRef<HTMLSelectElement>(null);

  const hierarchy = useAgentHierarchy(agents);

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

  const handleStateChange = async (agentId: string, newState: AgentState) => {
    try {
      await updateAgentState(agentId, newState, projectId);
      addToast(`Agent state updated to ${newState}`, "success");

      // When activating an agent, also start a heartbeat run so it shows activity
      if (newState === "active") {
        try {
          await startAgentRun(agentId, projectId);
        } catch (runErr: any) {
          addToast(`Agent activated, but failed to start run: ${runErr.message}`, "error");
        }
      }

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

  const handleRunHeartbeat = async (agentId: string, agentName: string) => {
    try {
      await startAgentRun(agentId, projectId, { source: "on_demand", triggerDetail: "Triggered from dashboard" });
      addToast(`Heartbeat run started for ${agentName}`, "success");
      void loadAgents();
    } catch (err: any) {
      addToast(`Failed to start heartbeat run: ${err.message}`, "error");
    }
  };

  const getRoleLabel = (role: AgentCapability) => AGENT_ROLES.find(r => r.value === role)?.label ?? role;
  const getRoleIcon = (role: AgentCapability) => AGENT_ROLES.find(r => r.value === role)?.icon ?? "🤖";

  const getHealthStatus = (agent: Agent): { label: string; icon: JSX.Element; color: string } => {
    if (agent.state === "terminated") {
      return { label: "Terminated", icon: <Square size={14} />, color: "var(--state-error-text)" };
    }
    if (agent.state === "error") {
      return { label: agent.lastError ?? "Error", icon: <Activity size={14} />, color: "var(--state-error-text)" };
    }
    if (agent.state === "paused") {
      return { label: agent.pauseReason ? `Paused: ${agent.pauseReason}` : "Paused", icon: <Pause size={14} />, color: "var(--state-paused-text)" };
    }
    if (agent.state === "running") {
      return { label: "Running", icon: <Activity size={14} />, color: "var(--state-active-text)" };
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
            <button
              className={`view-toggle-btn${agentView === "tree" ? " active" : ""}`}
              onClick={() => setAgentView("tree")}
              title="Tree view"
              aria-label="Tree view"
              aria-pressed={agentView === "tree"}
            >
              <GitBranch size={16} />
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
              <option value="running">Running</option>
              <option value="paused">Paused</option>
              <option value="error">Error</option>
              <option value="terminated">Terminated</option>
            </select>
          </div>

          <div className="agent-controls-actions">
            <button
              className="btn"
              onClick={() => setIsImporting(true)}
            >
              <Upload size={16} />
              Import
            </button>
            <button
              className="btn btn--primary"
              onClick={() => setIsCreating(true)}
            >
              <Plus size={16} />
              New Agent
            </button>
          </div>
        </div>

        <NewAgentDialog
          isOpen={isCreating}
          onClose={() => setIsCreating(false)}
          onCreated={() => { setIsCreating(false); void loadAgents(); }}
          projectId={projectId}
        />

        <AgentImportModal
          isOpen={isImporting}
          onClose={() => setIsImporting(false)}
          onImported={() => void loadAgents()}
          projectId={projectId}
        />

        {/* Metrics Bar */}
        <AgentMetricsBar stats={stats} />

        {/* Active Agents Panel - Live streaming cards */}
        <ActiveAgentsPanel agents={activeAgents} />

        {/* Agent List */}
        {agentView === "tree" ? (
          <div className="agent-tree__view">
            {agents.length === 0 ? (
              <div className="agent-empty">
                <Bot size={48} opacity={0.3} />
                <p>No agents found</p>
                <p className="text-secondary">Create an agent to get started</p>
              </div>
            ) : (
              hierarchy.rootNodes.map((node) => (
                <AgentTreeNode
                  key={node.agent.id}
                  node={node}
                  onSelect={setSelectedAgentId}
                  onToggle={hierarchy.toggleExpand}
                  isExpanded={hierarchy.isExpanded}
                  getChildCount={(id) => hierarchy.getChildren(id).length}
                  getHealthStatus={getHealthStatus}
                  getRoleIcon={getRoleIcon}
                />
              ))
            )}
          </div>
        ) : (
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
                        {agent.taskId && (
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleRunHeartbeat(agent.id, agent.name)}
                            title="Run Heartbeat"
                            aria-label={`Run heartbeat for ${agent.name}`}
                          >
                            <Activity size={14} />
                          </button>
                        )}
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
                        {agent.taskId && (
                          <button
                            className="btn btn--sm"
                            disabled
                            title="Run in progress"
                            aria-label={`Heartbeat run in progress for ${agent.name}`}
                          >
                            <Activity size={14} />
                          </button>
                        )}
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
                        {agent.taskId && (
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleRunHeartbeat(agent.id, agent.name)}
                            title="Run Heartbeat"
                            aria-label={`Run heartbeat for ${agent.name}`}
                          >
                            <Activity size={14} /> Run
                          </button>
                        )}
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
                        {agent.taskId && (
                          <button
                            className="btn btn--sm"
                            disabled
                            title="Run in progress"
                            aria-label={`Heartbeat run in progress for ${agent.name}`}
                          >
                            <Activity size={14} /> Running
                          </button>
                        )}
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
        )}
      </div>

      {/* Agent Detail Modal */}
      {selectedAgentId && (
        <AgentDetailView
          agentId={selectedAgentId}
          projectId={projectId}
          onClose={() => setSelectedAgentId(null)}
          addToast={addToast}
          onChildClick={(childId) => setSelectedAgentId(childId)}
        />
      )}


    </div>
  );
}
