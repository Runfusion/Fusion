import { useEffect, useState } from "react";
import { Activity, FileText } from "lucide-react";
import type { Agent } from "../api";
import type { TaskDetail } from "@fusion/core";
import { fetchTaskDetail } from "../api";
import "./ActiveAgentsPanel.css";
import { useLiveTranscript } from "../hooks/useLiveTranscript";

interface LiveAgentCardProps {
  agent: Agent;
  projectId?: string;
  onSelect?: (agentId: string) => void;
  onOpenTaskLogs?: (taskId: string) => void;
}

const TASK_STATUS_POLL_MS = 5000;

function LiveAgentCard({ agent, projectId, onSelect, onOpenTaskLogs }: LiveAgentCardProps) {
  const { entries, isConnected } = useLiveTranscript(agent.taskId, projectId);
  const [task, setTask] = useState<TaskDetail | null>(null);

  // Poll the agent's task so the empty state can show real run progress
  // (current step, executor model) instead of just "Connecting..." while the
  // SSE log stream is still warming up.
  useEffect(() => {
    if (!agent.taskId) {
      setTask(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const data = await fetchTaskDetail(agent.taskId!, projectId);
        if (!cancelled) setTask(data);
      } catch {
        // best-effort; leave previous value in place
      } finally {
        if (!cancelled) {
          timer = setTimeout(load, TASK_STATUS_POLL_MS);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agent.taskId, projectId]);

  const elapsed = agent.lastHeartbeatAt
    ? Math.floor((Date.now() - new Date(agent.lastHeartbeatAt).getTime()) / 1000)
    : 0;

  const currentStep = task?.steps?.[task.currentStep ?? 0];
  const totalSteps = task?.steps?.length ?? 0;
  const stepNumber = (task?.currentStep ?? 0) + 1;
  const executorModel = task?.modelId;

  const handleSelect = () => {
    if (onSelect) {
      onSelect(agent.id);
    }
  };

  const handleViewLogs = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (agent.taskId && onOpenTaskLogs) {
      onOpenTaskLogs(agent.taskId);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleSelect();
    }
  };

  return (
    <div
      className="live-agent-card"
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`Select agent ${agent.name}`}
    >
      <div className="live-agent-card-header">
        <div className="live-agent-card-name">
          <span className="live-agent-pulse" />
          <span>{agent.name}</span>
        </div>
        {agent.taskId && (
          <span className="live-agent-task badge">{agent.taskId}</span>
        )}
      </div>
      <div className="live-agent-card-transcript">
        {entries.length === 0 ? (
          <div className="live-agent-card-empty">
            {!agent.taskId ? (
              // "active" agents that aren't currently working a task have no
              // SSE stream to attach to; useLiveTranscript bails out with
              // isConnected=false. Showing "Connecting..." here is misleading
              // — the agent is just idle.
              <span>{agent.state === "running" ? "Starting..." : "Idle — no task assigned"}</span>
            ) : currentStep ? (
              <>
                <div className="live-agent-card-status">
                  Step {stepNumber}
                  {totalSteps ? `/${totalSteps}` : ""}: {currentStep.name}
                </div>
                {executorModel && (
                  <div className="live-agent-card-status-sub">
                    {executorModel}
                  </div>
                )}
                <div className="live-agent-card-status-sub">
                  {isConnected ? "Waiting for output..." : "Connecting to log stream..."}
                </div>
              </>
            ) : (
              <span>{isConnected ? "Waiting for output..." : "Connecting..."}</span>
            )}
          </div>
        ) : (
          entries.slice(0, 20).map((entry, i) => (
            <div key={i} className="live-agent-card-line">
              {entry.text}
            </div>
          ))
        )}
      </div>
      <div className="live-agent-card-footer">
        <span className="text-secondary">{formatElapsed(elapsed)}</span>
        <div className="live-agent-card-footer-actions">
          {agent.taskId && onOpenTaskLogs && (
            <button
              type="button"
              className="live-agent-card-logs-btn"
              onClick={handleViewLogs}
              title="View live run logs"
              aria-label={`View live logs for ${agent.taskId}`}
            >
              <FileText size={12} />
              <span>Live logs</span>
            </button>
          )}
          {isConnected && <Activity size={12} className="live-agent-streaming-dot" />}
        </div>
      </div>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

interface ActiveAgentsPanelProps {
  agents: Agent[];
  projectId?: string;
  onAgentSelect?: (agentId: string) => void;
  onOpenTaskLogs?: (taskId: string) => void;
}

export function ActiveAgentsPanel({ agents, projectId, onAgentSelect, onOpenTaskLogs }: ActiveAgentsPanelProps) {
  // Dedupe by id defensively. The store should return unique agents but a race
  // between the initial fetch and an SSE refresh can briefly surface the same
  // agent twice — without this guard React floods the console with duplicate
  // key warnings (which previously snowballed into OOM).
  const uniqueAgents = Array.from(new Map(agents.map((a) => [a.id, a])).values());

  if (uniqueAgents.length === 0) return null;

  return (
    <div className="active-agents-panel">
      <div className="active-agents-panel-header">
        <Activity size={16} />
        <span>Active Agents ({uniqueAgents.length})</span>
      </div>
      <div className="active-agents-grid">
        {uniqueAgents.map(agent => (
          <LiveAgentCard key={agent.id} agent={agent} projectId={projectId} onSelect={onAgentSelect} onOpenTaskLogs={onOpenTaskLogs} />
        ))}
      </div>
    </div>
  );
}
