import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { 
  Bot, Heart, Activity, Pause, Play, Square, Trash2, RefreshCw, 
  Settings, FileText, ActivitySquare, X, Copy, 
  ExternalLink, CheckCircle, XCircle, Loader2
} from "lucide-react";
import type { AgentDetail, AgentState, AgentHeartbeatRun } from "../api";
import { fetchAgent, updateAgent, updateAgentState, deleteAgent, fetchAgentLogs } from "../api";
import type { AgentLogEntry } from "@fusion/core";

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
}

type TabId = "dashboard" | "logs" | "config" | "runs";

const TABS: { id: TabId; label: string; icon: typeof Activity }[] = [
  { id: "dashboard", label: "Dashboard", icon: ActivitySquare },
  { id: "logs", label: "Logs", icon: FileText },
  { id: "runs", label: "Runs", icon: Activity },
  { id: "config", label: "Settings", icon: Settings },
];

const STATE_COLORS: Record<AgentState, { bg: string; text: string; border: string }> = {
  idle: { bg: "rgba(139, 148, 158, 0.15)", text: "#8b949e", border: "#8b949e" },
  active: { bg: "rgba(46, 160, 67, 0.15)", text: "#3fb950", border: "#3fb950" },
  paused: { bg: "rgba(227, 179, 65, 0.15)", text: "#e3b541", border: "#e3b541" },
  terminated: { bg: "rgba(248, 81, 73, 0.15)", text: "#f85149", border: "#f85149" },
};

const RUN_STATUS_ICONS: Record<string, { icon: typeof CheckCircle; color: string }> = {
  completed: { icon: CheckCircle, color: "text-green-500" },
  failed: { icon: XCircle, color: "text-red-500" },
  active: { icon: Loader2, color: "text-cyan-500 animate-spin" },
  terminated: { icon: Square, color: "text-gray-500" },
};

export function AgentDetailView({ agentId, projectId, onClose, addToast }: AgentDetailViewProps) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [logs, setLogs] = useState<AgentLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [isStreaming, setIsStreaming] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const loadAgent = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchAgent(agentId, projectId);
      setAgent(data);
    } catch (err: any) {
      addToast(`Failed to load agent: ${err.message}`, "error");
      onClose();
    } finally {
      setIsLoading(false);
    }
  }, [agentId, addToast, onClose, projectId]);

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

  const getHealthStatus = () => {
    if (!agent) return { label: "Unknown", color: "#888" };
    if (agent.state === "terminated") {
      return { label: "Terminated", color: "#f85149" };
    }
    if (agent.state === "paused") {
      return { label: "Paused", color: "#e3b541" };
    }
    if (!agent.lastHeartbeatAt) {
      return { label: agent.state === "active" ? "Starting..." : "Idle", color: "#8b949e" };
    }
    const lastHeartbeat = new Date(agent.lastHeartbeatAt).getTime();
    const elapsed = Date.now() - lastHeartbeat;
    const timeoutMs = 60000;
    if (elapsed > timeoutMs) {
      return { label: "Unresponsive", color: "#f85149" };
    }
    return { label: "Healthy", color: "#3fb950" };
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
  const runs = (agent as any).completedRuns || [];
  const activeRun = (agent as any).activeRun;

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
                  {health.label === "Healthy" && <Heart size={12} />}
                  {health.label === "Unresponsive" && <Activity size={12} />}
                  {health.label}
                </span>
              </div>
            </div>
          </div>
          
          <div className="agent-detail-actions">
            {/* State-dependent action buttons */}
            {agent.state === "idle" && (
              <button className="btn btn--primary" onClick={() => void handleStateChange("active")}>
                <Play size={16} />
                Start
              </button>
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
            {agent.state === "terminated" && (
              <button className="btn btn--danger" onClick={handleDelete}>
                <Trash2 size={16} />
                Delete
              </button>
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
            <DashboardTab agent={agent} health={health} />
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
              runs={runs} 
              activeRun={activeRun}
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

      <style>{`
        .agent-detail-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.6);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 20px;
        }

        .agent-detail-modal {
          background: var(--bg-primary);
          border: 1px solid var(--border);
          border-radius: 12px;
          width: 100%;
          max-width: 900px;
          max-height: 85vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        }

        .agent-detail-loading {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          padding: 60px;
          color: var(--text-muted);
        }

        .agent-detail-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 20px 24px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-secondary);
        }

        .agent-detail-title {
          display: flex;
          align-items: center;
          gap: 16px;
        }

        .agent-detail-icon {
          width: 48px;
          height: 48px;
          border-radius: 12px;
          background: var(--accent);
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
        }

        .agent-detail-info h2 {
          font-size: 20px;
          font-weight: 600;
          margin: 0 0 6px 0;
        }

        .agent-detail-badges {
          display: flex;
          gap: 8px;
        }

        .agent-detail-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .agent-detail-tabs {
          display: flex;
          gap: 4px;
          padding: 0 24px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-secondary);
        }

        .agent-detail-tab {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 16px;
          background: none;
          border: none;
          border-bottom: 2px solid transparent;
          color: var(--text-muted);
          font-size: 14px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .agent-detail-tab:hover {
          color: var(--text-primary);
          background: var(--bg-hover);
        }

        .agent-detail-tab.active {
          color: var(--accent);
          border-bottom-color: var(--accent);
        }

        .agent-detail-content {
          flex: 1;
          overflow-y: auto;
          padding: 24px;
        }

        .agent-detail-footer {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 24px;
          border-top: 1px solid var(--border);
          background: var(--bg-secondary);
          font-size: 12px;
          color: var(--text-muted);
        }

        .agent-detail-id {
          font-family: var(--font-mono);
          cursor: pointer;
        }

        .agent-detail-id:hover {
          color: var(--text-primary);
        }

        .divider {
          color: var(--border);
        }

        .text-muted {
          color: var(--text-muted);
        }

        .link {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          color: var(--accent);
          text-decoration: none;
        }

        .link:hover {
          text-decoration: underline;
        }
      `}</style>
    </div>
  );
}

// ── Dashboard Tab ───────────────────────────────────────────────────────────

function DashboardTab({ 
  agent, 
  health 
}: { 
  agent: AgentDetail; 
  health: { label: string; color: string };
}) {
  const stateStyle = STATE_COLORS[agent.state];
  
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

      <style>{`
        .dashboard-tab {
          display: flex;
          flex-direction: column;
          gap: 24px;
        }

        .dashboard-section {
          background: var(--bg-secondary);
          border-radius: 8px;
          padding: 20px;
        }

        .dashboard-section h3 {
          font-size: 14px;
          font-weight: 600;
          margin: 0 0 16px 0;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .info-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
          gap: 16px;
        }

        .info-item {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .info-label {
          font-size: 12px;
          color: var(--text-muted);
        }

        .info-value {
          font-size: 14px;
          font-weight: 500;
        }

        .inline-badge {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          text-transform: capitalize;
        }

        .stats-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
        }

        .stat-card {
          background: var(--bg-primary);
          border-radius: 8px;
          padding: 16px;
          text-align: center;
        }

        .stat-value {
          font-size: 28px;
          font-weight: 700;
          color: var(--accent);
        }

        .stat-label {
          font-size: 12px;
          color: var(--text-muted);
          margin-top: 4px;
        }

        .current-task {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .task-badge {
          font-family: var(--font-mono);
          background: var(--bg-primary);
          padding: 6px 12px;
          border-radius: 4px;
          font-size: 14px;
        }

        .metadata-json {
          background: var(--bg-primary);
          padding: 12px;
          border-radius: 4px;
          font-size: 12px;
          overflow-x: auto;
          margin: 0;
        }
      `}</style>
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

          <style>{`
            .logs-tab {
              display: flex;
              flex-direction: column;
              height: 100%;
            }

            .logs-empty {
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              padding: 48px;
              color: var(--text-muted);
              text-align: center;
            }

            .logs-empty p {
              margin: 8px 0 0 0;
            }
          `}</style>
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
          logs.map((entry, i) => (
            <LogEntry key={`${entry.timestamp}-${i}`} entry={entry} />
          ))
        )}
      </div>

      <style>{`
        .logs-tab {
          display: flex;
          flex-direction: column;
          height: 100%;
        }

        .logs-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 12px;
          margin-bottom: 12px;
          border-bottom: 1px solid var(--border);
        }

        .logs-count {
          font-size: 12px;
          color: var(--text-muted);
        }

        .streaming-indicator {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: var(--success);
        }

        .streaming-dot {
          width: 8px;
          height: 8px;
          background: var(--success);
          border-radius: 50%;
          animation: pulse 1.5s infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }

        .logs-container {
          flex: 1;
          overflow-y: auto;
          font-family: var(--font-mono);
          font-size: 13px;
          line-height: 1.6;
          max-height: 400px;
        }

        .logs-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 48px;
          color: var(--text-muted);
          text-align: center;
        }

        .logs-empty p {
          margin: 8px 0 0 0;
        }
      `}</style>
    </div>
  );
}

function LogEntry({ entry }: { entry: AgentLogEntry }) {
  const getEntryStyles = () => {
    switch (entry.type) {
      case "tool":
        return {
          color: "var(--accent)",
          borderLeft: "3px solid var(--accent)",
          background: "rgba(124, 92, 191, 0.08)",
        };
      case "tool_result":
        return {
          color: "var(--success)",
          borderLeft: "3px solid var(--success)",
          background: "rgba(76, 175, 80, 0.06)",
        };
      case "tool_error":
        return {
          color: "var(--error)",
          borderLeft: "3px solid var(--error)",
          background: "rgba(229, 57, 53, 0.06)",
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
      <span className="log-timestamp">[{timestamp}]</span>
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

      <style>{`
        .log-entry {
          display: flex;
          gap: 8px;
          padding: 4px 8px;
          margin: 2px 0;
          border-radius: 4px;
        }

        .log-timestamp {
          color: var(--text-muted);
          font-size: 11px;
          flex-shrink: 0;
        }

        .log-agent {
          color: var(--text-muted);
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          flex-shrink: 0;
        }

        .log-icon {
          flex-shrink: 0;
        }

        .log-text {
          word-break: break-word;
        }

        .log-detail {
          color: var(--text-muted);
          font-size: 12px;
        }
      `}</style>
    </div>
  );
}

// ── Runs Tab ───────────────────────────────────────────────────────────────

function RunsTab({ 
  runs, 
  activeRun,
  addToast 
}: { 
  runs: AgentHeartbeatRun[]; 
  activeRun?: AgentHeartbeatRun;
  addToast: (msg: string, type?: "success" | "error") => void;
}) {
  if (runs.length === 0 && !activeRun) {
    return (
      <div className="runs-empty">
        <Activity size={48} opacity={0.3} />
        <p>No runs yet</p>
        <p className="text-muted">Heartbeat runs will appear here</p>

        <style>{`
          .runs-empty {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 48px;
            color: var(--text-muted);
            text-align: center;
          }
          .runs-empty p {
            margin: 8px 0 0 0;
          }
        `}</style>
      </div>
    );
  }

  const sortedRuns = [...runs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  return (
    <div className="runs-tab">
      {activeRun && (
        <div className="run-card run-card--active">
          <div className="run-header">
            <span className="run-live-indicator">
              <span className="live-dot" />
              Live Run
            </span>
            <span className="run-status active">
              <Loader2 size={14} className="animate-spin" />
              Active
            </span>
          </div>
          <div className="run-details">
            <span>Started {relativeTime(activeRun.startedAt)}</span>
          </div>
        </div>
      )}

      {sortedRuns.map((run, i) => {
        const statusInfo = RUN_STATUS_ICONS[run.status] || RUN_STATUS_ICONS.completed;
        const StatusIcon = statusInfo.icon;
        const duration = run.endedAt 
          ? formatDuration(new Date(run.startedAt), new Date(run.endedAt))
          : "In progress";

        return (
          <div key={run.id} className="run-card">
            <div className="run-header">
              <span className="run-id">#{i + 1} {run.id.slice(0, 8)}</span>
              <span className={cn("run-status", run.status)}>
                <StatusIcon size={14} className={statusInfo.color} />
                {run.status}
              </span>
            </div>
            <div className="run-details">
              <span>Started {relativeTime(run.startedAt)}</span>
              <span>•</span>
              <span>{duration}</span>
            </div>
          </div>
        );
      })}

      <style>{`
        .runs-tab {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .run-card {
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 16px;
        }

        .run-card--active {
          border-color: var(--cyan, #06b6d4);
          background: rgba(6, 182, 212, 0.05);
        }

        .run-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }

        .run-live-indicator {
          display: flex;
          align-items: center;
          gap: 6px;
          font-weight: 600;
          color: var(--cyan, #06b6d4);
        }

        .live-dot {
          width: 8px;
          height: 8px;
          background: var(--cyan, #06b6d4);
          border-radius: 50%;
          animation: pulse 1.5s infinite;
        }

        .run-id {
          font-family: var(--font-mono);
          font-size: 13px;
          color: var(--text-muted);
        }

        .run-status {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          text-transform: capitalize;
        }

        .run-status.active {
          color: var(--cyan, #06b6d4);
        }

        .run-status.completed {
          color: var(--success);
        }

        .run-status.failed {
          color: var(--error);
        }

        .run-status.terminated {
          color: var(--text-muted);
        }

        .run-details {
          display: flex;
          gap: 8px;
          font-size: 12px;
          color: var(--text-muted);
        }
      `}</style>
    </div>
  );
}

function formatDuration(start: Date, end: Date): string {
  const diff = Math.floor((end.getTime() - start.getTime()) / 1000);
  
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
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
    key: "heartbeatIntervalMs",
    label: "Heartbeat Interval (ms)",
    type: "number",
    placeholder: "30000",
    hint: "How often the agent sends heartbeats (minimum 1000ms, default 30000ms)",
    min: 1000,
    max: 600000,
  },
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

  const [isSaving, setIsSaving] = useState(false);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [justSaved, setJustSaved] = useState(false);

  /** Detect whether any local value differs from the persisted metadata */
  const hasChanges = (() => {
    for (const field of ADVANCED_SETTINGS) {
      const current = formValues[field.key]?.trim() ?? "";
      const persisted = agent.metadata[field.key] !== undefined && agent.metadata[field.key] !== null
        ? String(agent.metadata[field.key])
        : "";
      if (current !== persisted) return true;
    }
    return false;
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

  const handleSave = async () => {
    // Validate before save
    const validationErrors = validateAdvancedSettings(formValues);
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

    setIsSaving(true);
    try {
      await updateAgent(agent.id, { metadata: newMetadata }, projectId);
      addToast("Advanced settings saved", "success");
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

      <style>{`
        .config-tab {
          display: flex;
          flex-direction: column;
          gap: 24px;
        }

        .config-section {
          background: var(--bg-secondary);
          border-radius: 8px;
          padding: 20px;
        }

        .config-section h3 {
          font-size: 16px;
          font-weight: 600;
          margin: 0 0 8px 0;
        }

        .config-description {
          font-size: 14px;
          color: var(--text-muted);
          margin: 0 0 20px 0;
        }

        .config-fields {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .config-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .config-field label {
          font-size: 13px;
          font-weight: 500;
        }

        .config-hint {
          font-size: 11px;
          color: var(--text-muted);
          font-style: italic;
        }

        .config-error {
          font-size: 11px;
          color: var(--error, #f85149);
        }

        .input--error {
          border-color: var(--error, #f85149) !important;
        }

        .config-actions {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-top: 20px;
          padding-top: 16px;
          border-top: 1px solid var(--border);
        }

        .config-saved-indicator {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          color: var(--success, #3fb950);
        }
      `}</style>
    </div>
  );
}
