import { useState, useEffect } from "react";
import { CheckCircle, XCircle, Loader2, Square, Clock } from "lucide-react";
import type { AgentHeartbeatRun } from "../api";
import { fetchAgentRuns } from "../api";

interface AgentRunHistoryProps {
  agentId: string;
  projectId?: string;
}

const STATUS_ICONS: Record<string, { icon: typeof CheckCircle; color: string }> = {
  completed: { icon: CheckCircle, color: "var(--color-success, #3fb950)" },
  failed: { icon: XCircle, color: "var(--color-error, #f85149)" },
  active: { icon: Loader2, color: "var(--in-progress, #bc8cff)" },
  terminated: { icon: Square, color: "var(--text-muted, #8b949e)" },
};

export function AgentRunHistory({ agentId, projectId }: AgentRunHistoryProps) {
  const [runs, setRuns] = useState<AgentHeartbeatRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
    fetchAgentRuns(agentId, 50, projectId)
      .then(setRuns)
      .catch(() => setRuns([]))
      .finally(() => setIsLoading(false));
  }, [agentId, projectId]);

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
          <div key={run.id} className="agent-run-row">
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
          </div>
        );
      })}
    </div>
  );
}
