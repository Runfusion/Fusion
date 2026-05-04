import "./AgentDetailView.css";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Bot, Heart, Activity, Pause, Play, Square, Trash2, RefreshCw, 
  Settings, FileText, ActivitySquare, X, Copy, 
  ExternalLink, CheckCircle, XCircle, Loader2, GitBranch, ListChecks,
  ChevronDown, ChevronRight, ChevronLeft, BarChart3, BookOpen, Eye, FileEdit
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentDetail, AgentState, AgentHeartbeatRun, AgentBudgetStatus, ModelInfo, MemoryFileInfo, AgentCapability, PluginRuntimeInfo } from "../api";
import { fetchAgent, updateAgent, updateAgentState, deleteAgent, fetchAgentLogsWithMeta, fetchAgentRunLogs, fetchAgentChildren, fetchAgentRuns, fetchAgentRunDetail, startAgentRun, stopAgentRun, updateAgentInstructions, updateAgentSoul, updateAgentMemory, fetchAgentMemoryFiles, fetchAgentMemoryFile, saveAgentMemoryFile, fetchAgentTasks, fetchChainOfCommand, fetchAgentBudgetStatus, resetAgentBudget, fetchWorkspaceFileContent, saveWorkspaceFileContent, fetchModels, fetchPluginRuntimes, fetchAgents, upgradeAgentHeartbeatProcedure, updateGlobalSettings } from "../api";
import type { Agent } from "../api";
import type { AgentLogEntry, Task } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import { AgentLogViewer } from "./AgentLogViewer";
import { AgentReflectionsTab } from "./AgentReflectionsTab";
import { getAgentHealthStatus } from "../utils/agentHealth";
import type { AgentHealthStatus } from "../utils/agentHealth";
import { SkillMultiselect } from "./SkillMultiselect";
import { subscribeSse } from "../sse-bus";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, formatHeartbeatInterval, resolveHeartbeatIntervalMs } from "../utils/heartbeatIntervals";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { useConfirm } from "../hooks/useConfirm";
import { useModalResizePersist } from "../hooks/useModalResizePersist";

/**
 * Simple className utility - joins class names conditionally
 */
function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Format an ISO timestamp to a relative time string.
 */
export function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;

  // Future
  if (diffMs < 0) {
    const absDiff = Math.abs(diffMs);
    if (absDiff < 60_000) return "in a moment";
    if (absDiff < 3_600_000) return `in ${Math.floor(absDiff / 60_000)}m`;
    if (absDiff < 86_400_000) return `in ${Math.floor(absDiff / 3_600_000)}h`;
    return `in ${Math.floor(absDiff / 86_400_000)}d`;
  }

  // Past
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

interface AgentDetailViewProps {
  agentId: string;
  projectId?: string;
  onClose: () => void;
  addToast: (message: string, type?: "success" | "error") => void;
  onChildClick?: (childId: string) => void;
  inline?: boolean;
  showInlineBackButton?: boolean;
  initialTab?: TabId;
  initialRunId?: string | null;
  preferActiveRun?: boolean;
}

type TabId = "dashboard" | "logs" | "config" | "runs" | "tasks" | "employees" | "soul" | "instructions" | "memory" | "reflections";

const TABS: { id: TabId; label: string; icon: typeof Activity }[] = [
  { id: "dashboard", label: "Dashboard", icon: ActivitySquare },
  { id: "logs", label: "Logs", icon: FileText },
  { id: "runs", label: "Runs", icon: Activity },
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "employees", label: "Employees", icon: GitBranch },
  { id: "soul", label: "Soul", icon: Heart },
  { id: "instructions", label: "Instructions", icon: BookOpen },
  { id: "memory", label: "Agent Memory", icon: FileText },
  { id: "reflections", label: "Evaluation", icon: BarChart3 },
  { id: "config", label: "Settings", icon: Settings },
];

const STATE_COLORS: Record<AgentState, { bg: string; text: string; border: string }> = {
  idle: { bg: "var(--state-idle-bg)", text: "var(--state-idle-text)", border: "var(--state-idle-border)" },
  active: { bg: "var(--state-active-bg)", text: "var(--state-active-text)", border: "var(--state-active-border)" },
  running: { bg: "var(--state-active-bg)", text: "var(--state-active-text)", border: "var(--state-active-border)" },
  paused: { bg: "var(--state-paused-bg)", text: "var(--state-paused-text)", border: "var(--state-paused-border)" },
  error: { bg: "var(--state-error-bg)", text: "var(--state-error-text)", border: "var(--state-error-border)" },
  terminated: { bg: "var(--state-error-bg)", text: "var(--state-error-text)", border: "var(--state-error-border)" },
};

const RUN_STATUS_ICONS: Record<string, { icon: typeof CheckCircle; color: string }> = {
  completed: { icon: CheckCircle, color: "var(--color-success)" },
  failed: { icon: XCircle, color: "var(--color-error)" },
  active: { icon: Loader2, color: "var(--in-progress)" },
  terminated: { icon: Square, color: "var(--text-muted)" },
};

const MEMORY_LAYER_NAMES: Record<MemoryFileInfo["layer"], string> = {
  "long-term": "Long-term",
  daily: "Daily",
  dreams: "Dreams",
};

const MEMORY_LAYER_DESCRIPTIONS: Record<MemoryFileInfo["layer"], string> = {
  "long-term": "Curated durable decisions, conventions, constraints, and pitfalls for this specific agent.",
  daily: "Raw daily observations and open loops recorded by this agent.",
  dreams: "Synthesized patterns and emerging themes distilled from this agent's daily memory.",
};

const DEFAULT_HEARTBEAT_INTERVAL_LABEL = formatHeartbeatInterval(DEFAULT_HEARTBEAT_INTERVAL_MS);

function pickDefaultAgentMemoryPath(files: MemoryFileInfo[], currentPath: string): string {
  if (files.some((file) => file.path === currentPath)) {
    return currentPath;
  }

  return files.find((file) => file.layer === "long-term")?.path
    ?? files[0]?.path
    ?? "";
}

export function AgentDetailView({ agentId, projectId, onClose, addToast, onChildClick, inline = false, showInlineBackButton = false, initialTab, initialRunId, preferActiveRun = false }: AgentDetailViewProps) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const { confirm } = useConfirm();
  const [logs, setLogs] = useState<AgentLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>(initialTab ?? "dashboard");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [latestRun, setLatestRun] = useState<AgentHeartbeatRun | null>(null);
  const agentDetailModalRef = useRef<HTMLDivElement>(null);
  const overlayMouseDownRef = useRef(false);
  useModalResizePersist(agentDetailModalRef, !inline, "fusion:agent-detail-modal-size");
  const onCloseRef = useRef(onClose);
  const addToastRef = useRef(addToast);
  const agentRef = useRef<AgentDetail | null>(null);
  const hasConfigChangesRef = useRef(false);
  const loadedLatestRunLogsRef = useRef<string | null>(null);

  // Track the context version to detect stale events after project/agent switches.
  // Incremented whenever agentId or projectId changes, invalidating any in-flight SSE handlers.
  const contextVersionRef = useRef(0);
  const previousAgentIdRef = useRef(agentId);
  const previousProjectIdRef = useRef(projectId);

  onCloseRef.current = onClose;
  addToastRef.current = addToast;
  agentRef.current = agent;

  const loadAgent = useCallback(async () => {
    const showLoadingSpinner = agentRef.current === null;
    if (showLoadingSpinner) {
      setIsLoading(true);
    }

    try {
      const data = await fetchAgent(agentId, projectId);
      setAgent(data);
    } catch (err) {
      addToastRef.current(`Failed to load agent: ${getErrorMessage(err)}`, "error");
      onCloseRef.current();
    } finally {
      setIsLoading(false);
    }
  }, [agentId, projectId]);

  const loadLogs = useCallback(async () => {
    // Capture context version at callback creation - stale responses will be rejected
    const contextVersionAtCapture = contextVersionRef.current;
    const currentAgentId = agentId;
    const currentProjectId = projectId;

    const isStale = () =>
      contextVersionRef.current !== contextVersionAtCapture ||
      agentId !== currentAgentId ||
      projectId !== currentProjectId;

    try {
      if (agent?.taskId) {
        setLatestRun(null);
        loadedLatestRunLogsRef.current = null;
        const result = await fetchAgentLogsWithMeta(agent.taskId, currentProjectId, { limit: 100 });
        if (isStale()) return;
        setLogs(result.entries);
        return;
      }

      // Fallback: show the latest run's logs so the Logs tab is populated even
      // when no task is currently assigned.
      const runs = await fetchAgentRuns(currentAgentId, 1, currentProjectId);
      if (isStale()) return;
      const latest = runs[0] ?? null;
      setLatestRun(latest);
      if (!latest) {
        loadedLatestRunLogsRef.current = null;
        setLogs([]);
        return;
      }
      if (loadedLatestRunLogsRef.current === latest.id) {
        return;
      }
      const entries = await fetchAgentRunLogs(currentAgentId, latest.id, currentProjectId);
      if (isStale()) return;
      setLogs(entries);
      loadedLatestRunLogsRef.current = latest.id;
    } catch (err) {
      if (isStale()) return;
      console.error("Failed to load agent logs:", err);
    }
  }, [agent?.taskId, agentId, projectId]);

  const handleConfigChangesState = useCallback((hasChanges: boolean) => {
    hasConfigChangesRef.current = hasChanges;
  }, []);

  useEffect(() => {
    void loadAgent();
  }, [loadAgent]);

  // Poll for agent updates to keep health status fresh (every 30 seconds)
  // This ensures health badges stay current while the detail view is open
  useEffect(() => {
    const pollInterval = setInterval(() => {
      void loadAgent();
    }, 30_000);

    return () => {
      clearInterval(pollInterval);
    };
  }, [loadAgent]);

  useEffect(() => {
    if (agent && activeTab === "logs") {
      void loadLogs();
    }
  }, [agent, activeTab, loadLogs]);

  useEffect(() => {
    if (activeTab !== "logs") {
      loadedLatestRunLogsRef.current = null;
    }
  }, [activeTab]);

  // When falling back to latest-run logs (no taskId) and that run is active,
  // subscribe to the run-scoped SSE stream so the Logs tab tails updates.
  useEffect(() => {
    if (activeTab !== "logs" || agent?.taskId) return;
    if (!latestRun || latestRun.status !== "active") return;

    const contextVersionAtStart = contextVersionRef.current;
    const currentAgentId = agentId;
    const currentRunId = latestRun.id;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const unsubscribe = subscribeSse(
      `/api/agents/${encodeURIComponent(currentAgentId)}/runs/${encodeURIComponent(currentRunId)}/logs/stream${query}`,
      {
        events: {
          "agent:log": (e) => {
            if (contextVersionRef.current !== contextVersionAtStart) return;
            try {
              const entry: AgentLogEntry = JSON.parse(e.data);
              setLogs(prev => [...prev, entry]);
            } catch {
              // ignore malformed events
            }
          },
        },
        onOpen: () => {
          if (contextVersionRef.current === contextVersionAtStart) {
            setIsStreaming(true);
          }
        },
        onError: () => {
          if (contextVersionRef.current === contextVersionAtStart) {
            setIsStreaming(false);
          }
        },
      },
    );

    return () => {
      unsubscribe();
      if (contextVersionRef.current === contextVersionAtStart) {
        setIsStreaming(false);
      }
    };
  }, [activeTab, agent?.taskId, agentId, projectId, latestRun]);

  // Detect context changes (agentId or projectId) and invalidate stale handlers
  useEffect(() => {
    if (previousAgentIdRef.current !== agentId || previousProjectIdRef.current !== projectId) {
      previousAgentIdRef.current = agentId;
      previousProjectIdRef.current = projectId;
      contextVersionRef.current++;

      // Clear stale logs and streaming state immediately
      setLogs([]);
      setIsStreaming(false);
      setLatestRun(null);
      loadedLatestRunLogsRef.current = null;
      hasConfigChangesRef.current = false;
    }
  }, [agentId, projectId]);

  // Refresh this view when the current agent is updated elsewhere, unless there are unsaved edits.
  useEffect(() => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const contextVersionAtStart = contextVersionRef.current;

    return subscribeSse(`/api/events${query}`, {
      events: {
        "agent:updated": (event) => {
          if (contextVersionRef.current !== contextVersionAtStart) return;

          try {
            const payload: unknown = JSON.parse(event.data);
            if (!payload || typeof payload !== "object") return;

            const updatedId = (payload as { id?: unknown }).id;
            if (updatedId !== agentId) return;
            if (hasConfigChangesRef.current) return;

            void loadAgent();
          } catch {
            // Ignore malformed events
          }
        },
      },
    });
  }, [agentId, projectId, loadAgent]);

  // Set up SSE for live log streaming when viewing logs tab with a task
  useEffect(() => {
    if (activeTab !== "logs" || !agent?.taskId) {
      setIsStreaming(false);
      return;
    }

    // Capture context version at effect start - stale events will be rejected
    const contextVersionAtStart = contextVersionRef.current;
    const currentTaskId = agent.taskId;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const unsubscribe = subscribeSse(
      `/api/tasks/${encodeURIComponent(currentTaskId)}/logs/stream${query}`,
      {
        events: {
          "agent:log": (e) => {
            if (contextVersionRef.current !== contextVersionAtStart) return;
            try {
              const entry: AgentLogEntry = JSON.parse(e.data);
              setLogs(prev => [...prev, entry]);
            } catch {
              // Ignore parse errors
            }
          },
        },
        onOpen: () => {
          if (contextVersionRef.current === contextVersionAtStart) {
            setIsStreaming(true);
          }
        },
        onError: () => {
          if (contextVersionRef.current === contextVersionAtStart) {
            setIsStreaming(false);
          }
        },
      },
    );

    return () => {
      unsubscribe();
      if (contextVersionRef.current === contextVersionAtStart) {
        setIsStreaming(false);
      }
    };
  }, [agent?.taskId, activeTab, projectId]);

  const handleStateChange = async (newState: AgentState) => {
    if (isTransitioning || !agentRef.current) return;

    const previousState = agentRef.current.state;
    if (previousState === newState) return;

    setIsTransitioning(true);
    setAgent((prev) => (prev ? { ...prev, state: newState } : prev));

    try {
      await updateAgentState(agentId, newState, projectId);
      addToast(`Agent state updated to ${newState}`, "success");
      void loadAgent();
    } catch (err) {
      setAgent((prev) => (prev ? { ...prev, state: previousState } : prev));
      addToast(`Failed to update state: ${getErrorMessage(err)}`, "error");
    } finally {
      setIsTransitioning(false);
    }
  };

  const handleDelete = async () => {
    if (!agent) return;
    const shouldDelete = await confirm({
      title: "Delete Agent",
      message: `Delete agent "${agent.name}"? This cannot be undone.`,
      danger: true,
    });
    if (!shouldDelete) return;
    try {
      await deleteAgent(agentId, projectId);
      addToast(`Agent "${agent.name}" deleted`, "success");
      onClose();
    } catch (err) {
      addToast(`Failed to delete agent: ${getErrorMessage(err)}`, "error");
    }
  };

  // Use centralized health status utility for consistent labels across all views
  const getHealthStatus = (): AgentHealthStatus => {
    if (!agent) {
      return {
        label: "Unknown",
        icon: <Bot size={14} />,
        color: "var(--text-muted)",
        stateDerived: false,
      };
    }

    return getAgentHealthStatus(agent);
  };

  const copyAgentId = () => {
    if (agent) {
      navigator.clipboard.writeText(agent.id);
      addToast("Agent ID copied to clipboard", "success");
    }
  };

  if (isLoading) {
    if (inline) {
      return (
        <div className="agent-detail-inline-loading" role="region" aria-label="Agent detail loading">
          <div className="agent-detail-loading">
            <Loader2 className="animate-spin" size={24} />
            <span>Loading agent...</span>
          </div>
        </div>
      );
    }

    return (
      <div
        className="agent-detail-overlay"
        onMouseDown={(e) => { if (e.target === e.currentTarget) overlayMouseDownRef.current = true; }}
        onMouseUp={(e) => {
          if (overlayMouseDownRef.current && e.target === e.currentTarget) onClose();
          overlayMouseDownRef.current = false;
        }}
        role="dialog"
        aria-modal="true"
      >
        <div className="agent-detail-modal" ref={agentDetailModalRef}>
          <div className="agent-detail-loading">
            <Loader2 className="animate-spin" size={24} />
            <span>Loading agent...</span>
          </div>
        </div>
      </div>
    );
  }

  if (!agent) {
    return null;
  }

  const stateStyle = STATE_COLORS[agent.state];
  const health = getHealthStatus();
  const detailShellClassName = inline ? "agent-detail-inline" : "agent-detail-modal";

  return (
    <div
      className={inline ? "agent-detail-inline-shell" : "agent-detail-overlay"}
      onClick={(e) => !inline && e.target === e.currentTarget && onClose()}
      role={inline ? "region" : "dialog"}
      aria-label={inline ? "Agent detail" : undefined}
      aria-modal={inline ? undefined : "true"}
    >
      <div className={detailShellClassName} ref={agentDetailModalRef}>
        {/* Header */}
        <div className="agent-detail-header">
          {/* Identity area: icon + name + badges */}
          <div className="agent-detail-identity">
            {inline && showInlineBackButton ? (
              <button
                type="button"
                className="btn agent-detail-inline-back"
                onClick={onClose}
                aria-label="Back to agents"
              >
                <ChevronLeft size={16} />
                Agents
              </button>
            ) : null}
            <div className="agent-detail-icon">
              <Bot size={20} />
            </div>
            <div className="agent-detail-info">
              <h2>{agent.name}</h2>
              <div className="agent-detail-badges">
                <span 
                  className="badge"
                  style={{ background: stateStyle.bg, color: stateStyle.text, border: `1px solid ${stateStyle.border}` }}
                >
                  {agent.state}
                </span>
                <span className="badge" style={{ color: health.color }} title={health.reason ?? health.label}>
                  {health.icon}
                  {!health.stateDerived && health.label}
                </span>
              </div>
            </div>
          </div>

          <div className="agent-detail-header-actions">
            {/* Lifecycle controls: compact action buttons */}
            <div className="agent-detail-controls">
              {/* State-dependent action buttons */}
              {agent.state === "idle" && (
                <>
                  <button className="btn btn-task-create btn--compact" onClick={() => void handleStateChange("active")} disabled={isTransitioning}>
                    <Play size={14} />
                    Start
                  </button>
                  <button className="btn btn--danger btn--compact" onClick={handleDelete}>
                    <Trash2 size={14} />
                    Delete
                  </button>
                </>
              )}
              {agent.state === "active" && (
                <button className="btn btn--compact" onClick={() => void handleStateChange("paused")} disabled={isTransitioning}>
                  <Pause size={14} />
                  Pause
                </button>
              )}
              {agent.state === "paused" && (
                <button className="btn btn-task-create btn--compact" onClick={() => void handleStateChange("active")} disabled={isTransitioning}>
                  <Play size={14} />
                  Resume
                </button>
              )}
              {agent.state === "running" && (
                <>
                  <button className="btn btn--compact" onClick={() => void handleStateChange("paused")} disabled={isTransitioning}>
                    <Pause size={14} />
                    Pause
                  </button>
                  <button className="btn btn--danger btn--compact" onClick={() => void handleStateChange("terminated")} disabled={isTransitioning}>
                    <Square size={14} />
                    Stop
                  </button>
                </>
              )}
              {agent.state === "error" && (
                <>
                  <button className="btn btn-task-create btn--compact" onClick={() => void handleStateChange("active")} disabled={isTransitioning}>
                    <Play size={14} />
                    Retry
                  </button>
                  <button className="btn btn--danger btn--compact" onClick={() => void handleStateChange("terminated")} disabled={isTransitioning}>
                    <Square size={14} />
                    Stop
                  </button>
                </>
              )}
              {agent.state === "terminated" && (
                <>
                  <button className="btn btn-task-create btn--compact" onClick={() => void handleStateChange("active")} disabled={isTransitioning}>
                    <Play size={14} />
                    Start
                  </button>
                  <button className="btn btn--danger btn--compact" onClick={handleDelete}>
                    <Trash2 size={14} />
                    Delete
                  </button>
                </>
              )}
            </div>

            {/* Utility actions: refresh + close */}
            <div className="agent-detail-utility-actions">
              <button className="btn-icon" onClick={() => void loadAgent()} title="Refresh">
                <RefreshCw size={16} />
              </button>
              {!inline && (
                <button className="btn-icon" onClick={onClose} aria-label="Close" title="Close">
                  <X size={20} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="agent-detail-tabs">
          {TABS.map(tab => (
            <button
              key={tab.id}
              className={cn("agent-detail-tab", activeTab === tab.id && "active")}
              onClick={() => setActiveTab(tab.id)}
            >
              <tab.icon size={16} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="agent-detail-content">
          {activeTab === "dashboard" && (
            <DashboardTab
              agent={agent}
              health={health}
              onChildClick={onChildClick}
              projectId={projectId}
            />
          )}
          
          {activeTab === "logs" && (
            <LogsTab
              logs={logs}
              isStreaming={isStreaming}
              hasTask={!!agent.taskId || logs.length > 0 || latestRun !== null}
              fallbackLabel={!agent.taskId && latestRun ? `Latest run · ${latestRun.id.slice(0, 8)}` : null}
            />
          )}
          
          {activeTab === "runs" && (
            <RunsTab 
              addToast={addToast}
              agentId={agent.id}
              projectId={projectId}
              agentState={agent.state}
              agentName={agent.name}
              initialRunId={initialRunId}
              preferActiveRun={preferActiveRun}
            />
          )}

          {activeTab === "tasks" && (
            <TasksTab
              agentId={agent.id}
              projectId={projectId}
              addToast={addToast}
            />
          )}
          
          {activeTab === "employees" && (
            <EmployeesTab
              agentId={agent.id}
              projectId={projectId}
              onChildClick={onChildClick}
            />
          )}

          {activeTab === "soul" && (
            <SoulTab
              agent={agent}
              projectId={projectId}
              addToast={addToast}
              onSaved={loadAgent}
            />
          )}

          {activeTab === "instructions" && (
            <InstructionsTab
              agent={agent}
              projectId={projectId}
              addToast={addToast}
              onSaved={loadAgent}
            />
          )}

          {activeTab === "memory" && (
            <MemoryTab
              agent={agent}
              projectId={projectId}
              addToast={addToast}
              onSaved={loadAgent}
            />
          )}

          {activeTab === "reflections" && (
            <AgentReflectionsTab
              agentId={agent.id}
              projectId={projectId}
              addToast={addToast}
            />
          )}

          {activeTab === "config" && (
            <ConfigTab 
              agent={agent}
              projectId={projectId}
              addToast={addToast}
              onSaved={loadAgent}
              onHasChangesChange={handleConfigChangesState}
              onDelete={handleDelete}
            />
          )}
        </div>

        {/* Footer with agent ID */}
        {!inline && (
          <div className="agent-detail-footer">
            <button className="btn-icon" onClick={copyAgentId} title="Copy Agent ID">
              <Copy />
            </button>
            <span className="agent-detail-id" onClick={copyAgentId}>
              {agent.id}
            </span>
            {agent.taskId && (
              <>
                <span className="divider">|</span>
                <span className="text-muted">Working on:</span>
                <a href={`/tasks/${agent.taskId}`} className="link">
                  {agent.taskId}
                  <ExternalLink size={12} />
                </a>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Dashboard Tab ───────────────────────────────────────────────────────────

function DashboardTab({ 
  agent, 
  health,
  onChildClick,
  projectId,
}: { 
  agent: AgentDetail; 
  health: AgentHealthStatus;
  onChildClick?: (childId: string) => void;
  projectId?: string;
}) {
  const stateStyle = STATE_COLORS[agent.state];
  const [chainOfCommand, setChainOfCommand] = useState<Agent[]>([]);
  const [isLoadingChainOfCommand, setIsLoadingChainOfCommand] = useState(true);
  const [budgetStatus, setBudgetStatus] = useState<AgentBudgetStatus | null>(null);
  const [availableRuntimes, setAvailableRuntimes] = useState<PluginRuntimeInfo[]>([]);

  const runtimeHint = typeof agent.runtimeConfig?.runtimeHint === "string"
    ? agent.runtimeConfig.runtimeHint
    : "";

  const modelDisplay = (() => {
    const rc = agent.runtimeConfig ?? {};
    if (runtimeHint) {
      const selectedRuntime = availableRuntimes.find((runtime) => runtime.runtimeId === runtimeHint);
      return selectedRuntime ? selectedRuntime.name : runtimeHint;
    }
    if (rc.modelProvider && rc.modelId) {
      return `${rc.modelProvider}/${rc.modelId}`;
    }
    if (typeof rc.model === "string" && rc.model.includes("/")) {
      const slashIdx = rc.model.indexOf("/");
      return rc.model.slice(slashIdx + 1);
    }
    return null;
  })();

  // Fetch budget status on mount
  useEffect(() => {
    fetchAgentBudgetStatus(agent.id, projectId)
      .then(setBudgetStatus)
      .catch(() => setBudgetStatus(null));
  }, [agent.id, projectId]);

  useEffect(() => {
    fetchPluginRuntimes(projectId)
      .then(setAvailableRuntimes)
      .catch(() => setAvailableRuntimes([]));
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingChainOfCommand(true);

    void fetchChainOfCommand(agent.id, projectId)
      .then((chain) => {
        if (cancelled) return;
        const normalized = chain.length > 0 && chain[0]?.id === agent.id
          ? [...chain].reverse()
          : chain;
        setChainOfCommand(normalized);
      })
      .catch(() => {
        if (!cancelled) {
          setChainOfCommand([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingChainOfCommand(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agent.id, projectId]);

  const stats = useMemo(() => {
    const runs = agent.completedRuns || [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayRuns = runs.filter((r: AgentHeartbeatRun) => 
      new Date(r.startedAt) >= today
    );
    
    const successfulRuns = runs.filter((r: AgentHeartbeatRun) => 
      r.status === "completed"
    );
    
    return {
      totalRuns: runs.length,
      todayRuns: todayRuns.length,
      successfulRuns: successfulRuns.length,
      successRate: runs.length > 0 
        ? Math.round((successfulRuns.length / runs.length) * 100) 
        : 0,
    };
  }, [agent]);

  const recentRuns = (agent.completedRuns || []).slice(0, 5);
  const isTicking = agent.state === "active" || agent.state === "running";
  const heartbeatIntervalMs = resolveHeartbeatIntervalMs(agent.runtimeConfig?.heartbeatIntervalMs);
  const nextHeartbeatAt = isTicking && agent.lastHeartbeatAt
    ? new Date(new Date(agent.lastHeartbeatAt).getTime() + heartbeatIntervalMs).toISOString()
    : null;

  return (
    <div className="dashboard-tab dashboard-summary-layout">
      {budgetStatus?.isOverBudget && (
        <div className="budget-warning-banner" role="alert">
          <span>⚠️</span>
          <span><strong>Budget Exhausted:</strong> This agent has exceeded its token budget and may operate with limited functionality.</span>
        </div>
      )}

      <section className="dashboard-summary-card dashboard-summary-hero">
        <div className="dashboard-summary-hero__heading">
          <Bot />
          <h3>Overview</h3>
          <strong>{agent.name}</strong>
          <span className="inline-badge" style={{ background: stateStyle.bg, color: stateStyle.text }}>{agent.state}</span>
        </div>
        <div className="dashboard-summary-hero__meta">
          <span className="dashboard-summary-hero__health" title={health.reason ?? health.label}>{health.icon} {health.label}</span>
          <span>Role: {agent.role}</span>
          <span>
            <span className="dashboard-summary-label">{runtimeHint ? "Runtime" : "Model"}</span>
            <span> {modelDisplay ?? "Auto"}</span>
          </span>
          {Array.isArray(agent.metadata?.skills) && (agent.metadata.skills as string[]).length > 0 ? (
            <span>Skills: {(agent.metadata.skills as string[]).join(", ")}</span>
          ) : (
            <span>Skills: —</span>
          )}
        </div>
      </section>

      <section className="dashboard-summary-card">
        <h3>Heartbeat &amp; Health</h3>
        <div className="dashboard-summary-grid">
          <div>
            <p className="dashboard-summary-label">Last heartbeat</p>
            <p>{agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "Never"}</p>
          </div>
          <div>
            <p className="dashboard-summary-label">Next expected</p>
            <p>{nextHeartbeatAt ? relativeTime(nextHeartbeatAt) : "Not scheduled"}</p>
          </div>
          <div>
            <p className="dashboard-summary-label">Interval</p>
            <p>{formatHeartbeatInterval(heartbeatIntervalMs)}</p>
          </div>
          <div>
            <p className="dashboard-summary-label">Status</p>
            <p className="dashboard-summary-health-row"><span className={cn("status-dot", agent.state === "running" && "status-dot--running")} />{health.label}{health.reason && <span className="text-secondary dashboard-summary-health-reason" title={health.reason}>({health.reason})</span>}</p>
          </div>
        </div>
      </section>

      <section className="dashboard-summary-card">
        <h3>Current Work</h3>
        {agent.taskId ? (
          <div className="current-task">
            <a href={`/tasks/${agent.taskId}`} className="task-badge">{agent.taskId}</a>
            <a href={`/tasks/${agent.taskId}`} className="btn btn-sm">View Task <ExternalLink size={14} /></a>
          </div>
        ) : (
          <p className="text-muted">No active assignment</p>
        )}
      </section>

      <section className="dashboard-summary-card">
        <h3>Recent Runs</h3>
        <p className="dashboard-summary-label">{stats.successfulRuns}/{stats.totalRuns} successful ({stats.successRate}%)</p>
        {recentRuns.length === 0 ? (
          <p className="text-muted">No runs yet</p>
        ) : (
          <div className="runs-list">
            {recentRuns.map((run) => {
              const statusSpec = RUN_STATUS_ICONS[run.status] || RUN_STATUS_ICONS.terminated;
              const StatusIcon = statusSpec.icon;
              return (
                <div key={run.id} className="run-item">
                  <StatusIcon size={14} style={{ color: statusSpec.color }} />
                  <span>{relativeTime(run.startedAt)}</span>
                  <span className="text-muted">{Math.max(0, Math.round((new Date(run.endedAt || run.startedAt).getTime() - new Date(run.startedAt).getTime()) / 1000))}s</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="dashboard-summary-card">
        <h3>Throughput</h3>
        <div className="stats-grid">
          <div className="stat-card"><div className="stat-value">{stats.totalRuns}</div><div className="stat-label">Total Runs</div></div>
          <div className="stat-card"><div className="stat-value">{stats.todayRuns}</div><div className="stat-label">Runs Today</div></div>
          <div className="stat-card"><div className="stat-value">{stats.successRate}%</div><div className="stat-label">Success Rate</div></div>
        </div>
      </section>

      <section className="dashboard-summary-card">
        <h3>Chain of Command</h3>
        {isLoadingChainOfCommand ? (
          <div className="chain-of-command-loading" role="status" aria-live="polite"><Loader2 size={14} className="animate-spin" /><span>Loading reporting chain...</span></div>
        ) : chainOfCommand.length <= 1 ? (
          <p className="text-muted">No reporting chain</p>
        ) : (
          <div className="chain-of-command-path" aria-label="Chain of command">
            {chainOfCommand.map((chainAgent, index) => {
              const isCurrent = index === chainOfCommand.length - 1;
              const isAncestor = !isCurrent;
              return (
                <div key={chainAgent.id} className="chain-of-command-item">
                  <button type="button" className={`chain-of-command-node${isCurrent ? " chain-of-command-node--current" : ""}`} onClick={() => isAncestor && onChildClick?.(chainAgent.id)} disabled={!isAncestor || !onChildClick} title={isCurrent ? "Current agent" : `View ${chainAgent.name}`}>
                    {chainAgent.name}
                  </button>
                  {!isCurrent && <span className="chain-of-command-separator" aria-hidden="true">→</span>}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Logs Tab ──────────────────────────────────────────────────────────────

function LogsTab({
  logs,
  isStreaming,
  hasTask,
  fallbackLabel,
}: {
  logs: AgentLogEntry[];
  isStreaming: boolean;
  hasTask: boolean;
  fallbackLabel?: string | null;
}) {
  if (!hasTask) {
    return (
      <div className="logs-tab">
        <div className="logs-empty">
          <FileText size={48} opacity={0.3} />
          <p>No activity yet</p>
          <p className="text-muted">
            Agent logs will appear here from the current task or most recent run
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="logs-tab">
      <div className="logs-header">
        <span className="logs-count">{logs.length} entries</span>
        {fallbackLabel && (
          <span className="text-muted logs-fallback-label">{fallbackLabel}</span>
        )}
        {isStreaming && (
          <span className="streaming-indicator">
            <span className="streaming-dot" />
            Live
          </span>
        )}
      </div>
      {logs.length === 0 ? (
        <div className="logs-empty">
          <FileText size={48} opacity={0.3} />
          <p>No log entries yet</p>
          <p className="text-muted">
            {isStreaming ? "Waiting for activity..." : "Logs will appear here when the agent is active"}
          </p>
        </div>
      ) : (
        <AgentLogViewer entries={logs} loading={false} />
      )}
    </div>
  );
}

// ── Runs Tab ───────────────────────────────────────────────────────────────

function RunsTab({ 
  addToast,
  agentId,
  projectId,
  agentState,
  agentName,
  initialRunId,
  preferActiveRun,
}: { 
  addToast: (msg: string, type?: "success" | "error") => void;
  agentId: string;
  projectId?: string;
  agentState?: AgentState;
  agentName?: string;
  initialRunId?: string | null;
  preferActiveRun?: boolean;
}) {
  const [runs, setRuns] = useState<AgentHeartbeatRun[]>([]);
  const { confirm } = useConfirm();
  const [isLoadingRuns, setIsLoadingRuns] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runLogs, setRunLogs] = useState<AgentLogEntry[]>([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [detailRun, setDetailRun] = useState<AgentHeartbeatRun | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const hasAutoExpandedInitialRunRef = useRef(false);

  // Load runs on mount
  const loadRuns = useCallback(async () => {
    try {
      const data = await fetchAgentRuns(agentId, 50, projectId);
      setRuns(data);
    } catch (err) {
      addToast(`Failed to load runs: ${getErrorMessage(err)}`, "error");
    } finally {
      setIsLoadingRuns(false);
    }
  }, [agentId, projectId, addToast]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  // Poll for active runs
  const hasActiveRun = runs.some(r => r.status === "active");
  const selectedRunStatus = selectedRunId
    ? runs.find((run) => run.id === selectedRunId)?.status
    : undefined;
  useEffect(() => {
    if (!hasActiveRun) return;
    const interval = setInterval(() => {
      void loadRuns();
    }, 5000);
    return () => clearInterval(interval);
  }, [hasActiveRun, loadRuns]);

  // While a selected run is still active, subscribe to its log stream so the
  // expanded view tails updates without a refresh.  Mirrors the per-task log
  // SSE pattern in useAgentLogs.
  useEffect(() => {
    if (!selectedRunId) return;
    if (selectedRunStatus !== "active") return;

    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return subscribeSse(
      `/api/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(selectedRunId)}/logs/stream${query}`,
      {
        events: {
          "agent:log": (e) => {
            try {
              const entry: AgentLogEntry = JSON.parse(e.data);
              setRunLogs(prev => [...prev, entry]);
            } catch {
              // ignore malformed events
            }
          },
        },
      },
    );
  }, [selectedRunId, selectedRunStatus, agentId, projectId]);

  // Load run detail when a run is selected
  const handleRunClick = useCallback(async (runId: string) => {
    if (selectedRunId === runId) {
      setSelectedRunId(null);
      setRunLogs([]);
      setDetailRun(null);
      return;
    }
    setSelectedRunId(runId);
    setIsLoadingLogs(true);
    setIsLoadingDetail(true);
    setRunLogs([]);
    setDetailRun(null);
    try {
      const [logs, detail] = await Promise.all([
        fetchAgentRunLogs(agentId, runId, projectId),
        fetchAgentRunDetail(agentId, runId, projectId),
      ]);
      setRunLogs(logs);
      setDetailRun(detail);
    } catch (err) {
      addToast(`Failed to load run details: ${getErrorMessage(err)}`, "error");
      setRunLogs([]);
      setDetailRun(null);
    } finally {
      setIsLoadingLogs(false);
      setIsLoadingDetail(false);
    }
  }, [selectedRunId, agentId, projectId, addToast]);

  useEffect(() => {
    hasAutoExpandedInitialRunRef.current = false;
  }, [agentId, initialRunId, preferActiveRun]);

  useEffect(() => {
    if (runs.length === 0 || isLoadingRuns || hasAutoExpandedInitialRunRef.current) {
      return;
    }

    const runToExpand = initialRunId
      ? runs.find((run) => run.id === initialRunId)
      : (preferActiveRun ? runs.find((run) => run.status === "active") : null);

    hasAutoExpandedInitialRunRef.current = true;
    if (runToExpand) {
      void handleRunClick(runToExpand.id);
    }
  }, [initialRunId, preferActiveRun, runs, isLoadingRuns, handleRunClick]);

  const handleRunHeartbeat = async () => {
    try {
      await startAgentRun(agentId, projectId, { source: "on_demand", triggerDetail: "Triggered from dashboard" });
      addToast(`Heartbeat run started for ${agentName ?? agentId}`, "success");
      setIsLoadingRuns(true);
      void loadRuns();
    } catch (err) {
      addToast(`Failed to start heartbeat run: ${getErrorMessage(err)}`, "error");
    }
  };

  const handleStopRun = async () => {
    const shouldStop = await confirm({
      title: "Stop Active Run",
      message: "Stop the active run? The agent's work will be interrupted.",
      danger: true,
    });
    if (!shouldStop) {
      return;
    }

    try {
      await stopAgentRun(agentId, projectId);
      addToast("Run stopped", "success");
      setIsLoadingRuns(true);
      void loadRuns();
    } catch (err) {
      addToast(`Failed to stop run: ${getErrorMessage(err)}`, "error");
    }
  };

  const canRunHeartbeat = agentState === "active" || agentState === "idle";

  if (isLoadingRuns && runs.length === 0) {
    return (
      <div className="runs-tab">
        <div className="runs-loading-row">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-muted">Loading runs...</span>
        </div>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="runs-tab">
        {canRunHeartbeat && (
          <div className="runs-toolbar">
            <button
              className="btn btn--sm btn-task-create"
              onClick={() => void handleRunHeartbeat()}
              aria-label={`Run now for ${agentName ?? agentId}`}
            >
              <Activity size={14} /> Run Now
            </button>
          </div>
        )}
        <div className="runs-empty">
          <Activity size={48} opacity={0.3} />
          <p>No runs yet</p>
          <p className="text-muted">Heartbeat runs will appear here</p>
        </div>
      </div>
    );
  }

  const sortedRuns = [...runs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  const activeRuns = sortedRuns.filter(r => r.status === "active");
  const completedRuns = sortedRuns.filter(r => r.status !== "active");

  const renderUsage = (usage: { inputTokens: number; outputTokens: number; cachedTokens: number } | undefined) => {
    if (!usage) return null;
    return (
      <div className="run-usage">
        <span>Input: {usage.inputTokens.toLocaleString()}</span>
        <span>Output: {usage.outputTokens.toLocaleString()}</span>
        {usage.cachedTokens > 0 && <span>Cached: {usage.cachedTokens.toLocaleString()}</span>}
      </div>
    );
  };

  const renderRunCard = (run: AgentHeartbeatRun, index: number, isActive: boolean) => {
    const statusInfo = RUN_STATUS_ICONS[run.status] || RUN_STATUS_ICONS.completed;
    const StatusIcon = statusInfo.icon;
    const duration = run.endedAt 
      ? formatDuration(new Date(run.startedAt), new Date(run.endedAt))
      : "In progress";
    const isSelected = selectedRunId === run.id;

    return (
      <div key={run.id}>
        <div 
          className={cn("run-card", isActive && "run-card--active", isSelected && "run-card--selected", "run-card--clickable")}
          onClick={() => void handleRunClick(run.id)}
          role="button"
          tabIndex={0}
          aria-expanded={isSelected}
          aria-label={`${isActive ? "Active" : ""} run ${run.id.slice(0, 8)}, ${run.status}`}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              void handleRunClick(run.id);
            }
          }}
        >
          <div className="run-header">
            <div className="run-header-group">
              {isSelected ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {isActive ? (
                <span className="run-live-indicator">
                  <span className="live-dot" />
                  Live Run
                </span>
              ) : (
                <span className="run-id">#{index + 1} {run.id.slice(0, 8)}</span>
              )}
            </div>
            <div className="run-header-group">
              {run.invocationSource && (
                <span className="badge run-badge--compact">
                  {run.invocationSource}
                </span>
              )}
              {isActive && (
                <button
                  className="btn btn--sm btn--danger"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleStopRun();
                  }}
                  aria-label="Stop active run"
                >
                  <Square size={12} /> Stop
                </button>
              )}
              <span className={cn("run-status", run.status)}>
                <StatusIcon size={14} className={statusInfo.color} />
                {run.status}
              </span>
              {run.heartbeatProcedureSource === "custom" && (
                <span className="badge run-badge--compact">
                  Heartbeat: custom
                </span>
              )}
            </div>
          </div>
          <div className="run-details">
            <span>Started {relativeTime(run.startedAt)}</span>
            <span>•</span>
            <span>{duration}</span>
            {run.triggerDetail && (
              <>
                <span>•</span>
                <span className="text-muted">{run.triggerDetail}</span>
              </>
            )}
          </div>
        </div>
        {isSelected && (
          <div className="run-logs-container">
            {/* Execution Details */}
            {isLoadingDetail ? (
              <div className="run-details-loading-state">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-muted">Loading details...</span>
              </div>
            ) : detailRun && (
              <div className="run-output-sections">
                {/* System Prompt */}
                <div className="run-output-section">
                  <details>
                    <summary className="run-output-label run-output-summary">System Prompt</summary>
                    {detailRun.systemPrompt ? (
                      <pre className="run-output-panel">{detailRun.systemPrompt}</pre>
                    ) : (
                      <div className="text-muted run-output-empty">System prompt not captured for this run</div>
                    )}
                  </details>
                </div>

                {/* Execution Prompt */}
                <div className="run-output-section">
                  <details>
                    <summary className="run-output-label run-output-summary">Execution Prompt</summary>
                    {detailRun.executionPrompt ? (
                      <pre className="run-output-panel">{detailRun.executionPrompt}</pre>
                    ) : (
                      <div className="text-muted run-output-empty">Execution prompt not captured for this run</div>
                    )}
                  </details>
                </div>

                {/* Token Usage */}
                {detailRun.usageJson && (
                  <div className="run-output-section">
                    <div className="run-output-label">Token Usage</div>
                    {renderUsage(detailRun.usageJson)}
                  </div>
                )}

                {/* Output */}
                {detailRun.stdoutExcerpt && (
                  <div className="run-output-section">
                    <div className="run-output-label">Output</div>
                    <pre className="run-output-panel">
                      {detailRun.stdoutExcerpt.length > 2000
                        ? `${detailRun.stdoutExcerpt.slice(0, 2000)}\n\n... (truncated, ${detailRun.stdoutExcerpt.length} chars total)`
                        : detailRun.stdoutExcerpt}
                    </pre>
                  </div>
                )}

                {/* Errors */}
                {detailRun.stderrExcerpt && (
                  <div className="run-output-section">
                    <div className="run-output-label run-output-label--error">Errors</div>
                    <pre className="run-output-panel run-output-panel--error">{detailRun.stderrExcerpt}</pre>
                  </div>
                )}

                {/* Result */}
                {detailRun.resultJson && (
                  <div className="run-output-section">
                    <div className="run-output-label">Result</div>
                    <pre className="run-output-panel">{JSON.stringify(detailRun.resultJson, null, 2)}</pre>
                  </div>
                )}

                {/* Context */}
                {detailRun.contextSnapshot && Object.keys(detailRun.contextSnapshot).length > 0 && (
                  <div className="run-output-section">
                    <div className="run-output-label">Context</div>
                    <div className="run-context-grid">
                      {Object.entries(detailRun.contextSnapshot).map(([key, value]) => (
                        <span key={key} className="run-context-item">
                          <span className="text-muted">{key}:</span>{" "}
                          <span>{String(value)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* No output state */}
                {!detailRun.stdoutExcerpt && !detailRun.stderrExcerpt && !detailRun.resultJson && (
                  <div className="text-muted run-output-empty">No output captured</div>
                )}
              </div>
            )}

            {/* Run Logs */}
            <div className="run-agent-logs-section">
              <div className="run-output-label">Agent Logs</div>
              {isLoadingLogs ? (
                <div className="run-details-loading-state">
                  <Loader2 size={14} className="animate-spin" />
                  <span className="text-muted">Loading logs...</span>
                </div>
              ) : runLogs.length === 0 ? (
                <div className="text-muted run-output-empty">No logs available for this run</div>
              ) : (
                <AgentLogViewer entries={runLogs} loading={false} />
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="runs-tab">
      {canRunHeartbeat && (
        <div className="runs-toolbar runs-toolbar--between">
          <span className="runs-toolbar-meta">
            {runs.length} run{runs.length !== 1 ? "s" : ""}
            {hasActiveRun && <span className="run-live-indicator run-live-indicator--with-margin"><span className="live-dot" />Live</span>}
          </span>
          <div className="run-header-group">
            {hasActiveRun && (
              <button
                className="btn btn--sm btn--danger"
                onClick={() => void handleStopRun()}
                aria-label={`Stop active run for ${agentName ?? agentId}`}
              >
                <Square size={14} /> Stop Run
              </button>
            )}
            <button
              className="btn btn--sm btn-task-create"
              onClick={() => void handleRunHeartbeat()}
              aria-label={`Run now for ${agentName ?? agentId}`}
            >
              <Activity size={14} /> Run Now
            </button>
          </div>
        </div>
      )}
      {activeRuns.map((run, i) => renderRunCard(run, i, true))}
      {completedRuns.map((run, i) => renderRunCard(run, activeRuns.length + i, false))}
    </div>
  );
}

function formatDuration(start: Date, end: Date): string {
  const diff = Math.floor((end.getTime() - start.getTime()) / 1000);
  
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
}

const TASK_COLUMN_LABELS: Record<Task["column"], string> = {
  triage: "Triage",
  todo: "Todo",
  "in-progress": "In Progress",
  "in-review": "In Review",
  done: "Done",
  archived: "Archived",
};

function truncateTaskLabel(task: Task): string {
  const source = task.title?.trim() || task.description?.trim() || task.id;
  return source.length > 80 ? `${source.slice(0, 77)}...` : source;
}

function TasksTab({
  agentId,
  projectId,
  addToast,
}: {
  agentId: string;
  projectId?: string;
  addToast: (msg: string, type?: "success" | "error") => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    void fetchAgentTasks(agentId, projectId)
      .then((assignedTasks) => {
        if (!cancelled) {
          setTasks(assignedTasks);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setTasks([]);
          addToast(`Failed to load assigned tasks: ${getErrorMessage(err)}`, "error");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, projectId, addToast]);

  if (isLoading) {
    return (
      <div className="agent-tasks-empty">
        <Loader2 size={16} className="animate-spin" />
        <p>Loading assigned tasks...</p>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="agent-tasks-empty">
        <ListChecks size={18} />
        <p>No tasks assigned to this agent</p>
      </div>
    );
  }

  return (
    <div className="agent-tasks-list">
      {tasks.map((task) => (
        <a key={task.id} className="agent-task-item" href={`/tasks/${task.id}`}>
          <div className="agent-task-row">
            <span className="agent-task-id">{task.id}</span>
            <span className={`agent-task-column column-${task.column}`}>{TASK_COLUMN_LABELS[task.column]}</span>
          </div>
          <div className="agent-task-title" title={task.title || task.description || task.id}>
            {truncateTaskLabel(task)}
          </div>
          <div className="agent-task-status">
            {task.status ?? "idle"} · Updated {relativeTime(task.updatedAt)}
          </div>
        </a>
      ))}
    </div>
  );
}

// ── Config Tab ─────────────────────────────────────────────────────────────

/** Shape of a single advanced setting field stored in agent.metadata */
interface AdvancedSettingField {
  key: string;
  label: string;
  type: "text" | "number" | "select";
  placeholder?: string;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  /** Minimum value for number fields */
  min?: number;
  /** Maximum value for number fields */
  max?: number;
}

/** Well-known advanced setting definitions backed by agent.metadata */
const ADVANCED_SETTINGS: AdvancedSettingField[] = [
  {
    key: "maxRetries",
    label: "Max Retries",
    type: "number",
    placeholder: "3",
    hint: "Maximum number of automatic retries on task failure (0–10, default 3)",
    min: 0,
    max: 10,
  },
  {
    key: "timeoutMs",
    label: "Task Timeout (ms)",
    type: "number",
    placeholder: "600000",
    hint: "Maximum time in ms before a task is considered timed out (minimum 60000ms, default 600000ms)",
    min: 60000,
    max: 86400000,
  },
  {
    key: "logLevel",
    label: "Log Level",
    type: "select",
    hint: "Verbosity of agent log output",
    options: [
      { value: "debug", label: "Debug" },
      { value: "info", label: "Info" },
      { value: "warn", label: "Warning" },
      { value: "error", label: "Error" },
    ],
  },
];

/** Validation errors keyed by setting key */
type ValidationErrors = Record<string, string>;

function validateAdvancedSettings(
  values: Record<string, string>,
): ValidationErrors {
  const errors: ValidationErrors = {};

  for (const field of ADVANCED_SETTINGS) {
    const raw = values[field.key]?.trim();

    // Empty is fine — it means "use default"
    if (!raw) continue;

    if (field.type === "number") {
      const num = Number(raw);
      if (Number.isNaN(num) || !Number.isFinite(num)) {
        errors[field.key] = `"${field.label}" must be a valid number`;
        continue;
      }
      if (field.min !== undefined && num < field.min) {
        errors[field.key] = `"${field.label}" must be at least ${field.min.toLocaleString()}`;
      }
      if (field.max !== undefined && num > field.max) {
        errors[field.key] = `"${field.label}" must be at most ${field.max.toLocaleString()}`;
      }
    }

    if (field.type === "select") {
      const validOptions = field.options?.map((o) => o.value) ?? [];
      if (validOptions.length > 0 && !validOptions.includes(raw)) {
        errors[field.key] = `"${field.label}" must be one of: ${validOptions.join(", ")}`;
      }
    }
  }

  return errors;
}

function SoulTab({
  agent,
  projectId,
  addToast,
  onSaved,
}: {
  agent: AgentDetail;
  projectId?: string;
  addToast: (message: string, type?: "success" | "error") => void;
  onSaved: () => Promise<void>;
}) {
  const [soul, setSoul] = useState(agent.soul ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const justSavedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSoul(agent.soul ?? "");
    setJustSaved(false);
    setShowPreview(false);
  }, [agent.id, agent.soul]);

  useEffect(() => {
    return () => {
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
    };
  }, []);

  const hasChanges = soul !== (agent.soul ?? "");

  const handleSave = async () => {
    if (soul.length > 10000) {
      addToast("Soul must be at most 10,000 characters", "error");
      return;
    }

    setIsSaving(true);
    try {
      await updateAgentSoul(agent.id, soul, projectId);
      addToast("Soul saved", "success");
      setJustSaved(true);
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
      justSavedTimeoutRef.current = setTimeout(() => setJustSaved(false), 3000);
      await onSaved();
    } catch (err) {
      addToast(`Failed to save soul: ${getErrorMessage(err)}`, "error");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="config-tab">
      <div className="config-section">
        <h3>Soul</h3>
        <p className="config-description">
          Define this agent&apos;s personality and identity.
        </p>

        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="agent-soul">Agent Soul</label>
            <div className="agent-content-toolbar">
              <div className="agent-content-mode-toggle">
                <button
                  className={`btn btn-sm ${!showPreview ? "btn-primary" : ""}`}
                  onClick={() => setShowPreview(false)}
                  disabled={!showPreview}
                  aria-label="Edit mode"
                >
                  <FileEdit size={14} />
                  Edit
                </button>
                <button
                  className={`btn btn-sm ${showPreview ? "btn-primary" : ""}`}
                  onClick={() => setShowPreview(true)}
                  disabled={showPreview}
                  aria-label="Preview mode"
                >
                  <Eye size={14} />
                  Preview
                </button>
              </div>
            </div>
            {showPreview ? (
              soul.trim() ? (
                <div className="agent-content-preview markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {soul}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="agent-content-preview agent-content-placeholder">
                  No soul defined yet. Switch to Edit mode to define the agent&apos;s personality.
                </div>
              )
            ) : (
              <textarea
                id="agent-soul"
                className="input config-textarea-mono"
                rows={12}
                placeholder="Describe this agent's personality, tone, and behavioral traits..."
                value={soul}
                onChange={(e) => {
                  setSoul(e.target.value);
                  setJustSaved(false);
                }}
              />
            )}
            {!showPreview && (
              <span className="config-hint">Defines the agent&apos;s character and identity. Max 10,000 characters.</span>
            )}
          </div>
        </div>

        {!showPreview && (
          <div className="config-actions">
            <button
              className="btn btn-task-create"
              disabled={!hasChanges || isSaving}
              onClick={() => void handleSave()}
            >
              {isSaving ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <CheckCircle size={16} />
                  Save Soul
                </>
              )}
            </button>
            {!hasChanges && justSaved && (
              <span className="config-saved-indicator">
                <CheckCircle size={14} />
                Soul saved
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MemoryTab({
  agent,
  projectId,
  addToast,
  onSaved,
}: {
  agent: AgentDetail;
  projectId?: string;
  addToast: (message: string, type?: "success" | "error") => void;
  onSaved: () => Promise<void>;
}) {
  const [memory, setMemory] = useState(agent.memory ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const [memoryFiles, setMemoryFiles] = useState<MemoryFileInfo[]>([]);
  const [memoryFilesLoading, setMemoryFilesLoading] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [selectedFileContent, setSelectedFileContent] = useState("");
  const [selectedFileDirty, setSelectedFileDirty] = useState(false);
  const [selectedFileLoading, setSelectedFileLoading] = useState(false);
  const [savingSelectedFile, setSavingSelectedFile] = useState(false);
  const [selectedFileJustSaved, setSelectedFileJustSaved] = useState(false);
  const [fileSwitchHint, setFileSwitchHint] = useState("");
  const justSavedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedFileJustSavedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isReadOnly = agent.state === "running";
  const hasInlineChanges = memory !== (agent.memory ?? "");

  const selectedMemoryFile = useMemo(
    () => memoryFiles.find((file) => file.path === selectedFilePath),
    [memoryFiles, selectedFilePath],
  );

  const selectedLayerDescription = selectedMemoryFile
    ? MEMORY_LAYER_DESCRIPTIONS[selectedMemoryFile.layer]
    : "Select a memory file to view or edit.";

  const loadSelectedMemoryFile = useCallback(async (path: string) => {
    setSelectedFileLoading(true);
    try {
      const result = await fetchAgentMemoryFile(agent.id, path, projectId);
      setSelectedFilePath(result.path);
      setSelectedFileContent(result.content);
      setSelectedFileDirty(false);
      setSelectedFileJustSaved(false);
    } catch (err) {
      addToast(`Failed to load agent memory file: ${getErrorMessage(err)}`, "error");
    } finally {
      setSelectedFileLoading(false);
    }
  }, [agent.id, projectId, addToast]);

  const loadMemoryFiles = useCallback(async (preferredPath = "") => {
    setMemoryFilesLoading(true);
    try {
      const { files } = await fetchAgentMemoryFiles(agent.id, projectId);
      setMemoryFiles(files);

      if (files.length === 0) {
        setSelectedFilePath("");
        setSelectedFileContent("");
        setSelectedFileDirty(false);
        return;
      }

      const nextPath = pickDefaultAgentMemoryPath(files, preferredPath);
      await loadSelectedMemoryFile(nextPath);
    } catch (err) {
      addToast(`Failed to load memory files: ${getErrorMessage(err)}`, "error");
      setMemoryFiles([]);
      setSelectedFilePath("");
      setSelectedFileContent("");
      setSelectedFileDirty(false);
    } finally {
      setMemoryFilesLoading(false);
    }
  }, [agent.id, projectId, addToast, loadSelectedMemoryFile]);

  useEffect(() => {
    setMemory(agent.memory ?? "");
    setJustSaved(false);
    setShowPreview(false);
    setFileSwitchHint("");
    setSelectedFileJustSaved(false);
    void loadMemoryFiles();
  }, [agent.id, agent.memory, loadMemoryFiles]);

  useEffect(() => {
    return () => {
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
      if (selectedFileJustSavedTimeoutRef.current) {
        clearTimeout(selectedFileJustSavedTimeoutRef.current);
      }
    };
  }, []);

  const handleSaveInlineMemory = async () => {
    if (memory.length > 50000) {
      addToast("Memory must be at most 50,000 characters", "error");
      return;
    }

    setIsSaving(true);
    try {
      await updateAgentMemory(agent.id, memory, projectId);
      addToast("Memory saved", "success");
      setJustSaved(true);
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
      justSavedTimeoutRef.current = setTimeout(() => setJustSaved(false), 3000);
      await onSaved();
    } catch (err) {
      addToast(`Failed to save memory: ${getErrorMessage(err)}`, "error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSelectMemoryFile = async (path: string) => {
    if (!path || path === selectedFilePath) {
      return;
    }
    if (selectedFileDirty) {
      setFileSwitchHint("Save the current file before switching to another file.");
      return;
    }

    setFileSwitchHint("");
    await loadSelectedMemoryFile(path);
  };

  const handleSaveSelectedMemoryFile = async () => {
    if (!selectedFilePath) {
      return;
    }

    setSavingSelectedFile(true);
    try {
      await saveAgentMemoryFile(agent.id, selectedFilePath, selectedFileContent, projectId);
      setSelectedFileDirty(false);
      setSelectedFileJustSaved(true);
      if (selectedFileJustSavedTimeoutRef.current) {
        clearTimeout(selectedFileJustSavedTimeoutRef.current);
      }
      selectedFileJustSavedTimeoutRef.current = setTimeout(() => setSelectedFileJustSaved(false), 3000);
      setFileSwitchHint("");
      await loadMemoryFiles(selectedFilePath);
      addToast("Agent memory file saved", "success");
    } catch (err) {
      addToast(`Failed to save agent memory file: ${getErrorMessage(err)}`, "error");
    } finally {
      setSavingSelectedFile(false);
    }
  };

  return (
    <div className="config-tab">
      <div className="config-section">
        <h3>Agent Memory</h3>
        <p className="config-description">
          Store context that belongs to this agent only. Workspace memory, daily notes, dreams, and qmd search live in project settings under Project Memory.
        </p>
        {isReadOnly && (
          <p className="config-hint config-hint--block-spacing">
            Read-only while this agent is running.
          </p>
        )}

        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="agent-memory">Inline Memory</label>
            <span className="config-hint config-hint--block">
              Short-form memory stored directly on the agent record and injected into prompts.
            </span>
            <div className="agent-content-toolbar">
              <div className="agent-content-mode-toggle">
                {!isReadOnly && (
                  <button
                    className={`btn btn-sm ${!showPreview ? "btn-primary" : ""}`}
                    onClick={() => setShowPreview(false)}
                    disabled={!showPreview}
                    aria-label="Edit mode"
                  >
                    <FileEdit size={14} />
                    Edit
                  </button>
                )}
                <button
                  className={`btn btn-sm ${showPreview ? "btn-primary" : ""}`}
                  onClick={() => setShowPreview(true)}
                  disabled={showPreview}
                  aria-label="Preview mode"
                >
                  <Eye size={14} />
                  Preview
                </button>
              </div>
            </div>
            {showPreview ? (
              memory.trim() ? (
                <div className="agent-content-preview markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {memory}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="agent-content-preview agent-content-placeholder">
                  No agent memory defined yet. Switch to Edit mode to add memory content.
                </div>
              )
            ) : (
              <textarea
                id="agent-memory"
                aria-label="Agent Memory"
                className="input config-textarea-mono"
                rows={10}
                placeholder="Durable preferences, operating habits, and context this agent should carry across tasks..."
                value={memory}
                readOnly={isReadOnly}
                onChange={(e) => {
                  setMemory(e.target.value);
                  setJustSaved(false);
                }}
              />
            )}
            {!showPreview && (
              <span className="config-hint">This is the inline memory field on the agent JSON record. Max 50,000 characters.</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="agent-memory-file-select">Memory Files</label>
            <span className="config-hint config-hint--block">
              Full OpenClaw memory files at <code>agent/{agent.name || agent.id}/memory/</code> (MEMORY.md, DREAMS.md, and daily notes).
            </span>

            <select
              id="agent-memory-file-select"
              className="select"
              value={selectedFilePath}
              disabled={memoryFilesLoading || selectedFileLoading || savingSelectedFile || memoryFiles.length === 0}
              onChange={(e) => {
                void handleSelectMemoryFile(e.target.value);
              }}
            >
              {memoryFiles.length === 0 ? (
                <option value="">No memory files found</option>
              ) : (
                memoryFiles.map((file) => (
                  <option key={file.path} value={file.path}>
                    {MEMORY_LAYER_NAMES[file.layer]} • {file.label}
                  </option>
                ))
              )}
            </select>

            {memoryFilesLoading && (
              <span className="config-hint config-hint--inline-loader">
                <Loader2 size={14} className="animate-spin" />
                Loading memory files…
              </span>
            )}

            {selectedMemoryFile && (
              <div className="config-hint config-hint--top-spacing">
                <strong>{MEMORY_LAYER_NAMES[selectedMemoryFile.layer]}</strong> · {selectedLayerDescription}
                <br />
                {selectedMemoryFile.size.toLocaleString()} bytes · Updated {relativeTime(selectedMemoryFile.updatedAt)}
              </div>
            )}

            <textarea
              className="input config-textarea-mono config-textarea-top-spacing"
              rows={14}
              placeholder="Select a memory file to view and edit its content..."
              value={selectedFileContent}
              readOnly={isReadOnly || !selectedFilePath || selectedFileLoading}
              onChange={(e) => {
                setSelectedFileContent(e.target.value);
                setSelectedFileDirty(true);
                setSelectedFileJustSaved(false);
                setFileSwitchHint("");
              }}
            />

            {selectedFileLoading && (
              <span className="config-hint config-hint--inline-loader">
                <Loader2 size={14} className="animate-spin" />
                Loading file content…
              </span>
            )}

            {fileSwitchHint && (
              <span className="config-hint config-hint--top-spacing config-hint--block">
                {fileSwitchHint}
              </span>
            )}
          </div>
        </div>

        <div className="config-actions">
          {!showPreview && (
            <button
              className="btn btn-task-create"
              disabled={!hasInlineChanges || isSaving || isReadOnly}
              onClick={() => void handleSaveInlineMemory()}
            >
              {isSaving ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <CheckCircle size={16} />
                  Save Memory
                </>
              )}
            </button>
          )}
          <button
            className="btn"
            disabled={!selectedFileDirty || savingSelectedFile || !selectedFilePath || isReadOnly}
            onClick={() => void handleSaveSelectedMemoryFile()}
          >
            {savingSelectedFile ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Saving file…
              </>
            ) : (
              <>
                <CheckCircle size={16} />
                Save Memory File
              </>
            )}
          </button>
          {!hasInlineChanges && justSaved && (
            <span className="config-saved-indicator">
              <CheckCircle size={14} />
              Memory saved
            </span>
          )}
          {!selectedFileDirty && selectedFileJustSaved && (
            <span className="config-saved-indicator">
              <CheckCircle size={14} />
              Memory file saved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function InstructionsTab({
  agent,
  projectId,
  addToast,
  onSaved,
}: {
  agent: AgentDetail;
  projectId?: string;
  addToast: (message: string, type?: "success" | "error") => void;
  onSaved: () => Promise<void>;
}) {
  // Inline instructions state
  const [instructionsText, setInstructionsText] = useState(agent.instructionsText ?? "");
  const [instructionsPath, setInstructionsPath] = useState(agent.instructionsPath ?? "");
  const [showPreview, setShowPreview] = useState(false);

  // File content state (when instructionsPath is set)
  const [fileContent, setFileContent] = useState("");
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [fileContentDirty, setFileContentDirty] = useState(false);

  // Save state
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingFile, setIsSavingFile] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [justSavedFile, setJustSavedFile] = useState(false);
  const justSavedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justSavedFileTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load file content when instructionsPath changes
  useEffect(() => {
    const path = instructionsPath.trim();
    if (!path) {
      setFileContent("");
      setFileContentDirty(false);
      return;
    }

    setIsLoadingFile(true);
    fetchWorkspaceFileContent("project", path)
      .then((data) => {
        setFileContent(data.content);
        setFileContentDirty(false);
      })
      .catch((err) => {
        // ENOENT means file doesn't exist yet - treat as empty "new file" state
        const msg = getErrorMessage(err);
        if (msg.includes("ENOENT") || msg.includes("Not found") || msg.includes("not found")) {
          setFileContent("");
          setFileContentDirty(false);
        } else {
          addToast(`Failed to load instructions file: ${msg}`, "error");
          setFileContent("");
        }
      })
      .finally(() => {
        setIsLoadingFile(false);
      });
  }, [instructionsPath, addToast]);

  // Sync with agent data changes
  useEffect(() => {
    setInstructionsText(agent.instructionsText ?? "");
    setInstructionsPath(agent.instructionsPath ?? "");
    setJustSaved(false);
    setJustSavedFile(false);
    setShowPreview(false);
  }, [agent.id, agent.instructionsText, agent.instructionsPath]);

  useEffect(() => {
    return () => {
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
      if (justSavedFileTimeoutRef.current) {
        clearTimeout(justSavedFileTimeoutRef.current);
      }
    };
  }, []);

  const hasInstructionsChanges = (() => {
    const currentText = instructionsText ?? "";
    const persistedText = agent.instructionsText ?? "";
    const currentPath = instructionsPath?.trim() ?? "";
    const persistedPath = agent.instructionsPath?.trim() ?? "";
    return currentText !== persistedText || currentPath !== persistedPath;
  })();

  const handleSaveInstructions = async () => {
    setIsSaving(true);
    try {
      await updateAgentInstructions(
        agent.id,
        {
          instructionsText: instructionsText || undefined,
          instructionsPath: instructionsPath.trim() || undefined,
        },
        projectId,
      );
      addToast("Instructions saved", "success");
      setJustSaved(true);
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
      justSavedTimeoutRef.current = setTimeout(() => setJustSaved(false), 3000);
      await onSaved();
    } catch (err) {
      addToast(`Failed to save instructions: ${getErrorMessage(err)}`, "error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveFile = async () => {
    const path = instructionsPath.trim();
    if (!path) {
      addToast("No instructions file path set", "error");
      return;
    }

    setIsSavingFile(true);
    try {
      await saveWorkspaceFileContent("project", path, fileContent);
      addToast("Instructions file saved", "success");
      setFileContentDirty(false);
      setJustSavedFile(true);
      if (justSavedFileTimeoutRef.current) {
        clearTimeout(justSavedFileTimeoutRef.current);
      }
      justSavedFileTimeoutRef.current = setTimeout(() => setJustSavedFile(false), 3000);
    } catch (err) {
      addToast(`Failed to save instructions file: ${getErrorMessage(err)}`, "error");
    } finally {
      setIsSavingFile(false);
    }
  };

  const hasFilePath = !!instructionsPath.trim();

  return (
    <div className="config-tab">
      <div className="config-section">
        <h3>Custom Instructions</h3>
        <p className="config-description">
          Append custom instructions to this agent&apos;s system prompt at execution time. Use this to customize behavior, coding style, or project conventions without modifying built-in prompts.
        </p>

        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="instructions-text">Inline Instructions</label>
            <div className="agent-content-toolbar">
              <div className="agent-content-mode-toggle">
                <button
                  className={`btn btn-sm ${!showPreview ? "btn-primary" : ""}`}
                  onClick={() => setShowPreview(false)}
                  disabled={!showPreview}
                  aria-label="Edit mode"
                  data-testid="instructions-edit-toggle"
                >
                  <FileEdit size={14} />
                  Edit
                </button>
                <button
                  className={`btn btn-sm ${showPreview ? "btn-primary" : ""}`}
                  onClick={() => setShowPreview(true)}
                  disabled={showPreview}
                  aria-label="Preview mode"
                  data-testid="instructions-preview-toggle"
                >
                  <Eye size={14} />
                  Preview
                </button>
              </div>
            </div>
            {showPreview ? (
              instructionsText.trim() ? (
                <div className="agent-content-preview markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {instructionsText}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="agent-content-preview agent-content-placeholder">
                  No inline instructions defined yet. Switch to Edit mode to add instructions.
                </div>
              )
            ) : (
              <textarea
                id="instructions-text"
                className="input"
                rows={10}
                placeholder="Enter custom instructions to append to this agent's system prompt..."
                value={instructionsText}
                onChange={(e) => {
                  setInstructionsText(e.target.value);
                  setJustSaved(false);
                }}
              />
            )}
            {!showPreview && (
              <span className="config-hint">Markdown formatting supported. Max 50,000 characters.</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="instructions-path">Instructions File Path</label>
            <input
              id="instructions-path"
              type="text"
              className="input"
              placeholder="e.g., .fusion/agents/my-agent-instructions.md"
              value={instructionsPath}
              onChange={(e) => {
                setInstructionsPath(e.target.value);
                setJustSaved(false);
              }}
            />
            <span className="config-hint">Path to a .md file (relative to project root). Contents are read and appended at execution time.</span>
          </div>
        </div>

        {!showPreview && (
          <div className="config-actions">
            <button
              className="btn btn-task-create"
              disabled={!hasInstructionsChanges || isSaving}
              onClick={() => void handleSaveInstructions()}
            >
              {isSaving ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <CheckCircle size={16} />
                  Save Instructions
                </>
              )}
            </button>
            {!hasInstructionsChanges && justSaved && (
              <span className="config-saved-indicator">
                <CheckCircle size={14} />
                Instructions saved
              </span>
            )}
          </div>
        )}
      </div>

      {hasFilePath && (
        <div className="config-section">
          <h3>Instructions File Editor</h3>
          <p className="config-description">
            Edit the instructions file directly. Changes are saved separately from the path configuration.
          </p>

          <div className="config-fields">
            <div className="config-field">
              <div className="config-inline-header">
                <label htmlFor="instructions-file-content">File Content</label>
                {isLoadingFile && (
                  <span className="config-hint config-hint--inline-tight">
                    <Loader2 size={12} className="animate-spin" />
                    Loading...
                  </span>
                )}
                {fileContentDirty && !isLoadingFile && (
                  <span className="config-hint config-hint--warning">
                    Unsaved changes
                  </span>
                )}
              </div>
              <textarea
                id="instructions-file-content"
                className="input config-textarea-mono"
                rows={20}
                placeholder="File content will appear here when loaded..."
                value={fileContent}
                readOnly={isLoadingFile}
                onChange={(e) => {
                  setFileContent(e.target.value);
                  setFileContentDirty(true);
                  setJustSavedFile(false);
                }}
              />
              <span className="config-hint">Edit the markdown file content directly. Save separately using the button below.</span>
            </div>
          </div>

          <div className="config-actions">
            <button
              className="btn btn-task-create"
              disabled={!fileContentDirty || isSavingFile}
              onClick={() => void handleSaveFile()}
            >
              {isSavingFile ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <CheckCircle size={16} />
                  Save File
                </>
              )}
            </button>
            {!fileContentDirty && justSavedFile && (
              <span className="config-saved-indicator">
                <CheckCircle size={14} />
                File saved
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function deriveHeartbeatValues(runtimeConfig: AgentDetail["runtimeConfig"] | undefined): Record<string, string> {
  const rc = runtimeConfig ?? {};
  const nextValues: Record<string, string> = {};

  if (rc.heartbeatIntervalMs !== undefined && rc.heartbeatIntervalMs !== null) {
    nextValues.heartbeatIntervalMs = String(Number(rc.heartbeatIntervalMs) / 1000);
  }
  if (rc.heartbeatTimeoutMs !== undefined && rc.heartbeatTimeoutMs !== null) {
    nextValues.heartbeatTimeoutMs = String(Number(rc.heartbeatTimeoutMs) / 1000);
  }
  if (rc.maxConcurrentRuns !== undefined && rc.maxConcurrentRuns !== null) {
    nextValues.maxConcurrentRuns = String(rc.maxConcurrentRuns);
  }
  if (rc.messageResponseMode === "immediate" || rc.messageResponseMode === "on-heartbeat") {
    nextValues.messageResponseMode = rc.messageResponseMode;
  }

  return nextValues;
}

function deriveHeartbeatEnabled(runtimeConfig: AgentDetail["runtimeConfig"] | undefined): boolean {
  return runtimeConfig?.enabled !== false;
}

function deriveBudgetValues(runtimeConfig: AgentDetail["runtimeConfig"] | undefined): Record<string, string> {
  const bc = (runtimeConfig ?? {}).budgetConfig as Record<string, unknown> | undefined;
  const nextValues: Record<string, string> = {};

  if (!bc) {
    return nextValues;
  }

  if (bc.tokenBudget !== undefined && bc.tokenBudget !== null) {
    nextValues.tokenBudget = String(bc.tokenBudget);
  }
  if (bc.usageThreshold !== undefined && bc.usageThreshold !== null) {
    // Convert fraction (0-1) to percentage (0-100) for display
    nextValues.usageThreshold = String(Number(bc.usageThreshold) * 100);
  }
  if (bc.budgetPeriod !== undefined && bc.budgetPeriod !== null) {
    nextValues.budgetPeriod = String(bc.budgetPeriod);
  }
  if (bc.resetDay !== undefined && bc.resetDay !== null) {
    nextValues.resetDay = String(bc.resetDay);
  }

  return nextValues;
}

function HeartbeatProcedureSection({
  agent,
  projectId,
  addToast,
  onSaved,
}: {
  agent: AgentDetail;
  projectId?: string;
  addToast: (message: string, type?: "success" | "error") => void;
  onSaved: () => Promise<void>;
}) {
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [showFileViewer, setShowFileViewer] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [isSavingFile, setIsSavingFile] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [fileContent, setFileContent] = useState("");
  const [fileContentDirty, setFileContentDirty] = useState(false);
  const [fileLoadError, setFileLoadError] = useState<string | null>(null);
  const [justSavedFile, setJustSavedFile] = useState(false);
  const justSavedFileTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPath = agent.heartbeatProcedurePath?.trim();
  const canonicalDefaultPath = `.fusion/agents/${agent.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || agent.id.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "agent"}-${agent.id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent"}/HEARTBEAT.md`;
  const legacyDefaultPath = `.fusion/agents/${agent.id}/HEARTBEAT.md`;
  const safeId = agent.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const onDefault = Boolean(
    currentPath
      && (currentPath === canonicalDefaultPath
        || currentPath === legacyDefaultPath
        || new RegExp(`^\\.fusion/agents/[^/]+-${safeId}/HEARTBEAT\\.md$`).test(currentPath)),
  );
  const hasFilePath = Boolean(currentPath);

  const loadHeartbeatFile = useCallback(async (path: string) => {
    setIsLoadingFile(true);
    setFileLoadError(null);
    try {
      const data = await fetchWorkspaceFileContent("project", path, projectId);
      setFileContent(data.content);
      setFileContentDirty(false);
    } catch (err) {
      const message = getErrorMessage(err);
      setFileLoadError(message);
      addToast(`Failed to load heartbeat procedure file: ${message}`, "error");
    } finally {
      setIsLoadingFile(false);
    }
  }, [addToast, projectId]);

  useEffect(() => {
    setShowFileViewer(false);
    setShowPreview(false);
    setFileContent("");
    setFileContentDirty(false);
    setFileLoadError(null);
    setIsLoadingFile(false);
    setIsSavingFile(false);
    setJustSavedFile(false);
  }, [agent.id, currentPath]);

  useEffect(() => {
    return () => {
      if (justSavedFileTimeoutRef.current) {
        clearTimeout(justSavedFileTimeoutRef.current);
      }
    };
  }, []);

  const handleOpenViewer = async () => {
    if (!currentPath) return;
    setShowFileViewer(true);
    await loadHeartbeatFile(currentPath);
  };

  const handleSaveFile = async () => {
    if (!currentPath) return;
    setIsSavingFile(true);
    try {
      await saveWorkspaceFileContent("project", currentPath, fileContent, projectId);
      setFileContentDirty(false);
      setJustSavedFile(true);
      addToast("Heartbeat procedure file saved", "success");
      if (justSavedFileTimeoutRef.current) {
        clearTimeout(justSavedFileTimeoutRef.current);
      }
      justSavedFileTimeoutRef.current = setTimeout(() => setJustSavedFile(false), 3000);
    } catch (err) {
      addToast(`Failed to save heartbeat procedure file: ${getErrorMessage(err)}`, "error");
    } finally {
      setIsSavingFile(false);
    }
  };

  const handleUpgrade = async () => {
    setIsUpgrading(true);
    try {
      const result = await upgradeAgentHeartbeatProcedure(agent.id, projectId);
      addToast(
        result.procedureFileSeeded
          ? `Heartbeat procedure file ready at ${result.heartbeatProcedurePath}`
          : `Heartbeat procedure path set to ${result.heartbeatProcedurePath}`,
        "success",
      );
      await onSaved();
    } catch (err) {
      addToast(`Failed to upgrade heartbeat procedure: ${getErrorMessage(err)}`, "error");
    } finally {
      setIsUpgrading(false);
    }
  };

  return (
    <div className="config-section">
      <h3>Heartbeat Procedure</h3>
      <p className="config-description">
        The per-tick procedure this agent runs every wake. Defaults to a per-agent
        markdown file (for example <code>.fusion/agents/ceo-agent2736/HEARTBEAT.md</code>)
        that you can edit. Legacy id-only default paths remain valid. Resets on every tick —
        no need to restart the agent after editing.
      </p>
      <div className="config-fields">
        <div className="config-field">
          <span className="config-hint">
            Current path: <code>{currentPath || "(none — using built-in default)"}</code>
          </span>
          {hasFilePath && (
            <div className="heartbeat-procedure-actions">
              <button
                className="btn btn-sm"
                onClick={() => void handleOpenViewer()}
                disabled={isLoadingFile}
              >
                {isLoadingFile ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Loading file…
                  </>
                ) : (
                  <>
                    <FileText size={16} />
                    View Heartbeat Markdown
                  </>
                )}
              </button>
            </div>
          )}
        </div>
        <div className="config-field">
          <button
            className="btn"
            disabled={isUpgrading || onDefault}
            onClick={() => void handleUpgrade()}
            aria-label="Upgrade agent to default heartbeat procedure file"
          >
            {isUpgrading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Upgrading…
              </>
            ) : onDefault ? (
              <>
                <CheckCircle size={16} />
                Already on default
              </>
            ) : (
              "Upgrade to Default Heartbeat Procedure"
            )}
          </button>
          <span className="config-hint">
            Sets <code>heartbeatProcedurePath</code> to{" "}
            <code>{canonicalDefaultPath}</code>
            {" "}and seeds the file from the built-in template if it doesn't exist.
            Each agent gets its own per-agent file, so edits stay scoped to this agent.
            Operator edits to the file are preserved.
          </span>
        </div>
      </div>

      {showFileViewer && hasFilePath && currentPath && (
        <div className="config-fields heartbeat-procedure-viewer">
          <div className="config-field">
            <label htmlFor="heartbeat-procedure-file-content">Heartbeat Procedure File</label>
            <div className="agent-content-toolbar">
              <div className="agent-content-mode-toggle">
                <button
                  className={`btn btn-sm ${!showPreview ? "btn-primary" : ""}`}
                  onClick={() => setShowPreview(false)}
                  disabled={!showPreview}
                  aria-label="Heartbeat file edit mode"
                >
                  <FileEdit size={14} />
                  Edit
                </button>
                <button
                  className={`btn btn-sm ${showPreview ? "btn-primary" : ""}`}
                  onClick={() => setShowPreview(true)}
                  disabled={showPreview}
                  aria-label="Heartbeat file preview mode"
                >
                  <Eye size={14} />
                  Preview
                </button>
              </div>
              {isLoadingFile && (
                <span className="config-hint heartbeat-procedure-status">
                  <Loader2 size={12} className="animate-spin" />
                  Loading...
                </span>
              )}
              {fileContentDirty && !isLoadingFile && (
                <span className="config-hint heartbeat-procedure-status heartbeat-procedure-status--warning">
                  Unsaved changes
                </span>
              )}
            </div>
            {showPreview ? (
              fileContent.trim() ? (
                <div className="agent-content-preview markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{fileContent}</ReactMarkdown>
                </div>
              ) : (
                <div className="agent-content-preview agent-content-placeholder">
                  No heartbeat procedure markdown content yet.
                </div>
              )
            ) : (
              <textarea
                id="heartbeat-procedure-file-content"
                className="input"
                rows={16}
                value={fileContent}
                readOnly={isLoadingFile}
                placeholder="Heartbeat procedure markdown file content will appear here..."
                onChange={(e) => {
                  setFileContent(e.target.value);
                  setFileContentDirty(true);
                  setJustSavedFile(false);
                }}
              />
            )}
            {fileLoadError && (
              <span className="config-error">Failed to load file: {fileLoadError}</span>
            )}
            <span className="config-hint">
              This editor writes directly to <code>{currentPath}</code>.
            </span>
          </div>
          {!showPreview && (
            <div className="config-actions">
              <button
                className="btn btn-task-create"
                disabled={!fileContentDirty || isSavingFile || isLoadingFile}
                onClick={() => void handleSaveFile()}
              >
                {isSavingFile ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <CheckCircle size={16} />
                    Save Heartbeat File
                  </>
                )}
              </button>
              {!fileContentDirty && justSavedFile && (
                <span className="config-saved-indicator">
                  <CheckCircle size={14} />
                  File saved
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConfigTab({
  agent,
  projectId,
  addToast,
  onSaved,
  onHasChangesChange,
  onDelete,
}: {
  agent: AgentDetail;
  projectId?: string;
  addToast: (message: string, type?: "success" | "error") => void;
  onSaved: () => Promise<void>;
  onHasChangesChange?: (hasChanges: boolean) => void;
  onDelete?: () => Promise<void> | void;
}) {
  // Identity field state
  const [nameValue, setNameValue] = useState(agent.name);
  const [roleValue, setRoleValue] = useState(agent.role);
  const [titleValue, setTitleValue] = useState(agent.title ?? "");
  const [iconValue, setIconValue] = useState(agent.icon ?? "");
  const [reportsToValue, setReportsToValue] = useState(agent.reportsTo ?? "");
  const [managerOptions, setManagerOptions] = useState<Agent[]>([]);
  const [isLoadingManagers, setIsLoadingManagers] = useState(false);

  // Local form state initialised from agent.metadata
  const [formValues, setFormValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of ADVANCED_SETTINGS) {
      const raw = agent.metadata[field.key];
      if (raw !== undefined && raw !== null) {
        initial[field.key] = String(raw);
      }
    }
    return initial;
  });

  // Heartbeat config state initialised from agent.runtimeConfig
  const [heartbeatValues, setHeartbeatValues] = useState<Record<string, string>>(
    () => deriveHeartbeatValues(agent.runtimeConfig),
  );
  const [heartbeatEnabled, setHeartbeatEnabled] = useState<boolean>(
    () => deriveHeartbeatEnabled(agent.runtimeConfig),
  );

  // Budget config state initialised from agent.runtimeConfig.budgetConfig
  const [budgetValues, setBudgetValues] = useState<Record<string, string>>(
    () => deriveBudgetValues(agent.runtimeConfig),
  );

  // Bundle config state
  const [bundleMode, setBundleMode] = useState<string>(agent.bundleConfig?.mode ?? "");
  const [bundleEntryFile, setBundleEntryFile] = useState(agent.bundleConfig?.entryFile ?? "AGENTS.md");
  const [bundleExternalPath, setBundleExternalPath] = useState(agent.bundleConfig?.externalPath ?? "");
  const [bundleFiles, setBundleFiles] = useState<string[]>(agent.bundleConfig?.files ?? []);

  // Skills state initialized from agent.metadata.skills
  const [selectedSkills, setSelectedSkills] = useState<string[]>(
    Array.isArray(agent.metadata?.skills) ? agent.metadata.skills as string[] : []
  );

  // Model/runtime selector state
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [availableRuntimes, setAvailableRuntimes] = useState<PluginRuntimeInfo[]>([]);
  const [runtimesLoading, setRuntimesLoading] = useState(false);

  const initialModelValue = (() => {
    const rc = agent.runtimeConfig ?? {};
    if (rc.modelProvider && rc.modelId) {
      return `${rc.modelProvider}/${rc.modelId}`;
    }
    if (typeof rc.model === "string" && rc.model.includes("/")) {
      return rc.model;
    }
    return "";
  })();
  const initialRuntimeHint = typeof agent.runtimeConfig?.runtimeHint === "string"
    ? agent.runtimeConfig.runtimeHint
    : "";
  const [runtimeMode, setRuntimeMode] = useState<"model" | "runtime">(initialRuntimeHint ? "runtime" : "model");
  const [modelValue, setModelValue] = useState(initialModelValue);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState(initialRuntimeHint);

  const managerSelection = reportsToValue.trim();
  const availableManagers = useMemo(
    () => managerOptions.filter((candidate) => candidate.id !== agent.id),
    [managerOptions, agent.id],
  );
  const hasMissingManagerSelection = !!managerSelection
    && !availableManagers.some((candidate) => candidate.id === managerSelection);

  // Load candidate managers for reports-to dropdown
  useEffect(() => {
    let cancelled = false;
    setIsLoadingManagers(true);

    fetchAgents(undefined, projectId)
      .then((agents) => {
        if (cancelled) return;
        setManagerOptions(agents);
      })
      .catch(() => {
        if (!cancelled) {
          setManagerOptions([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingManagers(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Load available models on mount
  useEffect(() => {
    setModelsLoading(true);
    fetchModels()
      .then((response) => {
        setAvailableModels(response.models);
        setFavoriteProviders(response.favoriteProviders);
        setFavoriteModels(response.favoriteModels);
      })
      .catch(() => {
        // Gracefully handle unavailable models endpoint
      })
      .finally(() => setModelsLoading(false));
  }, []);

  const handleToggleFavorite = useCallback(async (provider: string) => {
    const currentFavorites = favoriteProviders;
    const isFavorite = currentFavorites.includes(provider);
    const newFavorites = isFavorite
      ? currentFavorites.filter((p) => p !== provider)
      : [provider, ...currentFavorites];

    setFavoriteProviders(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders: newFavorites, favoriteModels });
    } catch {
      setFavoriteProviders(currentFavorites);
    }
  }, [favoriteProviders, favoriteModels]);

  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    const currentFavorites = favoriteModels;
    const isFavorite = currentFavorites.includes(modelId);
    const newFavorites = isFavorite
      ? currentFavorites.filter((m) => m !== modelId)
      : [modelId, ...currentFavorites];

    setFavoriteModels(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders, favoriteModels: newFavorites });
    } catch {
      setFavoriteModels(currentFavorites);
    }
  }, [favoriteProviders, favoriteModels]);

  useEffect(() => {
    setRuntimesLoading(true);
    fetchPluginRuntimes(projectId)
      .then(setAvailableRuntimes)
      .catch(() => setAvailableRuntimes([]))
      .finally(() => setRuntimesLoading(false));
  }, [projectId]);

  // Budget status for progress bar display
  const [budgetStatus, setBudgetStatus] = useState<AgentBudgetStatus | null>(null);
  const [isResettingBudget, setIsResettingBudget] = useState(false);

  // Fetch budget status on mount
  useEffect(() => {
    fetchAgentBudgetStatus(agent.id, projectId)
      .then(setBudgetStatus)
      .catch(() => setBudgetStatus(null));
  }, [agent.id, projectId]);

  const handleResetBudget = async () => {
    setIsResettingBudget(true);
    try {
      await resetAgentBudget(agent.id, projectId);
      addToast("Budget usage reset successfully", "success");
      // Refresh budget status
      const status = await fetchAgentBudgetStatus(agent.id, projectId);
      setBudgetStatus(status);
    } catch (err) {
      addToast(`Failed to reset budget: ${getErrorMessage(err)}`, "error");
    } finally {
      setIsResettingBudget(false);
    }
  };

  const [isSaving, setIsSaving] = useState(false);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [justSaved, setJustSaved] = useState(false);
  const isDeletableState = agent.state === "idle" || agent.state === "terminated";
  const justSavedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousAgentRuntimeSyncRef = useRef<{ id: string; updatedAt: string } | null>(null);

  useEffect(() => {
    return () => {
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
    };
  }, []);

  /** Detect whether any local value differs from the persisted metadata */
  const hasChanges = (() => {
    // Check identity fields
    if (nameValue !== agent.name) return true;
    if (roleValue !== agent.role) return true;
    if (titleValue !== (agent.title ?? "")) return true;
    if (iconValue !== (agent.icon ?? "")) return true;
    if (reportsToValue !== (agent.reportsTo ?? "")) return true;

    // Check bundle config
    if (bundleMode !== (agent.bundleConfig?.mode ?? "")) return true;
    if (bundleEntryFile !== (agent.bundleConfig?.entryFile ?? "AGENTS.md")) return true;
    if (bundleExternalPath !== (agent.bundleConfig?.externalPath ?? "")) return true;
    if (JSON.stringify(bundleFiles) !== JSON.stringify(agent.bundleConfig?.files ?? [])) return true;

    for (const field of ADVANCED_SETTINGS) {
      const current = formValues[field.key]?.trim() ?? "";
      const persisted = agent.metadata[field.key] !== undefined && agent.metadata[field.key] !== null
        ? String(agent.metadata[field.key])
        : "";
      if (current !== persisted) return true;
    }
    // Check heartbeat values
    const rc = agent.runtimeConfig ?? {};
    if (heartbeatEnabled !== deriveHeartbeatEnabled(agent.runtimeConfig)) return true;
    for (const key of ["heartbeatIntervalMs", "heartbeatTimeoutMs", "maxConcurrentRuns", "messageResponseMode"] as const) {
      const current = heartbeatValues[key]?.trim() ?? "";
      let persisted = rc[key] !== undefined && rc[key] !== null ? String(rc[key]) : "";

      if ((key === "heartbeatIntervalMs" || key === "heartbeatTimeoutMs") && persisted) {
        persisted = String(Number(persisted) / 1000);
      }

      if (current !== persisted) return true;
    }
    // Check budget config values
    const persistedBc = rc.budgetConfig as Record<string, unknown> | undefined;
    for (const key of ["tokenBudget", "budgetPeriod", "resetDay"] as const) {
      const current = budgetValues[key]?.trim() ?? "";
      const persisted = persistedBc?.[key] !== undefined && persistedBc?.[key] !== null
        ? String(persistedBc[key])
        : "";
      if (current !== persisted) return true;
    }
    // usageThreshold: compare percentage (UI) against fraction * 100 (persisted)
    const currentThreshold = budgetValues.usageThreshold?.trim() ?? "";
    const persistedThreshold = persistedBc?.usageThreshold !== undefined && persistedBc?.usageThreshold !== null
      ? String(Number(persistedBc.usageThreshold) * 100)
      : "";
    if (currentThreshold !== persistedThreshold) return true;

    // Check skills
    const persistedSkills = Array.isArray(agent.metadata?.skills) ? agent.metadata.skills as string[] : [];
    if (JSON.stringify(selectedSkills) !== JSON.stringify(persistedSkills)) return true;

    // Check model/runtime override
    if (runtimeMode !== (initialRuntimeHint ? "runtime" : "model")) return true;
    if (modelValue !== initialModelValue) return true;
    if (selectedRuntimeId !== initialRuntimeHint) return true;

    return false;
  })();

  const previousHasChangesRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!onHasChangesChange) return;
    if (previousHasChangesRef.current === hasChanges) return;

    previousHasChangesRef.current = hasChanges;
    onHasChangesChange(hasChanges);
  }, [hasChanges, onHasChangesChange]);

  useEffect(() => {
    return () => {
      onHasChangesChange?.(false);
    };
  }, [onHasChangesChange]);

  useEffect(() => {
    const nextSnapshot = { id: agent.id, updatedAt: agent.updatedAt };
    const previousSnapshot = previousAgentRuntimeSyncRef.current;
    const hasNewAgentData =
      !previousSnapshot
      || previousSnapshot.id !== nextSnapshot.id
      || previousSnapshot.updatedAt !== nextSnapshot.updatedAt;

    if (!hasNewAgentData) {
      return;
    }

    if (hasChanges) {
      return;
    }

    previousAgentRuntimeSyncRef.current = nextSnapshot;
    setHeartbeatValues(deriveHeartbeatValues(agent.runtimeConfig));
    setHeartbeatEnabled(deriveHeartbeatEnabled(agent.runtimeConfig));
    setBudgetValues(deriveBudgetValues(agent.runtimeConfig));
    setModelValue(initialModelValue);
    setSelectedRuntimeId(initialRuntimeHint);
    setRuntimeMode(initialRuntimeHint ? "runtime" : "model");
  }, [agent, hasChanges, initialModelValue, initialRuntimeHint]);

  const handleFieldChange = (key: string, value: string) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
    setJustSaved(false);
    // Clear individual field error on change
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const handleHeartbeatFieldChange = (key: string, value: string) => {
    setHeartbeatValues((prev) => ({ ...prev, [key]: value }));
    setJustSaved(false);
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const handleHeartbeatEnabledChange = (enabled: boolean) => {
    setHeartbeatEnabled(enabled);
    setJustSaved(false);
  };

  const handleBudgetFieldChange = (key: string, value: string) => {
    setBudgetValues((prev) => ({ ...prev, [key]: value }));
    setJustSaved(false);
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const handleSave = async () => {
    // Validate advanced settings
    const validationErrors = validateAdvancedSettings(formValues);

    // Validate heartbeat settings
    for (const [key, config] of Object.entries({
      heartbeatIntervalMs: { label: "Heartbeat Interval", min: 1 },
      heartbeatTimeoutMs: { label: "Heartbeat Timeout", min: 5 },
      maxConcurrentRuns: { label: "Max Concurrent Runs", min: 1 },
    })) {
      const raw = heartbeatValues[key]?.trim();
      if (!raw) continue;
      const num = Number(raw);
      if (Number.isNaN(num) || !Number.isFinite(num)) {
        validationErrors[key] = `"${config.label}" must be a valid number`;
      } else if (num < config.min) {
        validationErrors[key] = `"${config.label}" must be at least ${config.min.toLocaleString()}`;
      }
    }

    const messageResponseModeForValidation = heartbeatValues.messageResponseMode?.trim();
    if (messageResponseModeForValidation && !["immediate", "on-heartbeat"].includes(messageResponseModeForValidation)) {
      validationErrors.messageResponseMode = "\"Message Response Mode\" must be either immediate or on-heartbeat";
    }

    // Validate budget settings
    const tokenBudgetRaw = budgetValues.tokenBudget?.trim();
    if (tokenBudgetRaw) {
      const num = Number(tokenBudgetRaw);
      if (Number.isNaN(num) || !Number.isFinite(num)) {
        validationErrors.tokenBudget = "\"Token Budget\" must be a valid number";
      } else if (num <= 0) {
        validationErrors.tokenBudget = "\"Token Budget\" must be greater than 0";
      }
    }

    const usageThresholdRaw = budgetValues.usageThreshold?.trim();
    if (usageThresholdRaw) {
      const num = Number(usageThresholdRaw);
      if (Number.isNaN(num) || !Number.isFinite(num)) {
        validationErrors.usageThreshold = "\"Usage Threshold\" must be a valid number";
      } else if (num < 1 || num > 100) {
        validationErrors.usageThreshold = "\"Usage Threshold\" must be between 1 and 100";
      }
    }

    const budgetPeriodRaw = budgetValues.budgetPeriod?.trim();
    if (budgetPeriodRaw && !["daily", "weekly", "monthly", "lifetime"].includes(budgetPeriodRaw)) {
      validationErrors.budgetPeriod = "\"Budget Period\" must be one of: daily, weekly, monthly, lifetime";
    }

    const resetDayRaw = budgetValues.resetDay?.trim();
    const periodForResetDay = budgetPeriodRaw || "lifetime";
    if (resetDayRaw) {
      const num = Number(resetDayRaw);
      if (Number.isNaN(num) || !Number.isFinite(num)) {
        validationErrors.resetDay = "\"Reset Day\" must be a valid number";
      } else if (periodForResetDay === "weekly") {
        if (num < 0 || num > 6 || !Number.isInteger(num)) {
          validationErrors.resetDay = "\"Reset Day\" must be between 0 (Sunday) and 6 (Saturday) for weekly period";
        }
      } else if (periodForResetDay === "monthly") {
        if (num < 1 || num > 31 || !Number.isInteger(num)) {
          validationErrors.resetDay = "\"Reset Day\" must be between 1 and 31 for monthly period";
        }
      }
    }

    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      addToast("Please fix validation errors before saving", "error");
      return;
    }

    // Build the metadata payload — only include non-empty values
    const newMetadata: Record<string, unknown> = { ...agent.metadata };
    for (const field of ADVANCED_SETTINGS) {
      const raw = formValues[field.key]?.trim();
      if (!raw) {
        // Remove the key to use system default
        delete newMetadata[field.key];
      } else if (field.type === "number") {
        newMetadata[field.key] = Number(raw);
      } else {
        newMetadata[field.key] = raw;
      }
    }

    // Handle skills in metadata
    if (selectedSkills.length > 0) {
      newMetadata.skills = selectedSkills;
    } else {
      delete newMetadata.skills;
    }

    // Build the runtimeConfig payload — only include non-empty values
    const newRuntimeConfig: Record<string, unknown> = { ...agent.runtimeConfig };
    newRuntimeConfig.enabled = heartbeatEnabled;
    for (const key of ["heartbeatIntervalMs", "heartbeatTimeoutMs", "maxConcurrentRuns"] as const) {
      const raw = heartbeatValues[key]?.trim();
      if (!raw) {
        delete newRuntimeConfig[key];
      } else {
        const num = Number(raw);
        newRuntimeConfig[key] = key === "maxConcurrentRuns" ? num : num * 1000;
      }
    }

    const messageResponseMode = heartbeatValues.messageResponseMode?.trim();
    if (!messageResponseMode) {
      delete newRuntimeConfig.messageResponseMode;
    } else {
      newRuntimeConfig.messageResponseMode = messageResponseMode;
    }

    if (runtimeMode === "runtime") {
      if (selectedRuntimeId.trim()) {
        newRuntimeConfig.runtimeHint = selectedRuntimeId.trim();
      } else {
        delete newRuntimeConfig.runtimeHint;
      }
      delete newRuntimeConfig.modelProvider;
      delete newRuntimeConfig.modelId;
      delete newRuntimeConfig.model;
    } else {
      delete newRuntimeConfig.runtimeHint;

      // Model override: parse "provider/modelId" into separate fields
      if (modelValue.trim()) {
        const slashIdx = modelValue.indexOf("/");
        if (slashIdx !== -1) {
          newRuntimeConfig.modelProvider = modelValue.slice(0, slashIdx);
          newRuntimeConfig.modelId = modelValue.slice(slashIdx + 1);
          newRuntimeConfig.model = modelValue.trim();
        }
      } else {
        delete newRuntimeConfig.modelProvider;
        delete newRuntimeConfig.modelId;
        delete newRuntimeConfig.model;
      }
    }

    // Build budgetConfig payload — only include non-empty values
    const newBudgetConfig: Record<string, unknown> = {};
    const tokenBudget = budgetValues.tokenBudget?.trim();
    const usageThreshold = budgetValues.usageThreshold?.trim();
    const budgetPeriod = budgetValues.budgetPeriod?.trim();
    const resetDay = budgetValues.resetDay?.trim();

    if (tokenBudget) {
      newBudgetConfig.tokenBudget = Number(tokenBudget);
    }
    if (usageThreshold) {
      // Convert percentage (UI) to fraction (storage)
      newBudgetConfig.usageThreshold = Number(usageThreshold) / 100;
    }
    if (budgetPeriod) {
      newBudgetConfig.budgetPeriod = budgetPeriod;
    }
    if (resetDay) {
      newBudgetConfig.resetDay = Number(resetDay);
    }

    // Only persist budgetConfig if it has any values
    if (Object.keys(newBudgetConfig).length > 0) {
      newRuntimeConfig.budgetConfig = newBudgetConfig;
    } else {
      delete newRuntimeConfig.budgetConfig;
    }

    // Build bundleConfig payload — only include if mode is set
    let newBundleConfig: { mode: "managed" | "external"; entryFile: string; files: string[]; externalPath?: string } | undefined;
    if (bundleMode) {
      newBundleConfig = {
        mode: bundleMode as "managed" | "external",
        entryFile: bundleEntryFile || "AGENTS.md",
        files: bundleFiles.length > 0 ? bundleFiles : ["AGENTS.md"],
      };
      if (bundleMode === "external" && bundleExternalPath.trim()) {
        newBundleConfig.externalPath = bundleExternalPath.trim();
      }
    }

    setIsSaving(true);
    try {
      await updateAgent(agent.id, {
        name: nameValue.trim() || undefined,
        role: roleValue,
        title: titleValue.trim() || undefined,
        icon: iconValue.trim() || undefined,
        reportsTo: reportsToValue.trim() || undefined,
        metadata: newMetadata,
        runtimeConfig: newRuntimeConfig,
        bundleConfig: newBundleConfig,
      }, projectId);
      addToast("Settings saved", "success");
      setJustSaved(true);
      // Auto-hide the saved indicator after 3 seconds
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
      justSavedTimeoutRef.current = setTimeout(() => setJustSaved(false), 3000);
      await onSaved();
    } catch (err) {
      addToast(`Failed to save settings: ${getErrorMessage(err)}`, "error");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="config-tab">
      <div className="config-section">
        <h3>Agent Configuration</h3>
        <p className="config-description">
          Configure agent settings and behavior.
        </p>
        
        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="agent-name">Name</label>
            <input 
              id="agent-name"
              type="text" 
              className="input" 
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
            />
          </div>
          
          <div className="config-field">
            <label htmlFor="agent-role">Role</label>
            <select
              id="agent-role"
              className="select"
              value={roleValue}
              onChange={(e) => setRoleValue(e.target.value as AgentCapability)}
            >
              <option value="triage">Triage</option>
              <option value="executor">Executor</option>
              <option value="reviewer">Reviewer</option>
              <option value="merger">Merger</option>
              <option value="scheduler">Scheduler</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          <div className="config-field">
            <label htmlFor="agent-title">Title</label>
            <input
              id="agent-title"
              type="text"
              className="input"
              placeholder="e.g. Senior Code Reviewer"
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
            />
          </div>

          <div className="config-field">
            <label htmlFor="agent-icon">Icon</label>
            <input
              id="agent-icon"
              type="text"
              className="input"
              placeholder="e.g. 🤖"
              value={iconValue}
              onChange={(e) => setIconValue(e.target.value)}
            />
          </div>

          <div className="config-field">
            <label htmlFor="agent-reports-to">Reports To</label>
            <select
              id="agent-reports-to"
              className="select"
              value={reportsToValue}
              onChange={(e) => setReportsToValue(e.target.value)}
              disabled={isLoadingManagers}
            >
              <option value="">No manager</option>
              {hasMissingManagerSelection && (
                <option value={managerSelection}>Unknown manager ({managerSelection})</option>
              )}
              {availableManagers.map((manager) => (
                <option key={manager.id} value={manager.id}>
                  {manager.name} ({manager.id})
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="config-section">
        <h3>Skills</h3>
        <p className="config-description">
          Assign skills to this agent for specialized behavior.
        </p>

        <div className="config-fields">
          <div className="config-field">
            <SkillMultiselect
              id="agent-skills"
              label="Skills"
              value={selectedSkills}
              onChange={setSelectedSkills}
              projectId={projectId}
            />
          </div>
        </div>
      </div>

      <div className="config-section">
        <h3>Model</h3>
        <p className="config-description">
          Choose either a built-in model or a plugin runtime for this agent. These options are mutually exclusive.
        </p>

        <div className="config-fields">
          <div className="config-field">
            <label>Runtime Source</label>
            <div className="config-runtime-tabs" role="tablist" aria-label="Runtime source">
              <button
                type="button"
                className={`config-runtime-tab${runtimeMode === "model" ? " active" : ""}`}
                role="tab"
                aria-selected={runtimeMode === "model"}
                tabIndex={runtimeMode === "model" ? 0 : -1}
                onClick={() => {
                  setRuntimeMode("model");
                  setSelectedRuntimeId("");
                }}
              >
                Built-in Model
              </button>
              <button
                type="button"
                className={`config-runtime-tab${runtimeMode === "runtime" ? " active" : ""}`}
                role="tab"
                aria-selected={runtimeMode === "runtime"}
                tabIndex={runtimeMode === "runtime" ? 0 : -1}
                onClick={() => setRuntimeMode("runtime")}
              >
                Plugin Runtime
              </button>
            </div>
          </div>

          {runtimeMode === "model" ? (
            <div className="config-field">
              <CustomModelDropdown
                models={availableModels}
                value={modelValue}
                onChange={setModelValue}
                placeholder="Use global default"
                label="Agent Model"
                disabled={modelsLoading}
                favoriteProviders={favoriteProviders}
                onToggleFavorite={handleToggleFavorite}
                favoriteModels={favoriteModels}
                onToggleModelFavorite={handleToggleModelFavorite}
              />
            </div>
          ) : (
            <div className="config-field">
              <label htmlFor="agent-runtime-hint">Runtime</label>
              {runtimesLoading ? (
                <span className="config-hint">Loading runtimes…</span>
              ) : (
                <select
                  id="agent-runtime-hint"
                  className="select"
                  value={selectedRuntimeId}
                  onChange={(e) => setSelectedRuntimeId(e.target.value)}
                >
                  <option value="">
                    {availableRuntimes.length > 0 ? "Select a plugin runtime…" : "No plugin runtimes available"}
                  </option>
                  {availableRuntimes.map((runtime) => (
                    <option key={`${runtime.pluginId}:${runtime.runtimeId}`} value={runtime.runtimeId}>
                      {runtime.description ? `${runtime.name} — ${runtime.description}` : runtime.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="config-section">
        <h3>Heartbeat Settings</h3>
        <p className="config-description">
          Configure how this agent's heartbeat is monitored. Leave a field empty to use system defaults.
        </p>

        <div className="config-fields">
          <div className="config-field">
            <label className="checkbox-label" htmlFor="hb-enabled">
              <input
                id="hb-enabled"
                type="checkbox"
                checked={heartbeatEnabled}
                onChange={(e) => handleHeartbeatEnabledChange(e.target.checked)}
              />
              Heartbeat Enabled
            </label>
            <span className="config-hint">When enabled, this agent receives scheduled heartbeat runs based on its interval.</span>
          </div>

          <div className="config-field">
            <label htmlFor="hb-heartbeatIntervalMs">Heartbeat Interval (s)</label>
            <input
              id="hb-heartbeatIntervalMs"
              type="text"
              inputMode="numeric"
              className={cn("input", !!errors.heartbeatIntervalMs && "input--error")}
              placeholder={String(DEFAULT_HEARTBEAT_INTERVAL_MS / 1000)}
              value={heartbeatValues.heartbeatIntervalMs ?? ""}
              onChange={(e) => handleHeartbeatFieldChange("heartbeatIntervalMs", e.target.value)}
            />
            {errors.heartbeatIntervalMs ? (
              <span className="config-error">{errors.heartbeatIntervalMs}</span>
            ) : (
              <span className="config-hint">
                How often heartbeats are checked. Leave empty for system default ({DEFAULT_HEARTBEAT_INTERVAL_MS / 1000}s / {DEFAULT_HEARTBEAT_INTERVAL_LABEL}).
              </span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="hb-heartbeatTimeoutMs">Heartbeat Timeout (s)</label>
            <input
              id="hb-heartbeatTimeoutMs"
              type="text"
              inputMode="numeric"
              className={cn("input", !!errors.heartbeatTimeoutMs && "input--error")}
              placeholder="60"
              value={heartbeatValues.heartbeatTimeoutMs ?? ""}
              onChange={(e) => handleHeartbeatFieldChange("heartbeatTimeoutMs", e.target.value)}
            />
            {errors.heartbeatTimeoutMs ? (
              <span className="config-error">{errors.heartbeatTimeoutMs}</span>
            ) : (
              <span className="config-hint">Time without heartbeat before agent is considered unresponsive. Leave empty for system default (60s)</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="hb-maxConcurrentRuns">Max Concurrent Runs</label>
            <input
              id="hb-maxConcurrentRuns"
              type="text"
              inputMode="numeric"
              className={cn("input", !!errors.maxConcurrentRuns && "input--error")}
              placeholder="1"
              value={heartbeatValues.maxConcurrentRuns ?? ""}
              onChange={(e) => handleHeartbeatFieldChange("maxConcurrentRuns", e.target.value)}
            />
            {errors.maxConcurrentRuns ? (
              <span className="config-error">{errors.maxConcurrentRuns}</span>
            ) : (
              <span className="config-hint">Maximum simultaneous heartbeat runs for this agent. Leave empty for system default (1).</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="hb-messageResponseMode">Message Response Mode</label>
            <select
              id="hb-messageResponseMode"
              className={cn("select", !!errors.messageResponseMode && "input--error")}
              value={heartbeatValues.messageResponseMode ?? ""}
              onChange={(e) => handleHeartbeatFieldChange("messageResponseMode", e.target.value)}
            >
              <option value="">System Default (On Heartbeat)</option>
              <option value="on-heartbeat">On Heartbeat</option>
              <option value="immediate">Immediate</option>
            </select>
            {errors.messageResponseMode ? (
              <span className="config-error">{errors.messageResponseMode}</span>
            ) : (
              <span className="config-hint">How this agent responds to incoming messages. &apos;Immediate&apos; wakes the agent as soon as a message arrives. &apos;On Heartbeat&apos; defers processing to the next scheduled heartbeat.</span>
            )}
          </div>
        </div>
      </div>

      <div className="config-section">
        <h3>Budget Settings</h3>
        <p className="config-description">
          Configure token budget limits for this agent. Leave all fields empty to disable budget tracking.
        </p>

        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="budget-tokenBudget">Token Budget</label>
            <input
              id="budget-tokenBudget"
              type="text"
              inputMode="numeric"
              className={cn("input", !!errors.tokenBudget && "input--error")}
              placeholder="No limit"
              value={budgetValues.tokenBudget ?? ""}
              onChange={(e) => handleBudgetFieldChange("tokenBudget", e.target.value)}
            />
            {errors.tokenBudget ? (
              <span className="config-error">{errors.tokenBudget}</span>
            ) : (
              <span className="config-hint">Total token cap (input + output) for this agent. Leave empty for no limit.</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="budget-usageThreshold">Usage Threshold (%)</label>
            <input
              id="budget-usageThreshold"
              type="text"
              inputMode="numeric"
              className={cn("input", !!errors.usageThreshold && "input--error")}
              placeholder="80"
              value={budgetValues.usageThreshold ?? ""}
              onChange={(e) => handleBudgetFieldChange("usageThreshold", e.target.value)}
            />
            {errors.usageThreshold ? (
              <span className="config-error">{errors.usageThreshold}</span>
            ) : (
              <span className="config-hint">Warning threshold as a percentage. Agent warns when usage reaches this level. Default: 80%.</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="budget-budgetPeriod">Budget Period</label>
            <select
              id="budget-budgetPeriod"
              className={cn("select", !!errors.budgetPeriod && "input--error")}
              value={budgetValues.budgetPeriod ?? ""}
              onChange={(e) => handleBudgetFieldChange("budgetPeriod", e.target.value)}
            >
              <option value="">No reset (lifetime)</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
            {errors.budgetPeriod ? (
              <span className="config-error">{errors.budgetPeriod}</span>
            ) : (
              <span className="config-hint">How often the budget counter resets. Leave empty for lifetime budget.</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="budget-resetDay">Reset Day</label>
            <input
              id="budget-resetDay"
              type="text"
              inputMode="numeric"
              className={cn("input", !!errors.resetDay && "input--error")}
              placeholder="Auto"
              value={budgetValues.resetDay ?? ""}
              onChange={(e) => handleBudgetFieldChange("resetDay", e.target.value)}
            />
            {errors.resetDay ? (
              <span className="config-error">{errors.resetDay}</span>
            ) : (
              <span className="config-hint">
                {budgetValues.budgetPeriod === "weekly"
                  ? "Day of week (0=Sunday to 6=Saturday) for reset."
                  : budgetValues.budgetPeriod === "monthly"
                    ? "Day of month (1-31) for reset."
                    : "Day for reset (weekly: 0-6, monthly: 1-31). Leave empty for automatic."}
              </span>
            )}
          </div>

          {/* Budget Usage Progress Bar */}
          {budgetStatus?.budgetLimit != null && (
            <div className="config-field">
              <label>Current Usage</label>
              <div className="budget-progress-container">
                <div className="budget-progress-bar">
                  <div
                    className={cn(
                      "budget-progress-bar__fill",
                      (budgetStatus.usagePercent ?? 0) >= 100
                        ? "budget-progress-bar__fill--red"
                        : (budgetStatus.usagePercent ?? 0) >= 80
                          ? "budget-progress-bar__fill--amber"
                          : "budget-progress-bar__fill--green"
                    )}
                    style={{ width: `${Math.min(budgetStatus.usagePercent ?? 0, 100)}%` }}
                  />
                </div>
                <span className="budget-progress-label">
                  {(budgetStatus.currentUsage ?? 0).toLocaleString()} / {(budgetStatus.budgetLimit ?? 0).toLocaleString()} tokens ({Math.round(budgetStatus.usagePercent ?? 0)}% used)
                </span>
              </div>
            </div>
          )}

          {/* Reset Budget Button */}
          {budgetStatus?.budgetLimit != null && (
            <div className="config-field">
              <button
                className="btn btn-reset-budget"
                onClick={() => void handleResetBudget()}
                disabled={isResettingBudget}
              >
                {isResettingBudget ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Resetting…
                  </>
                ) : (
                  <>
                    <RefreshCw size={14} />
                    Reset Budget Usage
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="config-section">
        <h3>Instruction Bundle</h3>
        <p className="config-description">
          Configure the agent's instruction bundle. Leave empty to use inline instructions only.
        </p>

        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="bundle-mode">Bundle Mode</label>
            <select
              id="bundle-mode"
              className="select"
              value={bundleMode}
              onChange={(e) => setBundleMode(e.target.value)}
            >
              <option value="">None (use inline instructions)</option>
              <option value="managed">Managed (system-managed directory)</option>
              <option value="external">External (user-specified path)</option>
            </select>
            <span className="config-hint">
              {bundleMode === "managed" && "Files will be stored in a system-managed directory within .fusion/agents/"}
              {bundleMode === "external" && "Specify an external directory path for the instruction files"}
              {!bundleMode && "Select a mode to enable instruction bundling"}
            </span>
          </div>

          {bundleMode && (
            <>
              <div className="config-field">
                <label htmlFor="bundle-entry-file">Entry File</label>
                <input
                  id="bundle-entry-file"
                  type="text"
                  className="input"
                  placeholder="AGENTS.md"
                  value={bundleEntryFile}
                  onChange={(e) => setBundleEntryFile(e.target.value)}
                />
                <span className="config-hint">Primary instructions file name (default: AGENTS.md)</span>
              </div>

              {bundleMode === "external" && (
                <div className="config-field">
                  <label htmlFor="bundle-external-path">External Path</label>
                  <input
                    id="bundle-external-path"
                    type="text"
                    className="input"
                    placeholder="e.g. .fusion/agents/my-agent"
                    value={bundleExternalPath}
                    onChange={(e) => setBundleExternalPath(e.target.value)}
                  />
                  <span className="config-hint">Absolute or relative path to the external directory</span>
                </div>
              )}

              <div className="config-field">
                <label htmlFor="bundle-files">Files (comma-separated)</label>
                <input
                  id="bundle-files"
                  type="text"
                  className="input"
                  placeholder="AGENTS.md, PROMPTS.md"
                  value={bundleFiles.join(", ")}
                  onChange={(e) => setBundleFiles(
                    e.target.value.split(",").map(f => f.trim()).filter(Boolean)
                  )}
                />
                <span className="config-hint">List of file names in the bundle directory</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="config-section">
        <h3>Advanced Settings</h3>
        <p className="config-description">
          Advanced configuration options for this agent. Leave a field empty to use system defaults.
        </p>

        <div className="config-fields">
          {ADVANCED_SETTINGS.map((field) => {
            const hasError = !!errors[field.key];
            return (
              <div className="config-field" key={field.key}>
                <label htmlFor={`adv-${field.key}`}>{field.label}</label>
                {field.type === "select" ? (
                  <select
                    id={`adv-${field.key}`}
                    className={cn("select", hasError && "input--error")}
                    value={formValues[field.key] ?? ""}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                  >
                    <option value="">System Default</option>
                    {field.options?.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`adv-${field.key}`}
                    type="text"
                    inputMode={field.type === "number" ? "numeric" : undefined}
                    className={cn("input", hasError && "input--error")}
                    placeholder={field.placeholder}
                    value={formValues[field.key] ?? ""}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                  />
                )}
                {hasError && (
                  <span className="config-error">{errors[field.key]}</span>
                )}
                {!hasError && field.hint && (
                  <span className="config-hint">{field.hint}</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="config-actions">
          <button
            className="btn btn-task-create"
            disabled={!hasChanges || isSaving}
            onClick={() => void handleSave()}
          >
            {isSaving ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <CheckCircle size={16} />
                Save Settings
              </>
            )}
          </button>
          {!hasChanges && justSaved && (
            <span className="config-saved-indicator">
              <CheckCircle size={14} />
              Settings saved
            </span>
          )}
        </div>
      </div>

      <HeartbeatProcedureSection
        agent={agent}
        projectId={projectId}
        addToast={addToast}
        onSaved={onSaved}
      />

      <div className="config-section config-section--danger">
        <h3>Danger Zone</h3>
        <p className="config-description">
          Permanently delete this agent from the project.
        </p>
        <div className="config-fields">
          <div className="config-field">
            <button
              className="btn btn--danger"
              disabled={!isDeletableState || !onDelete}
              onClick={() => void onDelete?.()}
            >
              <Trash2 size={16} />
              Delete Agent
            </button>
            <span className="config-danger-note">
              {isDeletableState
                ? "Deletion is permanent and cannot be undone."
                : `Agent deletion is only available when state is idle or terminated (current state: ${agent.state}).`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Employees Tab ───────────────────────────────────────────────────────────

function EmployeesTab({
  agentId,
  projectId,
  onChildClick,
}: {
  agentId: string;
  projectId?: string;
  onChildClick?: (childId: string) => void;
}) {
  const [children, setChildren] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
    fetchAgentChildren(agentId, projectId)
      .then(setChildren)
      .finally(() => setIsLoading(false));
  }, [agentId, projectId]);

  if (isLoading) {
    return (
      <div className="detail-section">
        <div className="detail-section-header">
          <h3>Employees</h3>
        </div>
        <div className="detail-section-body detail-section-body--loading">
          <Loader2 size={16} className="spin" />
          <span className="text-muted">Loading employees...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="detail-section">
      <div className="detail-section-header">
        <h3>Employees</h3>
        <span className="text-muted">({children.length})</span>
      </div>
      <div className="detail-section-body">
        {children.length === 0 ? (
          <div className="agent-empty agent-empty--padded">
            <GitBranch size={32} opacity={0.3} />
            <p>No employees</p>
            <p className="text-muted">This agent has no employees</p>
          </div>
        ) : (
          <div className="agent-tree__children">
            {children.map((child) => {
              const stateStyle = STATE_COLORS[child.state as AgentState];
              return (
                <div
                  key={child.id}
                  className={`agent-tree__node agent-is-child`}
                  onClick={() => onChildClick?.(child.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      if (e.key === " ") {
                        e.preventDefault();
                      }
                      onChildClick?.(child.id);
                    }
                  }}
                  style={{ cursor: onChildClick ? "pointer" : "default" }}
                >
                  <span className="agent-tree__icon">{child.icon ?? "🤖"}</span>
                  <span className="agent-tree__name">{child.name}</span>
                  <span
                    className="agent-tree__badge"
                    style={{
                      background: stateStyle?.bg ?? "var(--state-idle-bg)",
                      color: stateStyle?.text ?? "var(--state-idle-text)",
                      border: `1px solid ${stateStyle?.border ?? "var(--state-idle-border)"}`,
                    }}
                  >
                    {child.state}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
