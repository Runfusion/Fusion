import "./AgentsView.css";
import { useState, useEffect, useCallback, useRef, useMemo, useId, lazy, Suspense } from "react";
import { Plus, Play, Pause, Activity, Trash2, RefreshCw, Bot, List, ChevronRight, ChevronDown, ChevronUp, Filter, Upload, Network, SlidersHorizontal, Copy, Check } from "lucide-react";
import type { Agent, AgentCapability, AgentOnboardingSummary, AgentState, OrgTreeNode } from "../api";
import { updateAgent, updateAgentState, deleteAgent, startAgentRun, fetchOrgTree, fetchSettings, updateSettings } from "../api";

const AgentDetailView = lazy(() => import("./AgentDetailView").then((m) => ({ default: m.AgentDetailView })));
import { AgentTokenStatsPanel } from "./AgentTokenStatsPanel";
import { AgentsOverviewBar } from "./AgentsOverviewBar";
import { AgentEmptyState } from "./AgentEmptyState";
import { useAgents } from "../hooks/useAgents";
import { useConfirm } from "../hooks/useConfirm";
import { NewAgentDialog } from "./NewAgentDialog";
import { ExperimentalAgentOnboardingModal } from "./ExperimentalAgentOnboardingModal";
import { AgentImportModal } from "./AgentImportModal";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";
import { useViewportMode } from "../hooks/useViewportMode";
import { getAgentHealthStatus } from "../utils/agentHealth";
import type { AgentHealthStatus } from "../utils/agentHealth";
import {
  formatHeartbeatInterval,
  getHeartbeatIntervalOptions,
  resolveHeartbeatIntervalMs,
  MIN_HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_INTERVAL_PRESETS,
} from "../utils/heartbeatIntervals";
import { isEphemeralAgent, getErrorMessage } from "@fusion/core";
import { relativeTime } from "./AgentDetailView";

export interface AgentsViewProps {
  addToast: (message: string, type?: "success" | "error") => void;
  projectId?: string;
  onOpenTaskLogs?: (taskId: string) => void;
  agentOnboardingEnabled?: boolean;
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

const SKILL_PATH_LABEL_PATTERN = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i;

export function formatAgentSkillBadgeLabel(skillId: string): string {
  const trimmedSkillId = skillId.trim();
  if (!trimmedSkillId) {
    return skillId;
  }

  const match = trimmedSkillId.match(SKILL_PATH_LABEL_PATTERN);
  if (match?.[1]) {
    return match[1];
  }

  return trimmedSkillId;
}

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

function getStateCardClass(
  prefix: "agent-card" | "agent-board-card" | "org-chart-node-card",
  state: AgentState,
): string {
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

export function CollapsibleErrorDisplay({
  errorText,
  className,
}: {
  errorText: string;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(errorText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard errors
    }
  }, [errorText]);

  return (
    <div className={`agent-card-error${className ? ` ${className}` : ""}`}>
      <div className="agent-card-error-header">
        <span className="agent-card-error-preview" title={errorText}>
          {errorText}
        </span>
        <div className="agent-card-error-actions">
          <button
            type="button"
            className="btn-icon touch-target agent-card-error-copy-btn"
            onClick={() => void handleCopy()}
            title={copied ? "Copied" : "Copy error"}
            aria-label={copied ? "Copied error to clipboard" : "Copy error to clipboard"}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            type="button"
            className="btn-icon touch-target agent-card-error-toggle"
            onClick={() => setExpanded((value) => !value)}
            title={expanded ? "Collapse error" : "Expand error"}
            aria-label={expanded ? "Collapse error" : "Expand error"}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>
      {expanded ? <pre className="agent-card-error-full">{errorText}</pre> : null}
    </div>
  );
}

function OrgChartNode({
  node,
  onSelect,
  getHealthStatus,
  getRoleIcon,
  getSkillBadges,
  selectedAgentId,
}: {
  node: OrgTreeNode;
  onSelect: (id: string) => void;
  getHealthStatus: (agent: Agent) => AgentHealthStatus;
  getRoleIcon: (role: AgentCapability) => string;
  getSkillBadges: (agent: Agent) => string[];
  selectedAgentId: string | null;
}) {
  const { agent, children } = node;
  const health = getHealthStatus(agent);
  const stateBadgeClass = getStateBadgeClass(agent.state);
  const stateNodeClass = getStateCardClass("org-chart-node-card", agent.state);

  return (
    <div className={`org-chart-node${children.length > 0 ? " org-chart-node--has-children" : ""}`}>
      <div
        className={`${stateNodeClass}${selectedAgentId === agent.id ? " agent-card--selected" : ""}`}
        onClick={() => onSelect(agent.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            if (e.key === " ") {
              e.preventDefault();
            }
            onSelect(agent.id);
          }
        }}
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
          <span className="org-chart-node__health" style={{ color: health.color }} title={health.reason ?? health.label}>
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
                  <span key={skillId} className="org-chart-node__skill">{formatAgentSkillBadgeLabel(skillId)}</span>
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
              selectedAgentId={selectedAgentId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentsView({ addToast, projectId, onOpenTaskLogs, agentOnboardingEnabled = false }: AgentsViewProps) {
  const [showSystemAgents, setShowSystemAgents] = useState(false);
  const viewportMode = useViewportMode();
  const isMobileViewport = viewportMode === "mobile";
  const [filterState, setFilterState] = useState<AgentState | "all">("all");
  const { agents, stats, isLoading, loadAgents } = useAgents(projectId, {
    filterState,
    showSystemAgents,
  });
  const [isCreating, setIsCreating] = useState(false);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const [onboardingDraft, setOnboardingDraft] = useState<AgentOnboardingSummary | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const isMobileDetailOpen = isMobileViewport && !!selectedAgentId;
  const [selectedAgentInitialTab, setSelectedAgentInitialTab] = useState<"dashboard" | "runs">("dashboard");
  const [selectedAgentInitialRunId, setSelectedAgentInitialRunId] = useState<string | null>(null);
  const [selectedAgentPreferActiveRun, setSelectedAgentPreferActiveRun] = useState(false);
  const [agentView, setAgentView] = useState<"list" | "board" | "org">(() => {
    if (typeof window === "undefined") return "list";
    const saved = getScopedItem("fn-agent-view", projectId);
    return (saved === "list" || saved === "board" || saved === "org") ? saved : "list";
  });
  const [orgTree, setOrgTree] = useState<OrgTreeNode[]>([]);
  const [isOrgTreeLoading, setIsOrgTreeLoading] = useState(false);
  const [isControlsPanelOpen, setIsControlsPanelOpen] = useState(false);
  const [isOverviewOpen, setIsOverviewOpen] = useState(false);
  const controlsPanelRef = useRef<HTMLDivElement>(null);
  const { confirm } = useConfirm();
  const controlsTriggerRef = useRef<HTMLButtonElement>(null);
  const controlsPanelId = useId();

  useEffect(() => {
    const saved = getScopedItem("fn-agent-view", projectId);
    if (saved === "list" || saved === "board" || saved === "org") {
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
  const [updatingHeartbeatAgentId, setUpdatingHeartbeatAgentId] = useState<string | null>(null);
  /** Agent ID currently showing custom heartbeat input */
  const [customHeartbeatAgentId, setCustomHeartbeatAgentId] = useState<string | null>(null);
  /** Custom minutes input value for each agent */
  const [customHeartbeatMinutes, setCustomHeartbeatMinutes] = useState<Record<string, string>>({});
  /** Global heartbeat multiplier loaded from project settings */
  const [heartbeatMultiplier, setHeartbeatMultiplier] = useState<number>(1);
  /** Whether the heartbeat multiplier is currently being saved */
  const [isSavingMultiplier, setIsSavingMultiplier] = useState(false);
  /** Agent IDs with an in-flight state transition (for optimistic update guard) */
  const [transitioningAgentIds, setTransitioningAgentIds] = useState<Set<string>>(new Set());
  /** Optimistic state overrides keyed by agent ID while pause/resume/start API call is in-flight */
  const [optimisticStateOverrides, setOptimisticStateOverrides] = useState<Map<string, AgentState>>(new Map());
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Load heartbeat multiplier from project settings on mount
  useEffect(() => {
    fetchSettings(projectId)
      .then((settings) => {
        if (!isMountedRef.current) return;
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
    } catch (err) {
      addToast(`Failed to save heartbeat multiplier: ${getErrorMessage(err)}`, "error");
    } finally {
      if (isMountedRef.current) {
        setIsSavingMultiplier(false);
      }
    }
  }, [projectId, addToast]);

  const optimisticAgents = useMemo(() => {
    if (optimisticStateOverrides.size === 0) {
      return agents;
    }

    return agents.map((agent) => {
      const optimisticState = optimisticStateOverrides.get(agent.id);
      return optimisticState ? { ...agent, state: optimisticState } : agent;
    });
  }, [agents, optimisticStateOverrides]);


  // Filter agents for display. "All States" means all non-ephemeral agents,
  // including disabled/terminated agents that still carry configuration.
  // When "Show system agents" is enabled, include ephemeral/internal agents.
  const displayAgents = useMemo(() => {
    return optimisticAgents.filter((agent) => showSystemAgents || !isEphemeralAgent(agent));
  }, [optimisticAgents, showSystemAgents]);

  const displayActiveAgents = useMemo(() => {
    return optimisticAgents.filter((agent) => {
      if (agent.state !== "active" && agent.state !== "running") {
        return false;
      }
      return showSystemAgents || !isEphemeralAgent(agent);
    });
  }, [optimisticAgents, showSystemAgents]);

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
      .catch((err) => {
        if (!cancelled) {
          addToast(`Failed to load org chart: ${getErrorMessage(err)}`, "error");
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

  // Poll for agent updates to keep health statuses fresh (every 30 seconds)
  // This ensures health badges stay current while the view is open.
  // SSE refreshes are handled by useAgents.
  useEffect(() => {
    const pollInterval = setInterval(() => {
      void loadAgents();
    }, 30_000);

    return () => {
      clearInterval(pollInterval);
    };
  }, [loadAgents]);

  useEffect(() => {
    if (!isControlsPanelOpen) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (controlsPanelRef.current?.contains(target)) return;
      if (controlsTriggerRef.current?.contains(target)) return;
      setIsControlsPanelOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsControlsPanelOpen(false);
      controlsTriggerRef.current?.focus();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isControlsPanelOpen]);

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
    } catch (err) {
      addToast(`Failed to update heartbeat interval: ${getErrorMessage(err)}`, "error");
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
      } catch (err) {
        addToast(`Failed to update heartbeat interval: ${getErrorMessage(err)}`, "error");
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
    } catch (err) {
      addToast(`Failed to update heartbeat interval: ${getErrorMessage(err)}`, "error");
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

  const openAgentDetail = useCallback((agentId: string, options?: { initialTab?: "dashboard" | "runs"; initialRunId?: string | null; preferActiveRun?: boolean }) => {
    setSelectedAgentId(agentId);
    setSelectedAgentInitialTab(options?.initialTab ?? "dashboard");
    setSelectedAgentInitialRunId(options?.initialRunId ?? null);
    setSelectedAgentPreferActiveRun(options?.preferActiveRun ?? false);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedAgentId(null);
    setSelectedAgentInitialTab("dashboard");
    setSelectedAgentInitialRunId(null);
    setSelectedAgentPreferActiveRun(false);
  }, []);

  const handleChildClick = useCallback((childId: string) => {
    openAgentDetail(childId);
  }, [openAgentDetail]);

  const handleOverviewAgentSelect = useCallback((agentId: string) => {
    openAgentDetail(agentId);
    if (isMobileViewport) {
      setIsOverviewOpen(false);
    }
  }, [isMobileViewport, openAgentDetail]);

  const handleRunHeartbeat = async (agentId: string, agentName: string) => {
    try {
      await startAgentRun(agentId, projectId, { source: "on_demand", triggerDetail: "Triggered from dashboard" });
      addToast(`Heartbeat run started for ${agentName}`, "success");
      void loadAgents();
    } catch (err) {
      addToast(`Failed to start heartbeat run: ${getErrorMessage(err)}`, "error");
    }
  };

  const handleAgentViewChange = useCallback((nextView: "list" | "board" | "org") => {
    setAgentView(nextView);
    if (isMobileViewport && selectedAgentId) {
      handleCloseDetail();
    }
  }, [handleCloseDetail, isMobileViewport, selectedAgentId]);

  const getRoleLabel = (role: AgentCapability) => AGENT_ROLES.find(r => r.value === role)?.label ?? role;
  const getRoleIcon = (role: AgentCapability) => AGENT_ROLES.find(r => r.value === role)?.icon ?? "◆";
  const selectedAgent = selectedAgentId ? displayAgents.find((agent) => agent.id === selectedAgentId) ?? null : null;

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

  const showInitialAgentsLoading = isLoading && agents.length === 0;

  const handleOpenNewAgent = useCallback(() => {
    if (agentOnboardingEnabled) {
      setIsOnboardingOpen(true);
      return;
    }
    setIsCreating(true);
  }, [agentOnboardingEnabled]);

  return (
    <div className="agents-view">
      <div className="agents-view-header">
        <div className="agents-view-title">
          <Bot size={24} />
          <h2>Agents</h2>
        </div>
        <div className="agents-view-controls">
          <div className="view-toggle">
            <button
              className={`view-toggle-btn${agentView === "list" ? " active" : ""}`}
              onClick={() => handleAgentViewChange("list")}
              title="List view"
              aria-label="List view"
              aria-pressed={agentView === "list"}
            >
              <List size={16} />
            </button>
            <button
              className={`view-toggle-btn${agentView === "board" ? " active" : ""}`}
              onClick={() => handleAgentViewChange("board")}
              title="Board view"
              aria-label="Board view"
              aria-pressed={agentView === "board"}
            >
              <Activity size={16} />
            </button>
            <button
              className={`view-toggle-btn${agentView === "org" ? " active" : ""}`}
              onClick={() => handleAgentViewChange("org")}
              title="Org Chart view"
              aria-label="Org Chart view"
              aria-pressed={agentView === "org"}
            >
              <Network size={16} />
            </button>
          </div>
          <div className="agents-view-primary-actions">
            <button
              ref={controlsTriggerRef}
              className={`btn-icon agent-controls-trigger${isControlsPanelOpen ? " agent-controls-trigger--active" : ""}`}
              onClick={() => setIsControlsPanelOpen((open) => !open)}
              title="Controls"
              aria-label="Controls"
              aria-haspopup="dialog"
              aria-expanded={isControlsPanelOpen}
              aria-controls={controlsPanelId}
            >
              <SlidersHorizontal size={16} />
            </button>
            <button
              className="btn-icon"
              onClick={() => void loadAgents()}
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw size={16} className={isLoading ? "spin" : undefined} />
            </button>
            <button
              className="btn btn-task-create btn-sm"
              onClick={() => {
                handleOpenNewAgent();
                setIsControlsPanelOpen(false);
              }}
            >
              <Plus size={16} />
              New Agent
            </button>
          </div>
        </div>
      </div>

      {isControlsPanelOpen && (
        <div
          ref={controlsPanelRef}
          id={controlsPanelId}
          className="agent-controls-panel agent-controls-panel--scrollable"
          role="dialog"
          aria-label="Agent controls"
          aria-modal="false"
        >
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
                onClick={() => {
                  setIsImporting(true);
                  setIsControlsPanelOpen(false);
                }}
              >
                <Upload size={16} />
                Import
              </button>
            </div>
          </div>

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

          <AgentTokenStatsPanel agents={displayAgents} />
        </div>
      )}

      <AgentsOverviewBar
        stats={stats}
        activeAgents={displayActiveAgents}
        projectId={projectId}
        isOpen={isOverviewOpen}
        onToggle={() => setIsOverviewOpen((open) => !open)}
        onSelectAgent={handleOverviewAgentSelect}
        onOpenTaskLogs={onOpenTaskLogs}
      />

      <div className="agents-split-layout">
        <div className={`agents-split-sidebar${isMobileDetailOpen ? " agents-split-sidebar--hidden-mobile" : ""}`}>
          <div className="agents-view-content">
        <NewAgentDialog
          isOpen={isCreating}
          onClose={() => {
            setIsCreating(false);
            setOnboardingDraft(null);
          }}
          onCreated={() => { setIsCreating(false); setOnboardingDraft(null); void loadAgents(); }}
          projectId={projectId}
          prefillDraft={onboardingDraft}
        />

        <ExperimentalAgentOnboardingModal
          isOpen={isOnboardingOpen}
          onClose={() => setIsOnboardingOpen(false)}
          onUseDraft={(draft) => {
            setOnboardingDraft(draft);
            setIsOnboardingOpen(false);
            setIsCreating(true);
          }}
          projectId={projectId}
          existingAgents={agents}
        />

        <AgentImportModal
          isOpen={isImporting}
          onClose={() => setIsImporting(false)}
          onImported={() => void loadAgents()}
          projectId={projectId}
        />

        {/* Agent Collection */}
        {showInitialAgentsLoading ? (
          <div className="agents-view-loading" role="status" aria-live="polite">
            <RefreshCw size={18} className="spin" />
            <span>Loading agents...</span>
          </div>
        ) : agentView === "org" ? (
          <div className="agent-org-chart" data-testid="agent-org-chart">
            {isOrgTreeLoading ? (
              <div className="agent-org-chart__loading" role="status" aria-live="polite">
                <RefreshCw size={18} className="spin" />
                <span>Loading org chart...</span>
              </div>
            ) : displayOrgTree.length === 0 ? (
              <AgentEmptyState onCtaClick={handleOpenNewAgent} />
            ) : (
              displayOrgTree.map((node) => (
                <OrgChartNode
                  key={node.agent.id}
                  node={node}
                  onSelect={openAgentDetail}
                  getHealthStatus={getHealthStatus}
                  getRoleIcon={getRoleIcon}
                  getSkillBadges={getSkillBadges}
                  selectedAgentId={selectedAgentId}
                />
              ))
            )}
          </div>
        ) : agentView === "board" ? (
          <div className="agent-board">
            {displayAgents.length === 0 ? (
              <AgentEmptyState onCtaClick={handleOpenNewAgent} />
            ) : (
              displayAgents.map((agent) => {
                const health = getHealthStatus(agent);
                const stateBadgeClass = getStateBadgeClass(agent.state);
                const stateCardClass = getStateCardClass("agent-board-card", agent.state);
                return (
                  <div key={agent.id} className={`agent-board-card ${stateCardClass}${selectedAgentId === agent.id ? " agent-card--selected" : ""}`}>
                    <div
                      className="agent-board-clickable"
                      onClick={() => openAgentDetail(agent.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          if (e.key === " ") {
                            e.preventDefault();
                          }
                          openAgentDetail(agent.id);
                        }
                      }}
                    >
                      <div className="agent-board-header">
                        <span className="agent-board-icon">{getRoleIcon(agent.role)}</span>
                        <span className="agent-board-badge badge text-secondary">{getRoleLabel(agent.role)}</span>
                        <span className={`agent-board-badge badge ${stateBadgeClass}`}>{agent.state}</span>
                      </div>
                      <div className="agent-board-name">{agent.name}</div>
                      <div className="agent-board-id">{agent.id}</div>
                      <div className="agent-board-health" style={{ color: health.color }} title={health.reason ?? health.label}>
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
            <AgentEmptyState onCtaClick={handleOpenNewAgent} />
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
                <div key={agent.id} className={`agent-card ${stateCardClass}${selectedAgentId === agent.id ? " agent-card--selected" : ""}`}>
                  <div className="agent-card-header">
                    <div
                      className="agent-info agent-info--clickable"
                      onClick={() => openAgentDetail(agent.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          if (e.key === " ") {
                            e.preventDefault();
                          }
                          openAgentDetail(agent.id);
                        }
                      }}
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
                      <span className="badge" style={{ color: health.color }} title={health.reason ?? health.label}>
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
                              <span key={skillId} className="badge badge-skill" title={skillId}>{formatAgentSkillBadgeLabel(skillId)}</span>
                            ))}
                            {extraCount > 0 && <span className="badge badge-skill">+{extraCount}</span>}
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  <div className="agent-card-body">
                    {agent.state === "error" && agent.lastError ? (
                      <CollapsibleErrorDisplay errorText={agent.lastError} />
                    ) : null}
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
                              Last: {lastAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                            </span>
                            {isTicking && (
                              <span className="agent-heartbeat-next text-secondary" title={nextAt.toLocaleString()}>
                                Next: {nextAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                              </span>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  <div className="agent-card-actions">
                    {agent.state === "idle" && (
                      <button
                        className="btn btn--sm"
                        onClick={() => void handleStateChange(agent.id, "active")}
                        disabled={transitioningAgentIds.has(agent.id)}
                        title="Activate"
                      >
                        <Play size={14} /> Start
                      </button>
                    )}
                    {agent.state === "active" && (
                      <>
                        <button
                          className="btn btn--sm"
                          onClick={() => void handleRunHeartbeat(agent.id, agent.name)}
                          disabled={transitioningAgentIds.has(agent.id)}
                          title="Run Now"
                          aria-label={`Run now for ${agent.name}`}
                        >
                          <Activity size={14} /> Run Now
                        </button>
                        <button
                          className="btn btn--sm"
                          onClick={() => void handleStateChange(agent.id, "paused")}
                          disabled={transitioningAgentIds.has(agent.id)}
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
                        disabled={transitioningAgentIds.has(agent.id)}
                        title="Resume"
                      >
                        <Play size={14} /> Resume
                      </button>
                    )}
                    {agent.state === "running" && (
                      <>
                        <button
                          className="btn btn--sm"
                          onClick={() => openAgentDetail(agent.id, { initialTab: "runs", initialRunId: null, preferActiveRun: true })}
                          title="View live run details"
                          aria-label={`View live run details for ${agent.name}`}
                        >
                          <Activity size={14} /> Running
                        </button>
                        <button
                          className="btn btn--sm"
                          onClick={() => void handleStateChange(agent.id, "paused")}
                          disabled={transitioningAgentIds.has(agent.id)}
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
                        disabled={transitioningAgentIds.has(agent.id)}
                        title="Retry"
                      >
                        <Play size={14} /> Retry
                      </button>
                    )}
                    {agent.state === "terminated" && (
                      <button
                        className="btn btn--sm"
                        onClick={() => void handleStateChange(agent.id, "active")}
                        disabled={transitioningAgentIds.has(agent.id)}
                        title="Start"
                      >
                        <Play size={14} /> Start
                      </button>
                    )}
                    <button
                      className="btn btn--sm agent-card-details-btn"
                      onClick={() => openAgentDetail(agent.id)}
                      title={`View details for ${agent.name}`}
                      aria-label={`View details for ${agent.name}`}
                    >
                      View Details
                    </button>
                    <button
                      className="btn btn--sm btn--danger"
                      onClick={() => void handleDelete(agent.id, agent.name)}
                      title="Delete"
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
        )}
          </div>

          {!isMobileViewport && selectedAgent && (
            <div className="agents-sidebar-quick-controls">
              <div className="agents-sidebar-quick-controls__header">
                <strong>{selectedAgent.name}</strong>
                <span className={`badge ${getStateBadgeClass(selectedAgent.state)}`}>{selectedAgent.state}</span>
              </div>
              <div className="agents-sidebar-quick-controls__meta">
                <span>{formatHeartbeatInterval(resolveHeartbeatIntervalMs(selectedAgent.runtimeConfig?.heartbeatIntervalMs))}</span>
                {selectedAgent.lastHeartbeatAt && <span>Last {relativeTime(selectedAgent.lastHeartbeatAt)}</span>}
              </div>
              <div className="agents-sidebar-quick-controls__actions">
                {selectedAgent.state === "idle" && (
                  <button className="btn btn-sm" onClick={() => void handleStateChange(selectedAgent.id, "active")}>
                    <Play size={14} /> Start
                  </button>
                )}
                {selectedAgent.state === "active" && (
                  <>
                    <button className="btn btn-sm" onClick={() => void handleRunHeartbeat(selectedAgent.id, selectedAgent.name)}>
                      <Activity size={14} /> Run Now
                    </button>
                    <button className="btn btn-sm" onClick={() => void handleStateChange(selectedAgent.id, "paused")}>
                      <Pause size={14} /> Pause
                    </button>
                  </>
                )}
                {selectedAgent.state === "running" && (
                  <button className="btn btn-sm" onClick={() => void handleStateChange(selectedAgent.id, "paused")}>
                    <Pause size={14} /> Pause
                  </button>
                )}
                {selectedAgent.state === "paused" && (
                  <button className="btn btn-sm" onClick={() => void handleStateChange(selectedAgent.id, "active")}>
                    <Play size={14} /> Resume
                  </button>
                )}
                {selectedAgent.state === "error" && (
                  <button className="btn btn-sm" onClick={() => void handleStateChange(selectedAgent.id, "active")}>
                    <Play size={14} /> Retry
                  </button>
                )}
                {selectedAgent.state === "terminated" && (
                  <>
                    <button className="btn btn-sm" onClick={() => void handleStateChange(selectedAgent.id, "active")}>
                      <Play size={14} /> Start
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => void handleDelete(selectedAgent.id, selectedAgent.name)}>
                      <Trash2 size={14} /> Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className={`agents-split-detail${isMobileViewport && !selectedAgentId ? " agents-split-detail--hidden-mobile" : ""}`}>
          {selectedAgentId ? (
            <Suspense fallback={null}>
              <AgentDetailView
                inline
                showInlineBackButton={isMobileViewport}
                agentId={selectedAgentId}
                projectId={projectId}
                onClose={handleCloseDetail}
                addToast={addToast}
                onChildClick={handleChildClick}
                initialTab={selectedAgentInitialTab}
                initialRunId={selectedAgentInitialRunId}
                preferActiveRun={selectedAgentPreferActiveRun}
              />
            </Suspense>
          ) : (
            <div className="agents-detail-empty-state">
              <Bot size={48} />
              <h3>Select an agent</h3>
              <p>Choose an agent from the sidebar to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
