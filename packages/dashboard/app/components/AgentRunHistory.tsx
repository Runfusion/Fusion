import { useState, useEffect, useCallback } from "react";
import { CheckCircle, XCircle, Loader2, Square, Clock } from "lucide-react";
import type { AgentHeartbeatRun } from "../api";
import { fetchAgentRuns, stopAgentRun } from "../api";
import { useConfirm } from "../hooks/useConfirm";

interface AgentRunHistoryProps {
  agentId: string;
  projectId?: string;
  /** Optional callback when a run row is clicked */
  onRunClick?: (runId: string) => void;
}

const STATUS_ICONS: Record<string, { icon: typeof CheckCircle; color: string }> = {
  completed: { icon: CheckCircle, color: "var(--color-success, #3fb950)" },
  failed: { icon: XCircle, color: "var(--color-error, #f85149)" },
  active: { icon: Loader2, color: "var(--in-progress, #bc8cff)" },
  terminated: { icon: Square, color: "var(--text-muted, #8b949e)" },
};

export function AgentRunHistory({ agentId, projectId, onRunClick }: AgentRunHistoryProps) {
  const [runs, setRuns] = useState<AgentHeartbeatRun[]>([]);
  const { confirm } = useConfirm();
  const [isLoading, setIsLoading] = useState(true);

  const loadRuns = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchAgentRuns(agentId, 50, projectId);
      setRuns(data);
    } catch {
      setRuns([]);
    } finally {
      setIsLoading(false);
    }
  }, [agentId, projectId]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const handleStop = useCallback(async () => {
    const shouldStop = await confirm({
      title: "Stop Run",
      message: "Stop this run?",
      danger: true,
    });
    if (!shouldStop) {
      return;
    }

    try {
      await stopAgentRun(agentId, projectId);
      await loadRuns();
    } catch {
      // No-op: keep history view usable even if stop fails.
    }
  }, [agentId, projectId, loadRuns, confirm]);

  if (isLoading) {
    return <div className="agent-run-loading"><Loader2 className="animate-spin" size={20} /> Loading runs...</div>;
  }

  if (runs.length === 0) {
    return <div className="agent-run-empty">No runs yet</div>;
  }

  return (
    <div className="agent-run-history">
      {runs.map(run => {
        const statusInfo = STATUS_ICONS[run.status] ?? STATUS_ICONS.terminated;
        const StatusIcon = statusInfo.icon;
        const duration = run.endedAt
          ? Math.round((new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
          : null;
        const usage = run.usageJson;

        return (
          <div
            key={run.id}
            className={onRunClick ? "agent-run-row agent-run-row--clickable" : "agent-run-row"}
            onClick={onRunClick ? () => onRunClick(run.id) : undefined}
            role={onRunClick ? "button" : undefined}
            tabIndex={onRunClick ? 0 : undefined}
            aria-label={onRunClick ? `Run ${run.id.slice(0, 8)}, ${run.status}` : undefined}
            onKeyDown={onRunClick ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onRunClick(run.id);
              }
            } : undefined}
          >
            <StatusIcon size={16} style={{ color: statusInfo.color }} className={run.status === "active" ? "animate-spin" : ""} />
            <div className="agent-run-info">
              <span className="agent-run-id">{run.id}</span>
              <span className="text-secondary">{new Date(run.startedAt).toLocaleString()}</span>
            </div>
            <div className="agent-run-meta">
              {duration !== null && (
                <span className="badge"><Clock size={12} /> {duration}s</span>
              )}
              {usage && (
                <span className="badge text-secondary">
                  {((usage.inputTokens + usage.outputTokens) / 1000).toFixed(1)}k tokens
                </span>
              )}
              {run.triggerDetail && (
                <span className="badge text-secondary">{run.triggerDetail}</span>
              )}
            </div>
            {run.status === "active" && (
              <button
                className="btn btn--sm btn--danger"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void handleStop();
                }}
                aria-label="Stop run"
                style={{ marginLeft: "8px" }}
              >
                <Square size={12} /> Stop
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
