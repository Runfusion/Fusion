import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Plus, Play, Pause, Activity, Trash2, RefreshCw, Bot, List, ChevronRight, ChevronDown, GitBranch, Filter, Upload, Network } from "lucide-react";
import type { Agent, AgentCapability, AgentState, OrgTreeNode } from "../api";
import { fetchAgents, updateAgent, updateAgentState, deleteAgent, startAgentRun, fetchOrgTree, fetchSettings, updateSettings } from "../api";
import { AgentDetailView } from "./AgentDetailView";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";
import { AgentMetricsBar } from "./AgentMetricsBar";
import { AgentEmptyState } from "./AgentEmptyState";
import { useAgents } from "../hooks/useAgents";
import { subscribeSse } from "../sse-bus";
import { useAgentHierarchy } from "../hooks/useAgentHierarchy";
import type { AgentNode } from "../hooks/useAgentHierarchy";
import { NewAgentDialog } from "./NewAgentDialog";
import { AgentImportModal } from "./AgentImportModal";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";
import { getAgentHealthStatus } from "../utils/agentHealth";
import type { AgentHealthStatus } from "../utils/agentHealth";
import {
  formatHeartbeatInterval,
  getHeartbeatIntervalOptions,
  resolveHeartbeatIntervalMs,
  MIN_HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_INTERVAL_PRESETS,
} from "../utils/heartbeatIntervals";
import { isEphemeralAgent } from "@fusion/core";

export interface AgentsViewProps {
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

const HEARTBEAT_MULTIPLIER_PRESETS = [0.1, 0.25, 0.5, 1, 2, 3, 5, 10] as const;


function getStateBadgeClass(state: AgentState): string {
  switch (state) {
    case "running":
      return "agent-badge--running";
    case "active":
      return "agent-badge--active";
    case "paused":
      return "agent-badge--paused";
    case "error":
      return "agent-badge--error";
    case "terminated":
      return "agent-badge--terminated";
    case "idle":
    default:
      return "agent-badge--idle";
  }
}

function getStateCardClass(prefix: "agent-card" | "agent-board-card", state: AgentState): string {
  switch (state) {
    case "running":
      return `${prefix}--running`;
    case "active":
      return `${prefix}--active`;
    case "paused":
      return `${prefix}--paused`;
    case "error":
      return `${prefix}--error`;
    case "terminated":
      return `${prefix}--terminated`;
    case "idle":
    default:
      return `${prefix}--idle`;
  }
}

/** Recursive tree node component for agent hierarchy */
function AgentTreeNode({
  node,
  onSelect,
  onToggle,
  isExpanded,
  getChildCount,
  getHealthStatus,
  getRoleIcon,
  getSkillBadges,
}: {
  node: AgentNode;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  isExpanded: (id: string) => boolean;
  getChildCount: (id: string) => number;
  getHealthStatus: (agent: Agent) => AgentHealthStatus;
  getRoleIcon: (role: AgentCapability) => string;
  getSkillBadges: (agent: Agent) => string[];
}) {
  const { agent, children, depth } = node;
  const childCount = getChildCount(agent.id);
  const expanded = isExpanded(agent.id);
  const health = getHealthStatus(agent);
  const stateBadgeClass = getStateBadgeClass(agent.state);

  return (
    <>
      <div
        className={`agent-tree__node${agent.reportsTo ? " agent-is-child" : ""} agent-tree__indent--${Math.min(depth, 4)}`}
      >
        <button
          className={`agent-tree__toggle${childCount === 0 ? " agent-tree__toggle--leaf" : ""}`}
          onClick={() => childCount > 0 && onToggle(agent.id)}
          title={childCount > 0 ? (expanded ? "Collapse" : "Expand") : "No employees"}
          aria-label={childCount > 0 ? (expanded ? "Collapse" : "Expand") : "No employees"}
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
            className={`agent-tree__badge ${stateBadgeClass}`}
          >
            {agent.state}
          </span>
          <span className="agent-tree__health" style={{ color: health.color }} title={health.label}>
            {health.icon}
          </span>
          {childCount > 0 && (
            <span className="agent-tree__count text-secondary">({childCount})</span>
          )}
          {/* Tree view: up to 1 skill badge */}
          {(() => {
            const skills = getSkillBadges(agent);
            if (skills.length === 0) return null;
            return (
              <span className="agent-tree__skill" title={skills.join(", ")}>
                {skills[0]}{skills.length > 1 && ` +${skills.length - 1}`}
              </span>
            );
          })()}
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
              getSkillBadges={getSkillBadges}
            />
          ))}
        </div>
      )}
    </>
  );
}

function OrgChartNode({
  node,
  onSelect,
  getHealthStatus,
  getRoleIcon,
  getSkillBadges,
}: {
  node: OrgTreeNode;
  onSelect: (id: string) => void;
  getHealthStatus: (agent: Agent) => AgentHealthStatus;
  getRoleIcon: (role: AgentCapability) => string;
  getSkillBadges: (agent: Agent) => string[];
}) {
  const { agent, children } = node;
  const health = getHealthStatus(agent);
  const stateBadgeClass = getStateBadgeClass(agent.state);

  return (
    <div className={`org-chart-node${children.length > 0 ? " org-chart-node--has-children" : ""}`}>
      <div
        className="org-chart-node-card"
        onClick={() => onSelect(agent.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onSelect(agent.id)}
      >
        <div className="org-chart-node__header">
          <span className="org-chart-node__icon">{getRoleIcon(agent.role)}</span>
          <span className="org-chart-node__name">{agent.name}</span>
        </div>
        <div className="org-chart-node__meta">
          <span
            className={`org-chart-node__badge ${stateBadgeClass}`}
          >
            {agent.state}
          </span>
          <span className="org-chart-node__health" style={{ color: health.color }} title={health.label}>
            {health.icon}
            {!health.stateDerived && <span className="text-secondary">{health.label}</span>}
          </span>
          {/* Org chart: up to 2 skill badges */}
          {(() => {
            const skills = getSkillBadges(agent);
            if (skills.length === 0) return null;
            const displaySkills = skills.slice(0, 2);
            const extraCount = skills.length - 2;
            return (
              <>
                {displaySkills.map((skillId) => (
                  <span key={skillId} className="org-chart-node__skill">{skillId}</span>
                ))}
                {extraCount > 0 && <span className="org-chart-node__skill">+{extraCount}</span>}
              </>
            );
          })()}
        </div>
      </div>
      {children.length > 0 && (
        <div className="org-chart-children" role="group" aria-label={`${agent.name} employees`}>
          {children.map((child) => (
            <OrgChartNode
              key={child.agent.id}
              node={child}
              onSelect={onSelect}
              getHealthStatus={getHealthStatus}
              getRoleIcon={getRoleIcon}
              getSkillBadges={getSkillBadges}
            />
          ))}
        </div>
      )}
    </div>
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
  const [agentView, setAgentView] = useState<"list" | "board" | "tree" | "org">(() => {
    if (typeof window === "undefined") return "list";
    const saved = getScopedItem("fn-agent-view", projectId);
    return (saved === "list" || saved === "board" || saved === "tree" || saved === "org") ? saved : "list";
  });
  const [orgTree, setOrgTree] = useState<OrgTreeNode[]>([]);
  const [isOrgTreeLoading, setIsOrgTreeLoading] = useState(false);

  useEffect(() => {
    const saved = getScopedItem("fn-agent-view", projectId);
    if (saved === "list" || saved === "board" || saved === "tree" || saved === "org") {
      setAgentView(saved);
      return;
    }
    setAgentView("list");
  }, [projectId]);

  // Persist view preference to localStorage
  useEffect(() => {
    setScopedItem("fn-agent-view", agentView, projectId);
  }, [agentView, projectId]);

  const [editingRoleForAgent, setEditingRoleForAgent] = useState<string | null>(null);
  const roleSelectRef = useRef<HTMLSelectElement>(null);
  const [showSystemAgents, setShowSystemAgents] = useState(false);
  const [updatingHeartbeatAgentId, setUpdatingHeartbeatAgentId] = useState<string | null>(null);
  /** Agent ID currently showing custom heartbeat input */
  const [customHeartbeatAgentId, setCustomHeartbeatAgentId] = useState<string | null>(null);
  /** Custom minutes input value for each agent */
  const [customHeartbeatMinutes, setCustomHeartbeatMinutes] = useState<Record<string, string>>({});
  /** Global heartbeat multiplier loaded from project settings */
  const [heartbeatMultiplier, setHeartbeatMultiplier] = useState<number>(1);
  /** Whether the heartbeat multiplier is currently being saved */
  const [isSavingMultiplier, setIsSavingMultiplier] = useState(false);

  // Load heartbeat multiplier from project settings on mount
  useEffect(() => {
    fetchSettings(projectId)
      .then((settings) => {
        setHeartbeatMultiplier(settings.heartbeatMultiplier ?? 1);
      })
      .catch(() => {
        // Use default on error
      });
  }, [projectId]);

  /** Handle saving heartbeat multiplier to project settings */
  const handleHeartbeatMultiplierChange = useCallback(async (multiplier: number) => {
    const clampedValue = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
    setHeartbeatMultiplier(clampedValue);
    setIsSavingMultiplier(true);
    try {
      await updateSettings({ heartbeatMultiplier: clampedValue }, projectId);
      addToast(`Heartbeat speed set to ×${clampedValue.toFixed(1)}`, "success");
    } catch (err: any) {
      addToast(`Failed to save heartbeat multiplier: ${err.message}`, "error");
    } finally {
      setIsSavingMultiplier(false);
    }
  }, [projectId, addToast]);

  const hierarchy = useAgentHierarchy(agents, projectId);

  // Filter agents for display. "All States" means all non-ephemeral agents,
  // including disabled/terminated agents that still carry configuration.
  // When "Show system agents" is enabled, include ephemeral/internal agents.
  const displayAgents = useMemo(() => {
    return agents.filter((agent) => showSystemAgents || !isEphemeralAgent(agent));
  }, [agents, showSystemAgents]);

  // Filter org tree to exclude ephemeral agents in default view.
  const displayOrgTree = useMemo(() => {
    if (showSystemAgents) {
      return orgTree;
    }

    // Recursively filter out ephemeral agents from the org tree.
    const filterNode = (node: OrgTreeNode): OrgTreeNode | null => {
      if (isEphemeralAgent(node.agent)) return null;
      return {
        ...node,
        children: node.children
          .map(filterNode)
          .filter((n): n is OrgTreeNode => n !== null),
      };
    };
    return orgTree
      .map(filterNode)
      .filter((n): n is OrgTreeNode => n !== null);
  }, [orgTree, showSystemAgents]);

  const loadAgents = useCallback(async () => {
    setIsLoading(true);
    try {
      const filter = filterState !== "all" ? { state: filterState } : undefined;
      const data = await fetchAgents({ ...filter, includeEphemeral: showSystemAgents }, projectId);
      setAgents(data);
    } catch (err: any) {
      addToast(`Failed to load agents: ${err.message}`, "error");
    } finally {
      setIsLoading(false);
    }
  }, [filterState, showSystemAgents, addToast, projectId]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    if (agentView !== "org") return;

    let cancelled = false;
    setIsOrgTreeLoading(true);
    fetchOrgTree(projectId, { includeEphemeral: showSystemAgents })
      .then((data) => {
        if (!cancelled) {
          setOrgTree(data);
        }
      })
      .catch((err: any) => {
        if (!cancelled) {
          addToast(`Failed to load org chart: ${err.message}`, "error");
          setOrgTree([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsOrgTreeLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agentView, projectId, showSystemAgents, addToast]);

  // Refresh agent list on SSE events (independent from useAgents hook state)
  useEffect(() => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const refresh = () => {
      void loadAgents();
    };

    return subscribeSse(`/api/events${query}`, {
      events: {
        "agent:created": refresh,
        "agent:updated": refresh,
        "agent:deleted": refresh,
        "agent:stateChanged": refresh,
      },
    });
  }, [projectId, loadAgents]);

  // Poll for agent updates to keep health statuses fresh (every 30 seconds)
  // This ensures health badges stay current while the view is open
  useEffect(() => {
    const pollInterval = setInterval(() => {
      void loadAgents();
    }, 30_000);

    return () => {
      clearInterval(pollInterval);
    };
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

  const handleHeartbeatIntervalChange = async (agent: Agent, newIntervalMs: number) => {
    // Clear custom input state when selecting a preset
    if (customHeartbeatAgentId === agent.id) {
      setCustomHeartbeatAgentId(null);
      setCustomHeartbeatMinutes((prev) => {
        const next = { ...prev };
        delete next[agent.id];
        return next;
      });
    }

    setUpdatingHeartbeatAgentId(agent.id);
    try {
      await updateAgent(
        agent.id,
        {
          runtimeConfig: {
            ...(agent.runtimeConfig ?? {}),
            heartbeatIntervalMs: newIntervalMs,
          },
        },
        projectId,
      );
      addToast(`Heartbeat interval updated to ${formatHeartbeatInterval(newIntervalMs)} for ${agent.name}`, "success");
      void loadAgents();
    } catch (err: any) {
      addToast(`Failed to update heartbeat interval: ${err.message}`, "error");
    } finally {
      setUpdatingHeartbeatAgentId(null);
    }
  };

  /**
   * Handle saving custom heartbeat interval from typed minutes input.
   * Validation behavior:
   * - Empty value: do not save; show validation toast
   * - Non-numeric value: do not save; show validation toast
   * - Value <= 0: do not save; show validation toast
   * - Value 1-4: save as 5 minutes (300000 ms) and show clamp-info toast
   * - Value >= 5: save exact minute value converted to ms
   */
  const handleCustomHeartbeatSave = async (agent: Agent) => {
    const inputValue = customHeartbeatMinutes[agent.id] ?? "";

    // Validate: empty value
    if (inputValue.trim() === "") {
      addToast("Please enter a heartbeat interval in minutes", "error");
      return;
    }

    // Validate: non-numeric value
    const minutes = Number(inputValue);
    if (isNaN(minutes)) {
      addToast("Heartbeat interval must be a valid number", "error");
      return;
    }

    // Validate: zero or negative
    if (minutes <= 0) {
      addToast("Heartbeat interval must be greater than 0", "error");
      return;
    }

    // Handle values 1-4: clamp to 5 minutes
    if (minutes >= 1 && minutes < 5) {
      setUpdatingHeartbeatAgentId(agent.id);
      try {
        await updateAgent(
          agent.id,
          {
            runtimeConfig: {
              ...(agent.runtimeConfig ?? {}),
              heartbeatIntervalMs: MIN_HEARTBEAT_INTERVAL_MS,
            },
          },
          projectId,
        );
        addToast(`Heartbeat interval set to 5 minutes (minimum). ${minutes} minute${minutes !== 1 ? "s" : ""} was below the 5-minute minimum.`, "success");
        setCustomHeartbeatAgentId(null);
        setCustomHeartbeatMinutes((prev) => {
          const next = { ...prev };
          delete next[agent.id];
          return next;
        });
        void loadAgents();
      } catch (err: any) {
        addToast(`Failed to update heartbeat interval: ${err.message}`, "error");
      } finally {
        setUpdatingHeartbeatAgentId(null);
      }
      return;
    }

    // Handle values >= 5: save exact minute value
    const intervalMs = Math.round(minutes * 60_000);
    setUpdatingHeartbeatAgentId(agent.id);
    try {
      await updateAgent(
        agent.id,
        {
          runtimeConfig: {
            ...(agent.runtimeConfig ?? {}),
            heartbeatIntervalMs: intervalMs,
          },
        },
        projectId,
      );
      addToast(`Heartbeat interval updated to ${formatHeartbeatInterval(intervalMs)} for ${agent.name}`, "success");
      setCustomHeartbeatAgentId(null);
      setCustomHeartbeatMinutes((prev) => {
        const next = { ...prev };
        delete next[agent.id];
        return next;
      });
      void loadAgents();
    } catch (err: any) {
      addToast(`Failed to update heartbeat interval: ${err.message}`, "error");
    } finally {
      setUpdatingHeartbeatAgentId(null);
    }
  };

  /** Handle selecting custom option from dropdown */
  const handleSelectCustomHeartbeat = (agent: Agent) => {
    const configuredIntervalMs = resolveHeartbeatIntervalMs(agent.runtimeConfig?.heartbeatIntervalMs);
    // Convert ms to minutes for the input field
    const currentMinutes = Math.round(configuredIntervalMs / 60_000);
    setCustomHeartbeatAgentId(agent.id);
    setCustomHeartbeatMinutes((prev) => ({
      ...prev,
      [agent.id]: String(currentMinutes),
    }));
  };

  const handleCloseDetail = useCallback(() => {
    setSelectedAgentId(null);
  }, []);

  const handleChildClick = useCallback((childId: string) => {
    setSelectedAgentId(childId);
  }, []);

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
  const getRoleIcon = (role: AgentCapability) => AGENT_ROLES.find(r => r.value === role)?.icon ?? "◆";

  /** Get skill badges from agent metadata */
  const getSkillBadges = (agent: Agent): string[] => {
    if (Array.isArray(agent.metadata?.skills)) {
      return agent.metadata.skills as string[];
    }
    return [];
  };

  // Use centralized health status utility for consistent labels across all views
  const getHealthStatus = (agent: Agent): AgentHealthStatus => {
    return getAgentHealthStatus(agent);
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
              className={`view-toggle-btn${agentView === "list" ? " active" : ""}`}
              onClick={() => setAgentView("list")}
              title="List view"
              aria-label="List view"
              aria-pressed={agentView === "list"}
            >
              <List size={16} />
            </button>
            <button
              className={`view-toggle-btn${agentView === "board" ? " active" : ""}`}
              onClick={() => setAgentView("board")}
              title="Board view"
              aria-label="Board view"
              aria-pressed={agentView === "board"}
            >
              <Activity size={16} />
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
            <button
              className={`view-toggle-btn${agentView === "org" ? " active" : ""}`}
              onClick={() => setAgentView("org")}
              title="Org Chart view"
              aria-label="Org Chart view"
              aria-pressed={agentView === "org"}
            >
              <Network size={16} />
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
          <div className="agent-controls-filters">
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

            <label className="checkbox-label agent-system-filter">
            <input
              type="checkbox"
              checked={showSystemAgents}
              onChange={(e) => setShowSystemAgents(e.target.checked)}
              aria-label="Show system agents"
            />
            Show system agents
            </label>
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

        {/* Global Heartbeat Speed Control */}
        <div className="agent-global-controls">
          <div className="heartbeat-multiplier-group">
            <div className="heartbeat-multiplier-controls">
              <label htmlFor="globalHeartbeatMultiplier" className="heartbeat-multiplier-label">
                Heartbeat Speed
              </label>
              <input
                id="globalHeartbeatMultiplier"
                className="heartbeat-multiplier-slider touch-target"
                type="range"
                min={0.1}
                max={10}
                step={0.1}
                value={heartbeatMultiplier}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  void handleHeartbeatMultiplierChange(Number.isFinite(val) && val > 0 ? val : 1);
                }}
                disabled={isSavingMultiplier}
              />
              <span className="heartbeat-multiplier-value">×{heartbeatMultiplier.toFixed(1)}</span>
              <select
                className="heartbeat-multiplier-preset"
                value={String(
                  HEARTBEAT_MULTIPLIER_PRESETS.reduce((closest, candidate) => {
                    return Math.abs(candidate - heartbeatMultiplier) < Math.abs(closest - heartbeatMultiplier) ? candidate : closest;
                  }, HEARTBEAT_MULTIPLIER_PRESETS[0])
                )}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  void handleHeartbeatMultiplierChange(Number.isFinite(val) && val > 0 ? val : 1);
                }}
                disabled={isSavingMultiplier}
                aria-label="Heartbeat speed preset"
              >
                {HEARTBEAT_MULTIPLIER_PRESETS.map((multiplier) => (
                  <option key={multiplier} value={String(multiplier)}>
                    ×{multiplier}
                  </option>
                ))}
              </select>
            </div>
            <small className="text-secondary">
              Scales all agent heartbeat intervals. ×0.5 = twice as fast, ×2.0 = twice as slow. Default: ×1.0
            </small>
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
        <ActiveAgentsPanel agents={activeAgents} projectId={projectId} onAgentSelect={setSelectedAgentId} />

        {/* Agent List */}
        {agentView === "tree" ? (
          <div className="agent-tree__view">
            {displayAgents.length === 0 ? (
              <AgentEmptyState onCtaClick={() => setIsCreating(true)} />
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
                  getSkillBadges={getSkillBadges}
                />
              ))
            )}
          </div>
        ) : agentView === "org" ? (
          <div className="agent-org-chart" data-testid="agent-org-chart">
            {isOrgTreeLoading ? (
              <div className="agent-org-chart__loading" role="status" aria-live="polite">
                <RefreshCw size={18} className="spin" />
                <span>Loading org chart...</span>
              </div>
            ) : displayOrgTree.length === 0 ? (
              <AgentEmptyState onCtaClick={() => setIsCreating(true)} />
            ) : (
              displayOrgTree.map((node) => (
                <OrgChartNode
                  key={node.agent.id}
                  node={node}
                  onSelect={setSelectedAgentId}
                  getHealthStatus={getHealthStatus}
                  getRoleIcon={getRoleIcon}
                  getSkillBadges={getSkillBadges}
                />
              ))
            )}
          </div>
        ) : agentView === "board" ? (
          <div className="agent-board">
            {displayAgents.length === 0 ? (
              <AgentEmptyState onCtaClick={() => setIsCreating(true)} />
            ) : (
              displayAgents.map((agent) => {
                const health = getHealthStatus(agent);
                const stateBadgeClass = getStateBadgeClass(agent.state);
                const stateCardClass = getStateCardClass("agent-board-card", agent.state);
                return (
                  <div key={agent.id} className={`agent-board-card ${stateCardClass}`}>
                    <div
                      className="agent-board-clickable"
                      onClick={() => setSelectedAgentId(agent.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && setSelectedAgentId(agent.id)}
                    >
                      <div className="agent-board-header">
                        <span className="agent-board-icon">{getRoleIcon(agent.role)}</span>
                        <span className="agent-board-badge badge text-secondary">{getRoleLabel(agent.role)}</span>
                        <span className={`agent-board-badge badge ${stateBadgeClass}`}>{agent.state}</span>
                      </div>
                      <div className="agent-board-name">{agent.name}</div>
                      <div className="agent-board-id">{agent.id}</div>
                      <div className="agent-board-health" style={{ color: health.color }} title={health.label}>
                        {health.icon}{!health.stateDerived && ` ${health.label}`}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : (
        <div className="agent-list">
          {displayAgents.length === 0 ? (
            <AgentEmptyState onCtaClick={() => setIsCreating(true)} />
          ) : (
            // List view: detailed card layout
            displayAgents.map(agent => {
              const health = getHealthStatus(agent);
              const stateBadgeClass = getStateBadgeClass(agent.state);
              const stateCardClass = getStateCardClass("agent-card", agent.state);
              const configuredIntervalMs = resolveHeartbeatIntervalMs(agent.runtimeConfig?.heartbeatIntervalMs);
              const heartbeatOptions = getHeartbeatIntervalOptions(configuredIntervalMs);
              const isUpdatingHeartbeat = updatingHeartbeatAgentId === agent.id;
              return (
                <div key={agent.id} className={`agent-card ${stateCardClass}`}>
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
                        className={`badge ${stateBadgeClass}`}
                      >
                        {agent.state}
                      </span>
                      <span className="badge" style={{ color: health.color }} title={health.label}>
                        {health.icon}{!health.stateDerived && ` ${health.label}`}
                      </span>
                      <span className="badge text-secondary">
                        {getRoleLabel(agent.role)}
                      </span>
                      {/* List view: up to 2 skill badges */}
                      {(() => {
                        const skills = getSkillBadges(agent);
                        if (skills.length === 0) return null;
                        const displaySkills = skills.slice(0, 2);
                        const extraCount = skills.length - 2;
                        return (
                          <>
                            {displaySkills.map((skillId) => (
                              <span key={skillId} className="badge badge-skill">{skillId}</span>
                            ))}
                            {extraCount > 0 && <span className="badge badge-skill">+{extraCount}</span>}
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  <div className="agent-card-body">
                    {agent.taskId && (
                      <div className="agent-task">
                        <span className="text-secondary">Working on:</span>
                        <span className="badge">{agent.taskId}</span>
                      </div>
                    )}
                    <div className="agent-heartbeat-control">
                      <span className="text-secondary">Heartbeat:</span>
                      {customHeartbeatAgentId === agent.id ? (
                        // Custom input mode
                        <>
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            className="input agent-heartbeat-custom-input"
                            value={customHeartbeatMinutes[agent.id] ?? ""}
                            onChange={(e) => setCustomHeartbeatMinutes((prev) => ({
                              ...prev,
                              [agent.id]: e.target.value,
                            }))}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                void handleCustomHeartbeatSave(agent);
                              } else if (e.key === "Escape") {
                                setCustomHeartbeatAgentId(null);
                                setCustomHeartbeatMinutes((prev) => {
                                  const next = { ...prev };
                                  delete next[agent.id];
                                  return next;
                                });
                              }
                            }}
                            disabled={isUpdatingHeartbeat}
                            aria-label={`Custom heartbeat interval in minutes for ${agent.name}`}
                          />
                          <span className="text-secondary">min</span>
                          <button
                            className="btn btn--sm"
                            onClick={() => void handleCustomHeartbeatSave(agent)}
                            disabled={isUpdatingHeartbeat}
                            title="Save custom interval"
                          >
                            Save
                          </button>
                          <button
                            className="btn btn--sm"
                            onClick={() => {
                              setCustomHeartbeatAgentId(null);
                              setCustomHeartbeatMinutes((prev) => {
                                const next = { ...prev };
                                delete next[agent.id];
                                return next;
                              });
                            }}
                            disabled={isUpdatingHeartbeat}
                            title="Cancel custom interval"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        // Preset selection mode
                        <>
                          <select
                            className="select agent-heartbeat-select"
                            value={configuredIntervalMs}
                            onChange={(e) => {
                              const value = e.target.value;
                              if (value === "__custom__") {
                                handleSelectCustomHeartbeat(agent);
                              } else {
                                void handleHeartbeatIntervalChange(agent, Number(value));
                              }
                            }}
                            disabled={isUpdatingHeartbeat}
                            aria-label={`Set heartbeat interval for ${agent.name}`}
                          >
                            {heartbeatOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                            {/* Only show "Custom..." if current value is a preset; if it's already custom, it's already in the list */}
                            {HEARTBEAT_INTERVAL_PRESETS.some((p) => p.value === configuredIntervalMs) && (
                              <option value="__custom__">Custom...</option>
                            )}
                          </select>
                        </>
                      )}
                      {isUpdatingHeartbeat && <span className="agent-heartbeat-saving text-secondary">Saving…</span>}
                      {agent.lastHeartbeatAt && (() => {
                        const lastAt = new Date(agent.lastHeartbeatAt);
                        const nextAt = new Date(lastAt.getTime() + configuredIntervalMs);
                        const isTicking = agent.state === "active" || agent.state === "running";
                        return (
                          <>
                            <span className="agent-heartbeat-last text-secondary" title={lastAt.toLocaleString()}>
                              Last: {lastAt.toLocaleTimeString()}
                            </span>
                            {isTicking && (
                              <span className="agent-heartbeat-next text-secondary" title={nextAt.toLocaleString()}>
                                Next: {nextAt.toLocaleTimeString()}
                              </span>
                            )}
                          </>
                        );
                      })()}
                    </div>
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
                          onClick={() => void handleRunHeartbeat(agent.id, agent.name)}
                          title="Run Now"
                          aria-label={`Run now for ${agent.name}`}
                        >
                          <Activity size={14} /> Run Now
                        </button>
                        <button
                          className="btn btn--sm"
                          onClick={() => void handleStateChange(agent.id, "paused")}
                          title="Pause"
                        >
                          <Pause size={14} /> Pause
                        </button>
                      </>
                    )}
                    {agent.state === "paused" && (
                      <button
                        className="btn btn--sm"
                        onClick={() => void handleStateChange(agent.id, "active")}
                        title="Resume"
                      >
                        <Play size={14} /> Resume
                      </button>
                    )}
                    {agent.state === "running" && (
                      <>
                        <button
                          className="btn btn--sm"
                          disabled
                          title="Run in progress"
                          aria-label={`Heartbeat run in progress for ${agent.name}`}
                        >
                          <Activity size={14} /> Running
                        </button>
                        <button
                          className="btn btn--sm"
                          onClick={() => void handleStateChange(agent.id, "paused")}
                          title="Pause"
                        >
                          <Pause size={14} /> Pause
                        </button>
                      </>
                    )}
                    {agent.state === "error" && (
                      <button
                        className="btn btn--sm"
                        onClick={() => void handleStateChange(agent.id, "active")}
                        title="Retry"
                      >
                        <Play size={14} /> Retry
                      </button>
                    )}
                    {agent.state === "terminated" && (
                      <>
                        <button
                          className="btn btn--sm"
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
        )}
      </div>

      {/* Agent Detail Modal */}
      {selectedAgentId && (
        <AgentDetailView
          agentId={selectedAgentId}
          projectId={projectId}
          onClose={handleCloseDetail}
          addToast={addToast}
          onChildClick={handleChildClick}
        />
      )}


    </div>
  );
}
