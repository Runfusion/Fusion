import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { 
  Bot, Heart, Activity, Pause, Play, Square, Trash2, RefreshCw, 
  Settings, FileText, ActivitySquare, X, Copy, 
  ExternalLink, CheckCircle, XCircle, Loader2, GitBranch, ListChecks,
  ChevronDown, ChevronRight, BarChart3, Star
} from "lucide-react";
import type { AgentDetail, AgentState, AgentHeartbeatRun, AgentBudgetStatus } from "../api";
import { fetchAgent, updateAgent, updateAgentState, deleteAgent, fetchAgentLogs, fetchAgentRunLogs, fetchAgentChildren, fetchAgentRuns, fetchAgentRunDetail, startAgentRun, stopAgentRun, updateAgentInstructions, updateAgentSoul, updateAgentMemory, fetchAgentTasks, fetchChainOfCommand, fetchAgentBudgetStatus, resetAgentBudget } from "../api";
import type { Agent } from "../api";
import type { AgentLogEntry, Task } from "@fusion/core";
import { AgentLogViewer } from "./AgentLogViewer";
import { AgentReflectionsTab } from "./AgentReflectionsTab";
import { getAgentHealthStatus } from "../utils/agentHealth";

/**
 * Simple className utility - joins class names conditionally
 */
function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Format an ISO timestamp to a relative time string.
 */
function relativeTime(iso: string): string {
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
}

type TabId = "dashboard" | "logs" | "config" | "runs" | "tasks" | "employees" | "soul" | "memory" | "reflections" | "performance";

const TABS: { id: TabId; label: string; icon: typeof Activity }[] = [
  { id: "dashboard", label: "Dashboard", icon: ActivitySquare },
  { id: "logs", label: "Logs", icon: FileText },
  { id: "runs", label: "Runs", icon: Activity },
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "employees", label: "Employees", icon: GitBranch },
  { id: "soul", label: "Soul", icon: Heart },
  { id: "memory", label: "Memory", icon: FileText },
  { id: "reflections", label: "Reflections", icon: BarChart3 },
  { id: "performance", label: "Performance", icon: Star },
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
  completed: { icon: CheckCircle, color: "var(--color-success, #3fb950)" },
  failed: { icon: XCircle, color: "var(--color-error, #f85149)" },
  active: { icon: Loader2, color: "var(--in-progress, #bc8cff)" },
  terminated: { icon: Square, color: "var(--text-muted, #8b949e)" },
};

export function AgentDetailView({ agentId, projectId, onClose, addToast, onChildClick }: AgentDetailViewProps) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [logs, setLogs] = useState<AgentLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [isStreaming, setIsStreaming] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const addToastRef = useRef(addToast);
  const agentRef = useRef<AgentDetail | null>(null);

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
    } catch (err: any) {
      addToastRef.current(`Failed to load agent: ${err.message}`, "error");
      onCloseRef.current();
    } finally {
      setIsLoading(false);
    }
  }, [agentId, projectId]);

  const loadLogs = useCallback(async () => {
    // Agent logs are tied to tasks, not agents directly.
    // If the agent has a current task, we could show those logs.
    // For now, we'll show heartbeat runs as the "activity" for the agent.
    // If the agent is working on a task, we could show task logs.
    if (agent?.taskId) {
      try {
        const data = await fetchAgentLogs(agent.taskId, projectId);
        setLogs(data);
      } catch (err: any) {
        console.error("Failed to load task logs:", err);
      }
    }
  }, [agent?.taskId, projectId]);

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
    if (agent?.taskId) {
      void loadLogs();
    }
  }, [agent?.taskId, loadLogs]);

  // Set up SSE for live log streaming when viewing logs tab with a task
  useEffect(() => {
    if (activeTab !== "logs" || !agent?.taskId) {
      setIsStreaming(false);
      return;
    }

    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const es = new EventSource(`/api/tasks/${encodeURIComponent(agent.taskId)}/logs/stream${query}`);

    const handleAgentLog = (e: MessageEvent) => {
      try {
        const entry: AgentLogEntry = JSON.parse(e.data);
        setLogs(prev => [entry, ...prev]);
        
        // Auto-scroll to top for new entries
        const container = logContainerRef.current;
        if (container && container.scrollTop < 50) {
          container.scrollTop = 0;
        }
      } catch {
        // Ignore parse errors
      }
    };

    es.addEventListener("agent:log", handleAgentLog as EventListener);

    es.onerror = () => {
      setIsStreaming(false);
    };

    es.onopen = () => {
      setIsStreaming(true);
    };

    return () => {
      es.removeEventListener("agent:log", handleAgentLog as EventListener);
      es.close();
      setIsStreaming(false);
    };
  }, [agent?.taskId, activeTab, projectId]);

  const handleStateChange = async (newState: AgentState) => {
    try {
      await updateAgentState(agentId, newState, projectId);
      addToast(`Agent state updated to ${newState}`, "success");
      void loadAgent();
    } catch (err: any) {
      addToast(`Failed to update state: ${err.message}`, "error");
    }
  };

  const handleDelete = async () => {
    if (!agent || !confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) return;
    try {
      await deleteAgent(agentId, projectId);
      addToast(`Agent "${agent.name}" deleted`, "success");
      onClose();
    } catch (err: any) {
      addToast(`Failed to delete agent: ${err.message}`, "error");
    }
  };

  // Use centralized health status utility for consistent labels across all views
  const getHealthStatus = () => {
    if (!agent) return { label: "Unknown", color: "var(--text-muted, #8b949e)" };
    return getAgentHealthStatus(agent);
  };

  const copyAgentId = () => {
    if (agent) {
      navigator.clipboard.writeText(agent.id);
      addToast("Agent ID copied to clipboard", "success");
    }
  };

  if (isLoading) {
    return (
      <div className="agent-detail-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="agent-detail-modal">
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

  return (
    <div className="agent-detail-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="agent-detail-modal">
        {/* Header */}
        <div className="agent-detail-header">
          <div className="agent-detail-title">
            <div className="agent-detail-icon">
              <Bot size={24} />
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
                <span className="badge" style={{ color: health.color }}>
                  {health.icon}
                  {health.label}
                </span>
              </div>
            </div>
          </div>
          
          <div className="agent-detail-actions">
            {/* State-dependent action buttons */}
            {agent.state === "idle" && (
              <>
                <button className="btn btn--primary" onClick={() => void handleStateChange("active")}>
                  <Play size={16} />
                  Start
                </button>
                <button className="btn btn--danger" onClick={handleDelete}>
                  <Trash2 size={16} />
                  Delete
                </button>
              </>
            )}
            {agent.state === "active" && (
              <>
                <button className="btn" onClick={() => void handleStateChange("paused")}>
                  <Pause size={16} />
                  Pause
                </button>
                <button className="btn btn--danger" onClick={() => void handleStateChange("terminated")}>
                  <Square size={16} />
                  Stop
                </button>
              </>
            )}
            {agent.state === "paused" && (
              <>
                <button className="btn btn--primary" onClick={() => void handleStateChange("active")}>
                  <Play size={16} />
                  Resume
                </button>
                <button className="btn btn--danger" onClick={() => void handleStateChange("terminated")}>
                  <Square size={16} />
                  Stop
                </button>
              </>
            )}
            {agent.state === "running" && (
              <>
                <button className="btn" onClick={() => void handleStateChange("paused")}>
                  <Pause size={16} />
                  Pause
                </button>
                <button className="btn btn--danger" onClick={() => void handleStateChange("terminated")}>
                  <Square size={16} />
                  Stop
                </button>
              </>
            )}
            {agent.state === "error" && (
              <>
                <button className="btn btn--primary" onClick={() => void handleStateChange("active")}>
                  <Play size={16} />
                  Retry
                </button>
                <button className="btn btn--danger" onClick={() => void handleStateChange("terminated")}>
                  <Square size={16} />
                  Stop
                </button>
              </>
            )}
            {agent.state === "terminated" && (
              <>
                <button className="btn btn--primary" onClick={() => void handleStateChange("active")}>
                  <Play size={16} />
                  Start
                </button>
                <button className="btn btn--danger" onClick={handleDelete}>
                  <Trash2 size={16} />
                  Delete
                </button>
              </>
            )}

            <button className="btn-icon" onClick={() => void loadAgent()} title="Refresh">
              <RefreshCw size={16} />
            </button>
            <button className="btn-icon" onClick={onClose} title="Close">
              <X size={20} />
            </button>
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
              containerRef={logContainerRef}
              hasTask={!!agent.taskId}
            />
          )}
          
          {activeTab === "runs" && (
            <RunsTab 
              addToast={addToast}
              agentId={agent.id}
              projectId={projectId}
              agentState={agent.state}
              agentName={agent.name}
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

          {activeTab === "performance" && (
            <PerformanceTab
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
            />
          )}
        </div>

        {/* Footer with agent ID */}
        <div className="agent-detail-footer">
          <button className="btn-icon" onClick={copyAgentId} title="Copy Agent ID">
            <Copy size={14} />
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
  health: { label: string; color: string };
  onChildClick?: (childId: string) => void;
  projectId?: string;
}) {
  const stateStyle = STATE_COLORS[agent.state];
  const [chainOfCommand, setChainOfCommand] = useState<Agent[]>([]);
  const [isLoadingChainOfCommand, setIsLoadingChainOfCommand] = useState(true);
  const [budgetStatus, setBudgetStatus] = useState<AgentBudgetStatus | null>(null);

  // Fetch budget status on mount
  useEffect(() => {
    fetchAgentBudgetStatus(agent.id, projectId)
      .then(setBudgetStatus)
      .catch(() => setBudgetStatus(null));
  }, [agent.id, projectId]);

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
    const runs = (agent as any).completedRuns || [];
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

  return (
    <div className="dashboard-tab">
      {/* Budget Exhausted Warning */}
      {budgetStatus?.isOverBudget && (
        <div className="budget-warning-banner" role="alert">
          <span>⚠️</span>
          <span><strong>Budget Exhausted:</strong> This agent has exceeded its token budget and may be operating with limited functionality.</span>
        </div>
      )}

      {/* Agent Info Card */}
      <div className="dashboard-section">
        <h3>Agent Information</h3>
        <div className="info-grid">
          <div className="info-item">
            <span className="info-label">Name</span>
            <span className="info-value">{agent.name}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Role</span>
            <span className="info-value">{agent.role}</span>
          </div>
          <div className="info-item">
            <span className="info-label">State</span>
            <span className="info-value">
              <span 
                className="inline-badge"
                style={{ background: stateStyle.bg, color: stateStyle.text }}
              >
                {agent.state}
              </span>
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">Health</span>
            <span className="info-value" style={{ color: health.color }}>
              {health.label}
            </span>
          </div>
          {budgetStatus?.budgetLimit != null && (
            <div className="info-item">
              <span className="info-label">Budget</span>
              <span className="info-value">
                <span
                  className="budget-badge"
                  style={{
                    background: budgetStatus.isOverBudget
                      ? "var(--state-error-bg, rgba(248,81,73,0.15))"
                      : budgetStatus.isOverThreshold
                        ? "var(--state-paused-bg, rgba(227,181,65,0.15))"
                        : "var(--state-active-bg, rgba(63,185,80,0.15))",
                    color: budgetStatus.isOverBudget
                      ? "var(--state-error-text, #f85149)"
                      : budgetStatus.isOverThreshold
                        ? "var(--state-paused-text, #e3b541)"
                        : "var(--state-active-text, #3fb950)",
                    border: `1px solid ${budgetStatus.isOverBudget ? "var(--state-error-border, #f85149)" : budgetStatus.isOverThreshold ? "var(--state-paused-border, #e3b541)" : "var(--state-active-border, #3fb950)"}`,
                  }}
                >
                  {budgetStatus.isOverBudget
                    ? "⚠ Budget Exhausted"
                    : `${Math.round(budgetStatus.usagePercent ?? 0)}% used`}
                </span>
              </span>
            </div>
          )}
          <div className="info-item">
            <span className="info-label">Created</span>
            <span className="info-value">{new Date(agent.createdAt).toLocaleDateString()}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Last Heartbeat</span>
            <span className="info-value">
              {agent.lastHeartbeatAt 
                ? relativeTime(agent.lastHeartbeatAt)
                : "Never"
              }
            </span>
          </div>
        </div>
      </div>

      <div className="dashboard-section">
        <h3>
          <GitBranch size={16} style={{ marginRight: "6px", verticalAlign: "-2px" }} />
          Chain of Command
        </h3>
        {isLoadingChainOfCommand ? (
          <div className="chain-of-command-loading" role="status" aria-live="polite">
            <Loader2 size={14} className="animate-spin" />
            <span>Loading reporting chain...</span>
          </div>
        ) : chainOfCommand.length <= 1 ? (
          <p className="text-muted">No reporting chain</p>
        ) : (
          <div className="chain-of-command-path" aria-label="Chain of command">
            {chainOfCommand.map((chainAgent, index) => {
              const isCurrent = index === chainOfCommand.length - 1;
              const isAncestor = !isCurrent;
              return (
                <div key={chainAgent.id} className="chain-of-command-item">
                  <button
                    type="button"
                    className={`chain-of-command-node${isCurrent ? " chain-of-command-node--current" : ""}`}
                    onClick={() => isAncestor && onChildClick?.(chainAgent.id)}
                    disabled={!isAncestor || !onChildClick}
                    title={isCurrent ? "Current agent" : `View ${chainAgent.name}`}
                  >
                    {chainAgent.name}
                  </button>
                  {!isCurrent && (
                    <span className="chain-of-command-separator" aria-hidden="true">→</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Stats Cards */}
      <div className="dashboard-section">
        <h3>Statistics</h3>
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-value">{stats.totalRuns}</div>
            <div className="stat-label">Total Runs</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.todayRuns}</div>
            <div className="stat-label">Runs Today</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.successRate}%</div>
            <div className="stat-label">Success Rate</div>
          </div>
        </div>
      </div>

      {/* Current Task */}
      {agent.taskId && (
        <div className="dashboard-section">
          <h3>Current Task</h3>
          <div className="current-task">
            <span className="task-badge">{agent.taskId}</span>
            <a href={`/tasks/${agent.taskId}`} className="btn btn--sm">
              View Task <ExternalLink size={14} />
            </a>
          </div>
        </div>
      )}

      {/* Metadata */}
      {agent.metadata && Object.keys(agent.metadata).length > 0 && (
        <div className="dashboard-section">
          <h3>Metadata</h3>
          <pre className="metadata-json">
            {JSON.stringify(agent.metadata, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Logs Tab ──────────────────────────────────────────────────────────────

function LogsTab({ 
  logs, 
  isStreaming,
  containerRef,
  hasTask 
}: { 
  logs: AgentLogEntry[]; 
  isStreaming: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  hasTask: boolean;
}) {
  if (!hasTask) {
    return (
      <div className="logs-tab">
        <div className="logs-empty">
          <FileText size={48} opacity={0.3} />
          <p>No task assigned</p>
          <p className="text-muted">
            Agent logs are available when the agent is assigned to a task
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="logs-tab">
      <div className="logs-header">
        <span className="logs-count">{logs.length} entries</span>
        {isStreaming && (
          <span className="streaming-indicator">
            <span className="streaming-dot" />
            Live
          </span>
        )}
      </div>
      
      <div ref={containerRef} className="logs-container">
        {logs.length === 0 ? (
          <div className="logs-empty">
            <FileText size={48} opacity={0.3} />
            <p>No log entries yet</p>
            <p className="text-muted">
              {isStreaming ? "Waiting for activity..." : "Logs will appear here when the agent is active"}
            </p>
          </div>
        ) : (
          logs.map((entry, i) => {
            const prevEntry = i > 0 ? logs[i - 1] : undefined;
            const showTimestamp = !prevEntry || prevEntry.agent !== entry.agent;
            return (
              <LogEntry key={`${entry.timestamp}-${i}`} entry={entry} showTimestamp={showTimestamp} />
            );
          })
        )}
      </div>
    </div>
  );
}

function LogEntry({ entry, showTimestamp }: { entry: AgentLogEntry; showTimestamp: boolean }) {
  const getEntryStyles = () => {
    switch (entry.type) {
      case "tool":
        return {
          color: "var(--accent)",
          borderLeft: "3px solid var(--accent)",
          background: "var(--log-tool-bg)",
        };
      case "tool_result":
        return {
          color: "var(--color-success)",
          borderLeft: "3px solid var(--color-success)",
          background: "var(--log-success-bg)",
        };
      case "tool_error":
        return {
          color: "var(--color-error)",
          borderLeft: "3px solid var(--color-error)",
          background: "var(--log-error-bg)",
        };
      case "thinking":
        return {
          color: "var(--text-muted)",
          fontStyle: "italic" as const,
          opacity: 0.7,
        };
      default:
        return {
          color: "var(--text-primary)",
        };
    }
  };

  const styles = getEntryStyles();
  const timestamp = new Date(entry.timestamp).toLocaleTimeString();

  return (
    <div className="log-entry" style={styles}>
      {showTimestamp && (
        <span className="log-timestamp">[{timestamp}]</span>
      )}
      {entry.agent && (
        <span className="log-agent">[{entry.agent}]</span>
      )}
      {entry.type === "tool" && <span className="log-icon">⚡</span>}
      {entry.type === "tool_result" && <span className="log-icon">✓</span>}
      {entry.type === "tool_error" && <span className="log-icon">✗</span>}
      <span className="log-text">
        {entry.text}
        {entry.detail && (
          <span className="log-detail"> — {entry.detail}</span>
        )}
      </span>
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
}: { 
  addToast: (msg: string, type?: "success" | "error") => void;
  agentId: string;
  projectId?: string;
  agentState?: AgentState;
  agentName?: string;
}) {
  const [runs, setRuns] = useState<AgentHeartbeatRun[]>([]);
  const [isLoadingRuns, setIsLoadingRuns] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runLogs, setRunLogs] = useState<AgentLogEntry[]>([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [detailRun, setDetailRun] = useState<AgentHeartbeatRun | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  // Load runs on mount
  const loadRuns = useCallback(async () => {
    try {
      const data = await fetchAgentRuns(agentId, 50, projectId);
      setRuns(data);
    } catch (err: any) {
      addToast(`Failed to load runs: ${err.message}`, "error");
    } finally {
      setIsLoadingRuns(false);
    }
  }, [agentId, projectId, addToast]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  // Poll for active runs
  const hasActiveRun = runs.some(r => r.status === "active");
  useEffect(() => {
    if (!hasActiveRun) return;
    const interval = setInterval(() => {
      void loadRuns();
    }, 5000);
    return () => clearInterval(interval);
  }, [hasActiveRun, loadRuns]);

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
    } catch (err: any) {
      addToast(`Failed to load run details: ${err.message}`, "error");
      setRunLogs([]);
      setDetailRun(null);
    } finally {
      setIsLoadingLogs(false);
      setIsLoadingDetail(false);
    }
  }, [selectedRunId, agentId, projectId, addToast]);

  const handleRunHeartbeat = async () => {
    try {
      await startAgentRun(agentId, projectId, { source: "on_demand", triggerDetail: "Triggered from dashboard" });
      addToast(`Heartbeat run started for ${agentName ?? agentId}`, "success");
      setIsLoadingRuns(true);
      void loadRuns();
    } catch (err: any) {
      addToast(`Failed to start heartbeat run: ${err.message}`, "error");
    }
  };

  const handleStopRun = async () => {
    if (!confirm("Stop the active run? The agent's work will be interrupted.")) {
      return;
    }

    try {
      await stopAgentRun(agentId, projectId);
      addToast("Run stopped", "success");
      setIsLoadingRuns(true);
      void loadRuns();
    } catch (err: any) {
      addToast(`Failed to stop run: ${err.message}`, "error");
    }
  };

  const canRunHeartbeat = agentState === "active" || agentState === "idle";

  if (isLoadingRuns && runs.length === 0) {
    return (
      <div className="runs-tab">
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "24px", justifyContent: "center" }}>
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
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color)" }}>
            <button
              className="btn btn--sm btn--primary"
              onClick={() => void handleRunHeartbeat()}
              aria-label={`Run heartbeat for ${agentName ?? agentId}`}
            >
              <Activity size={14} /> Run Heartbeat
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
      <div style={{ fontSize: "12px", color: "var(--text-secondary)", display: "flex", gap: "12px", flexWrap: "wrap" }}>
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
          className={cn("run-card", isActive && "run-card--active", isSelected && "run-card--selected")}
          onClick={() => void handleRunClick(run.id)}
          style={{ cursor: "pointer" }}
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
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
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
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {run.invocationSource && (
                <span className="badge" style={{ fontSize: "10px", padding: "1px 6px" }}>
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
                <StatusIcon size={14} className={statusInfo.color} style={run.status === "active" ? { color: statusInfo.color } : undefined} />
                {run.status}
              </span>
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
          <div 
            className="run-logs-container"
            style={{
              padding: "12px",
              background: "var(--bg-secondary)",
              borderBottom: "1px solid var(--border-color)",
              borderTop: "1px solid var(--border-color)",
            }}
          >
            {/* Execution Details */}
            {isLoadingDetail ? (
              <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 0" }}>
                <Loader2 size={14} className="animate-spin" />
                <span className="text-muted">Loading details...</span>
              </div>
            ) : detailRun && (
              <div style={{ marginBottom: "12px" }}>
                {/* Token Usage */}
                {detailRun.usageJson && (
                  <div style={{ marginBottom: "8px" }}>
                    <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: "4px" }}>
                      Token Usage
                    </div>
                    {renderUsage(detailRun.usageJson)}
                  </div>
                )}

                {/* Output */}
                {detailRun.stdoutExcerpt && (
                  <div style={{ marginBottom: "8px" }}>
                    <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: "4px" }}>
                      Output
                    </div>
                    <pre style={{
                      background: "var(--bg-tertiary, #161b22)",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      fontSize: "12px",
                      maxHeight: "200px",
                      overflow: "auto",
                      margin: 0,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}>
                      {detailRun.stdoutExcerpt.length > 2000
                        ? `${detailRun.stdoutExcerpt.slice(0, 2000)}\n\n... (truncated, ${detailRun.stdoutExcerpt.length} chars total)`
                        : detailRun.stdoutExcerpt}
                    </pre>
                  </div>
                )}

                {/* Errors */}
                {detailRun.stderrExcerpt && (
                  <div style={{ marginBottom: "8px" }}>
                    <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", color: "var(--color-error, #f85149)", marginBottom: "4px" }}>
                      Errors
                    </div>
                    <pre style={{
                      background: "rgba(248, 81, 73, 0.1)",
                      color: "var(--color-error, #f85149)",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      fontSize: "12px",
                      maxHeight: "200px",
                      overflow: "auto",
                      margin: 0,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}>
                      {detailRun.stderrExcerpt}
                    </pre>
                  </div>
                )}

                {/* Result */}
                {detailRun.resultJson && (
                  <div style={{ marginBottom: "8px" }}>
                    <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: "4px" }}>
                      Result
                    </div>
                    <pre style={{
                      background: "var(--bg-tertiary, #161b22)",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      fontSize: "12px",
                      maxHeight: "200px",
                      overflow: "auto",
                      margin: 0,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}>
                      {JSON.stringify(detailRun.resultJson, null, 2)}
                    </pre>
                  </div>
                )}

                {/* Context */}
                {detailRun.contextSnapshot && Object.keys(detailRun.contextSnapshot).length > 0 && (
                  <div style={{ marginBottom: "8px" }}>
                    <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: "4px" }}>
                      Context
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", fontSize: "12px" }}>
                      {Object.entries(detailRun.contextSnapshot).map(([key, value]) => (
                        <span key={key}>
                          <span className="text-muted">{key}:</span>{" "}
                          <span>{String(value)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* No output state */}
                {!detailRun.stdoutExcerpt && !detailRun.stderrExcerpt && !detailRun.resultJson && (
                  <div className="text-muted" style={{ padding: "8px 0", fontStyle: "italic", fontSize: "12px" }}>
                    No output captured
                  </div>
                )}
              </div>
            )}

            {/* Run Logs */}
            <div style={{ borderTop: "1px solid var(--border-color)", paddingTop: "8px", marginTop: "4px" }}>
              <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: "4px" }}>
                Agent Logs
              </div>
              {isLoadingLogs ? (
                <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 0" }}>
                  <Loader2 size={14} className="animate-spin" />
                  <span className="text-muted">Loading logs...</span>
                </div>
              ) : runLogs.length === 0 ? (
                <div className="text-muted" style={{ padding: "8px 0", fontStyle: "italic" }}>
                  No logs available for this run
                </div>
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
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            {runs.length} run{runs.length !== 1 ? "s" : ""}
            {hasActiveRun && <span className="run-live-indicator" style={{ marginLeft: "8px" }}><span className="live-dot" />Live</span>}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
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
              className="btn btn--sm btn--primary"
              onClick={() => void handleRunHeartbeat()}
              aria-label={`Run heartbeat for ${agentName ?? agentId}`}
            >
              <Activity size={14} /> Run Heartbeat
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
      .catch((err: any) => {
        if (!cancelled) {
          setTasks([]);
          addToast(`Failed to load assigned tasks: ${err.message}`, "error");
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

  useEffect(() => {
    setSoul(agent.soul ?? "");
    setJustSaved(false);
  }, [agent.id, agent.soul]);

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
      setTimeout(() => setJustSaved(false), 3000);
      await onSaved();
    } catch (err: any) {
      addToast(`Failed to save soul: ${err.message}`, "error");
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
            <textarea
              id="agent-soul"
              className="input"
              rows={12}
              placeholder="Describe this agent's personality, tone, and behavioral traits..."
              value={soul}
              onChange={(e) => {
                setSoul(e.target.value);
                setJustSaved(false);
              }}
              style={{ fontFamily: "monospace", fontSize: "0.875rem", resize: "vertical" }}
            />
            <span className="config-hint">Defines the agent&apos;s character and identity. Max 10,000 characters.</span>
          </div>
        </div>

        <div className="config-actions">
          <button
            className="btn btn--primary"
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

  useEffect(() => {
    setMemory(agent.memory ?? "");
    setJustSaved(false);
  }, [agent.id, agent.memory]);

  const isReadOnly = agent.state === "running";
  const hasChanges = memory !== (agent.memory ?? "");

  const handleSave = async () => {
    if (memory.length > 50000) {
      addToast("Memory must be at most 50,000 characters", "error");
      return;
    }

    setIsSaving(true);
    try {
      await updateAgentMemory(agent.id, memory, projectId);
      addToast("Memory saved", "success");
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 3000);
      await onSaved();
    } catch (err: any) {
      addToast(`Failed to save memory: ${err.message}`, "error");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="config-tab">
      <div className="config-section">
        <h3>Memory</h3>
        <p className="config-description">
          Store accumulated context and learnings for this agent.
        </p>
        {isReadOnly && (
          <p className="config-hint" style={{ marginBottom: 12 }}>
            Read-only while this agent is running.
          </p>
        )}

        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="agent-memory">Agent Memory</label>
            <textarea
              id="agent-memory"
              className="input"
              rows={15}
              placeholder="Agent's accumulated knowledge, learnings, and preferences..."
              value={memory}
              readOnly={isReadOnly}
              onChange={(e) => {
                setMemory(e.target.value);
                setJustSaved(false);
              }}
              style={{ fontFamily: "monospace", fontSize: "0.875rem", resize: "vertical" }}
            />
            <span className="config-hint">Per-agent memory — stores learnings and context the agent has gathered. Max 50,000 characters.</span>
          </div>
        </div>

        <div className="config-actions">
          <button
            className="btn btn--primary"
            disabled={!hasChanges || isSaving || isReadOnly}
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
                Save Memory
              </>
            )}
          </button>
          {!hasChanges && justSaved && (
            <span className="config-saved-indicator">
              <CheckCircle size={14} />
              Memory saved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function PerformanceTab({ 
  agentId,
  projectId,
  addToast,
}: { 
  agentId: string;
  projectId?: string;
  addToast: (msg: string, type?: "success" | "error") => void;
}) {
  const [summary, setSummary] = useState<import("@fusion/core").AgentRatingSummary | null>(null);
  const [ratings, setRatings] = useState<import("@fusion/core").AgentRating[]>([]);
  const [loading, setLoading] = useState(true);
  const [newScore, setNewScore] = useState(0);
  const [newCategory, setNewCategory] = useState("");
  const [newComment, setNewComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const { fetchAgentRatingSummary, fetchAgentRatings } = await import("../api");
      const [summaryData, ratingsData] = await Promise.all([
        fetchAgentRatingSummary(agentId, projectId),
        fetchAgentRatings(agentId, { limit: 50 }, projectId),
      ]);
      setSummary(summaryData);
      setRatings(ratingsData);
    } catch (err: any) {
      addToast(`Failed to load ratings: ${err.message}`, "error");
    } finally {
      setLoading(false);
    }
  }, [agentId, projectId, addToast]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newScore === 0) return;

    setSubmitting(true);
    try {
      const { addAgentRating } = await import("../api");
      await addAgentRating(agentId, {
        score: newScore,
        category: newCategory || undefined,
        comment: newComment || undefined,
        raterType: "user",
      }, projectId);
      setNewScore(0);
      setNewCategory("");
      setNewComment("");
      addToast("Rating added", "success");
      await loadData();
    } catch (err: any) {
      addToast(`Failed to add rating: ${err.message}`, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (ratingId: string) => {
    try {
      const { deleteAgentRating } = await import("../api");
      await deleteAgentRating(agentId, ratingId, projectId);
      addToast("Rating deleted", "success");
      await loadData();
    } catch (err: any) {
      addToast(`Failed to delete rating: ${err.message}`, "error");
    }
  };

  const getTrendLabel = (trend: string) => {
    switch (trend) {
      case "improving": return "↑ Improving";
      case "declining": return "↓ Declining";
      case "stable": return "→ Stable";
      default: return "Insufficient data";
    }
  };

  const getTrendClass = (trend: string) => {
    switch (trend) {
      case "improving": return "trend-improving";
      case "declining": return "trend-declining";
      case "stable": return "trend-stable";
      default: return "trend-insufficient";
    }
  };

  const renderStars = (score: number, maxScore: number = 5) => {
    return (
      <span className="rating-stars">
        {Array.from({ length: maxScore }, (_, i) => (
          <Star
            key={i}
            size={14}
            className={i < score ? "star-filled" : "star-empty"}
            fill={i < score ? "currentColor" : "none"}
          />
        ))}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="performance-tab">
        <div className="loading-indicator">Loading ratings...</div>
      </div>
    );
  }

  return (
    <div className="performance-tab">
      {/* Summary Card */}
      {summary && (
        <div className="rating-summary-card">
          <div className="rating-score-display">
            <span className="rating-average">{summary.averageScore.toFixed(1)}</span>
            {renderStars(Math.round(summary.averageScore))}
          </div>
          <div className="rating-stats">
            <span className="rating-count">{summary.totalRatings} ratings</span>
            <span className={cn("rating-trend-badge", getTrendClass(summary.trend))}>
              {getTrendLabel(summary.trend)}
            </span>
          </div>
        </div>
      )}

      {/* Category Breakdown */}
      {summary && Object.keys(summary.categoryAverages).length > 0 && (
        <div className="category-breakdown">
          <h4>Category Averages</h4>
          {Object.entries(summary.categoryAverages).map(([category, avg]) => (
            <div key={category} className="category-item">
              <span className="category-name">{category}</span>
              <span className="category-score">{avg.toFixed(1)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Add Rating Form */}
      <form className="add-rating-form" onSubmit={handleSubmit}>
        <h4>Add Rating</h4>
        <div className="star-selector">
          {[1, 2, 3, 4, 5].map((score) => (
            <button
              key={score}
              type="button"
              className="star-btn"
              onClick={() => setNewScore(score)}
              title={`${score} star${score > 1 ? "s" : ""}`}
            >
              <Star
                size={24}
                fill={score <= newScore ? "currentColor" : "none"}
                className={score <= newScore ? "star-filled" : "star-empty"}
              />
            </button>
          ))}
        </div>
        <select
          value={newCategory}
          onChange={(e) => setNewCategory(e.target.value)}
          className="form-select"
        >
          <option value="">Select category...</option>
          <option value="quality">Quality</option>
          <option value="speed">Speed</option>
          <option value="communication">Communication</option>
          <option value="reliability">Reliability</option>
          <option value="other">Other</option>
        </select>
        <textarea
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          placeholder="Optional comment..."
          className="form-textarea"
          rows={3}
        />
        <button
          type="submit"
          className="btn-primary"
          disabled={newScore === 0 || submitting}
        >
          {submitting ? "Submitting..." : "Submit Rating"}
        </button>
      </form>

      {/* Rating History */}
      <div className="rating-history">
        <h4>Rating History</h4>
        {ratings.length === 0 ? (
          <p className="no-ratings">No ratings yet</p>
        ) : (
          ratings.map((rating) => (
            <div key={rating.id} className="rating-history-item">
              <div className="rating-item-header">
                {renderStars(rating.score)}
                {rating.category && (
                  <span className="rating-category-badge">{rating.category}</span>
                )}
                <span className="rating-time">{relativeTime(rating.createdAt)}</span>
                <button
                  className="rating-delete-btn"
                  onClick={() => handleDelete(rating.id)}
                  title="Delete rating"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {rating.comment && (
                <p className="rating-comment">{rating.comment}</p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ConfigTab({ 
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
  const [heartbeatValues, setHeartbeatValues] = useState<Record<string, string>>(() => {
    const rc = agent.runtimeConfig ?? {};
    const initial: Record<string, string> = {};
    if (rc.heartbeatIntervalMs !== undefined && rc.heartbeatIntervalMs !== null) {
      initial.heartbeatIntervalMs = String(rc.heartbeatIntervalMs);
    }
    if (rc.heartbeatTimeoutMs !== undefined && rc.heartbeatTimeoutMs !== null) {
      initial.heartbeatTimeoutMs = String(rc.heartbeatTimeoutMs);
    }
    if (rc.maxConcurrentRuns !== undefined && rc.maxConcurrentRuns !== null) {
      initial.maxConcurrentRuns = String(rc.maxConcurrentRuns);
    }
    if (rc.messageResponseMode === "immediate" || rc.messageResponseMode === "on-heartbeat") {
      initial.messageResponseMode = rc.messageResponseMode;
    }
    return initial;
  });

  // Budget config state initialised from agent.runtimeConfig.budgetConfig
  const [budgetValues, setBudgetValues] = useState<Record<string, string>>(() => {
    const bc = (agent.runtimeConfig ?? {}).budgetConfig as Record<string, unknown> | undefined;
    const initial: Record<string, string> = {};
    if (bc !== undefined && bc !== null) {
      if (bc.tokenBudget !== undefined && bc.tokenBudget !== null) {
        initial.tokenBudget = String(bc.tokenBudget);
      }
      if (bc.usageThreshold !== undefined && bc.usageThreshold !== null) {
        // Convert fraction (0-1) to percentage (0-100) for display
        initial.usageThreshold = String(Number(bc.usageThreshold) * 100);
      }
      if (bc.budgetPeriod !== undefined && bc.budgetPeriod !== null) {
        initial.budgetPeriod = String(bc.budgetPeriod);
      }
      if (bc.resetDay !== undefined && bc.resetDay !== null) {
        initial.resetDay = String(bc.resetDay);
      }
    }
    return initial;
  });

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
    } catch (err: any) {
      addToast(`Failed to reset budget: ${err.message}`, "error");
    } finally {
      setIsResettingBudget(false);
    }
  };

  const [isSaving, setIsSaving] = useState(false);
  const [isSavingInstructions, setIsSavingInstructions] = useState(false);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [justSaved, setJustSaved] = useState(false);
  const [justSavedInstructions, setJustSavedInstructions] = useState(false);

  // Custom instructions state
  const [instructionsText, setInstructionsText] = useState(agent.instructionsText ?? "");
  const [instructionsPath, setInstructionsPath] = useState(agent.instructionsPath ?? "");

  /** Detect whether any local value differs from the persisted metadata */
  const hasChanges = (() => {
    for (const field of ADVANCED_SETTINGS) {
      const current = formValues[field.key]?.trim() ?? "";
      const persisted = agent.metadata[field.key] !== undefined && agent.metadata[field.key] !== null
        ? String(agent.metadata[field.key])
        : "";
      if (current !== persisted) return true;
    }
    // Check heartbeat values
    const rc = agent.runtimeConfig ?? {};
    for (const key of ["heartbeatIntervalMs", "heartbeatTimeoutMs", "maxConcurrentRuns", "messageResponseMode"] as const) {
      const current = heartbeatValues[key]?.trim() ?? "";
      const persisted = rc[key] !== undefined && rc[key] !== null ? String(rc[key]) : "";
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

    return false;
  })();

  const hasInstructionsChanges = (() => {
    const currentText = instructionsText ?? "";
    const persistedText = agent.instructionsText ?? "";
    const currentPath = instructionsPath?.trim() ?? "";
    const persistedPath = agent.instructionsPath?.trim() ?? "";
    return currentText !== persistedText || currentPath !== persistedPath;
  })();

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
      heartbeatIntervalMs: { label: "Heartbeat Interval", min: 1000 },
      heartbeatTimeoutMs: { label: "Heartbeat Timeout", min: 5000 },
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

    // Build the runtimeConfig payload — only include non-empty values
    const newRuntimeConfig: Record<string, unknown> = { ...agent.runtimeConfig };
    for (const key of ["heartbeatIntervalMs", "heartbeatTimeoutMs", "maxConcurrentRuns"] as const) {
      const raw = heartbeatValues[key]?.trim();
      if (!raw) {
        delete newRuntimeConfig[key];
      } else {
        newRuntimeConfig[key] = Number(raw);
      }
    }

    const messageResponseMode = heartbeatValues.messageResponseMode?.trim();
    if (!messageResponseMode) {
      delete newRuntimeConfig.messageResponseMode;
    } else {
      newRuntimeConfig.messageResponseMode = messageResponseMode;
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

    setIsSaving(true);
    try {
      await updateAgent(agent.id, { metadata: newMetadata, runtimeConfig: newRuntimeConfig }, projectId);
      addToast("Settings saved", "success");
      setJustSaved(true);
      // Auto-hide the saved indicator after 3 seconds
      setTimeout(() => setJustSaved(false), 3000);
      await onSaved();
    } catch (err: any) {
      addToast(`Failed to save settings: ${err.message}`, "error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveInstructions = async () => {
    setIsSavingInstructions(true);
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
      setJustSavedInstructions(true);
      setTimeout(() => setJustSavedInstructions(false), 3000);
      await onSaved();
    } catch (err: any) {
      addToast(`Failed to save instructions: ${err.message}`, "error");
    } finally {
      setIsSavingInstructions(false);
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
            <label>Name</label>
            <input 
              type="text" 
              className="input" 
              defaultValue={agent.name}
              disabled
            />
            <span className="config-hint">Name changes coming soon</span>
          </div>
          
          <div className="config-field">
            <label>Role</label>
            <select className="select" defaultValue={agent.role} disabled>
              <option value="triage">Triage</option>
              <option value="executor">Executor</option>
              <option value="reviewer">Reviewer</option>
              <option value="merger">Merger</option>
              <option value="scheduler">Scheduler</option>
              <option value="custom">Custom</option>
            </select>
            <span className="config-hint">Role changes coming soon</span>
          </div>
        </div>
      </div>

      <div className="config-section">
        <h3>Heartbeat Settings</h3>
        <p className="config-description">
          Configure how this agent's heartbeat is monitored. Leave a field empty to use system defaults.
        </p>

        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="hb-heartbeatIntervalMs">Heartbeat Interval (ms)</label>
            <input
              id="hb-heartbeatIntervalMs"
              type="text"
              inputMode="numeric"
              className={cn("input", !!errors.heartbeatIntervalMs && "input--error")}
              placeholder="30000"
              value={heartbeatValues.heartbeatIntervalMs ?? ""}
              onChange={(e) => handleHeartbeatFieldChange("heartbeatIntervalMs", e.target.value)}
            />
            {errors.heartbeatIntervalMs ? (
              <span className="config-error">{errors.heartbeatIntervalMs}</span>
            ) : (
              <span className="config-hint">How often heartbeats are checked. Leave empty for system default (30000ms)</span>
            )}
          </div>

          <div className="config-field">
            <label htmlFor="hb-heartbeatTimeoutMs">Heartbeat Timeout (ms)</label>
            <input
              id="hb-heartbeatTimeoutMs"
              type="text"
              inputMode="numeric"
              className={cn("input", !!errors.heartbeatTimeoutMs && "input--error")}
              placeholder="60000"
              value={heartbeatValues.heartbeatTimeoutMs ?? ""}
              onChange={(e) => handleHeartbeatFieldChange("heartbeatTimeoutMs", e.target.value)}
            />
            {errors.heartbeatTimeoutMs ? (
              <span className="config-error">{errors.heartbeatTimeoutMs}</span>
            ) : (
              <span className="config-hint">Time without heartbeat before agent is considered unresponsive. Leave empty for system default (60000ms)</span>
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
            className="btn btn--primary"
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

      <div className="config-section">
        <h3>Custom Instructions</h3>
        <p className="config-description">
          Append custom instructions to this agent&apos;s system prompt at execution time. Use this to customize behavior, coding style, or project conventions without modifying built-in prompts.
        </p>

        <div className="config-fields">
          <div className="config-field">
            <label htmlFor="instructions-text">Inline Instructions</label>
            <textarea
              id="instructions-text"
              className="input"
              rows={10}
              placeholder="Enter custom instructions to append to this agent's system prompt..."
              value={instructionsText}
              onChange={(e) => {
                setInstructionsText(e.target.value);
                setJustSavedInstructions(false);
              }}
              style={{ fontFamily: "monospace", fontSize: "0.875rem", resize: "vertical" }}
            />
            <span className="config-hint">Markdown formatting supported. Max 50,000 characters.</span>
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
                setJustSavedInstructions(false);
              }}
            />
            <span className="config-hint">Path to a .md file (relative to project root). Contents are read and appended at execution time.</span>
          </div>
        </div>

        <div className="config-actions">
          <button
            className="btn btn--primary"
            disabled={!hasInstructionsChanges || isSavingInstructions}
            onClick={() => void handleSaveInstructions()}
          >
            {isSavingInstructions ? (
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
          {!hasInstructionsChanges && justSavedInstructions && (
            <span className="config-saved-indicator">
              <CheckCircle size={14} />
              Instructions saved
            </span>
          )}
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
        <div className="detail-section-body" style={{ display: "flex", alignItems: "center", gap: 8, padding: 16 }}>
          <Loader2 size={16} className="spin" />
          <span className="text-secondary">Loading employees...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="detail-section">
      <div className="detail-section-header">
        <h3>Employees</h3>
        <span className="text-secondary">({children.length})</span>
      </div>
      <div className="detail-section-body">
        {children.length === 0 ? (
          <div className="agent-empty" style={{ padding: 24 }}>
            <GitBranch size={32} opacity={0.3} />
            <p>No employees</p>
            <p className="text-secondary">This agent has no employees</p>
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
                  onKeyDown={(e) => e.key === "Enter" && onChildClick?.(child.id)}
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
