import { useEffect, useRef, useState } from "react";
import { Activity, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Agent } from "../api";
import type { TaskDetail } from "@fusion/core";
import { fetchTaskDetail } from "../api";
import "./ActiveAgentsPanel.css";
import { useLiveTranscript } from "../hooks/useLiveTranscript";
import { resolveHeartbeatIntervalMs } from "../utils/heartbeatIntervals";
import { AgentTaskBadge } from "./AgentTaskBadge";
import { RuntimeFallbackBadge } from "./RuntimeFallbackBadge";
import { getCanonicalStepNumber } from "../lib/step-display";

interface LiveAgentCardProps {
  agent: Agent;
  projectId?: string;
  onSelect?: (agentId: string) => void;
  onOpenTaskLogs?: (taskId: string) => void;
}

const TASK_STATUS_POLL_MS = 5000;

function LiveAgentCard({ agent, projectId, onSelect, onOpenTaskLogs }: LiveAgentCardProps) {
  const { t } = useTranslation("app");
  const { entries, isConnected } = useLiveTranscript(agent.taskId, projectId);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // FUX-039: real viewport gating (matching TaskCard.tsx's pattern) so
  // RuntimeFallbackBadge's 30s poll only runs while this card is actually
  // visible, rather than hardcoding isInViewport={true} for every mounted
  // card regardless of scroll position.
  const [isInViewport, setIsInViewport] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setIsInViewport(true);
      return;
    }

    const element = cardRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsInViewport(entry?.isIntersecting ?? true);
      },
      { rootMargin: "200px" },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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

  // Compute next heartbeat ETA from last + interval. Negative deltas mean the
  // beat is overdue — surface that explicitly rather than rendering a stale
  // future time.
  const nextHeartbeatLabel = (() => {
    if (!agent.lastHeartbeatAt) return null;
    const intervalMs = resolveHeartbeatIntervalMs(
      (agent.runtimeConfig as { heartbeatIntervalMs?: number } | undefined)?.heartbeatIntervalMs,
    );
    const nextMs = new Date(agent.lastHeartbeatAt).getTime() + intervalMs;
    const deltaSec = Math.round((nextMs - Date.now()) / 1000);
    if (!Number.isFinite(deltaSec)) return null;
    if (deltaSec <= 0) return t("agents.heartbeatOverdue", "Heartbeat overdue {{elapsed}}", { elapsed: formatElapsed(-deltaSec) });
    return t("agents.nextHeartbeat", "Next heartbeat in {{elapsed}}", { elapsed: formatElapsed(deltaSec) });
  })();

  // FNXC:TaskStepNumbering 2026-07-05-00:00: use the canonical (0-based, PROMPT-numbered) step
  // number so this indicator agrees with the Activity tab for the same underlying step (FN-7612).
  const { stepNumber, totalSteps } = getCanonicalStepNumber(task);
  const currentStep = task?.steps?.[stepNumber];
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
      ref={cardRef}
      className="live-agent-card"
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={t("agents.selectAgent", "Select agent {{name}}", { name: agent.name })}
    >
      <div className="live-agent-card-header">
        <div className="live-agent-card-name">
          <span
            className={`status-dot ${agent.state === "running" ? "status-dot--pending" : "status-dot--online"}`}
            aria-hidden="true"
          />
          <span>{agent.name}</span>
        </div>
        {agent.taskId && (
          <span className="live-agent-task badge"><AgentTaskBadge taskId={agent.taskId} taskColumn={agent.taskColumn} /></span>
        )}
        {agent.taskId && (
          <RuntimeFallbackBadge taskId={agent.taskId} isInViewport={isInViewport} projectId={projectId} />
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
              <span>{agent.state === "running" ? t("agents.starting", "Starting...") : t("agents.idleNoTask", "Idle — no task assigned")}</span>
            ) : currentStep ? (
              <>
                <div className="live-agent-card-status">
                  {t("agents.step", "Step {{number}}{{total}}: {{name}}", { number: stepNumber, total: totalSteps ? `/${totalSteps}` : "", name: currentStep.name })}
                </div>
                {executorModel && (
                  <div className="live-agent-card-status-sub">
                    {executorModel}
                  </div>
                )}
                <div className="live-agent-card-status-sub">
                  {isConnected ? t("agents.waitingOutput", "Waiting for output...") : t("agents.connectingStream", "Connecting to log stream...")}
                </div>
              </>
            ) : (
              <span>{isConnected ? t("agents.waitingOutput", "Waiting for output...") : t("agents.connecting", "Connecting...")}</span>
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
        <div className="live-agent-card-footer-meta">
          <span className="text-secondary" title={t("agents.timeSinceLastHeartbeat", "Time since last heartbeat")}>
            {formatElapsed(elapsed)}
          </span>
          {nextHeartbeatLabel && (
            <span className="live-agent-card-next-heartbeat" title={nextHeartbeatLabel}>
              {nextHeartbeatLabel}
            </span>
          )}
        </div>
        <div className="live-agent-card-footer-actions">
          {agent.taskId && onOpenTaskLogs && (
            <button
              type="button"
              className="live-agent-card-logs-btn"
              onClick={handleViewLogs}
              title={t("agents.viewLiveLogs", "View live run logs")}
              aria-label={t("agents.viewLogsFor", "View live logs for {{taskId}}", { taskId: agent.taskId })}
            >
              <FileText size={12} />
              <span>{t("agents.liveLogs", "Live logs")}</span>
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
  className?: string;
}

export function ActiveAgentsPanel({ agents, projectId, onAgentSelect, onOpenTaskLogs, className = "" }: ActiveAgentsPanelProps) {
  const { t } = useTranslation("app");
  // Dedupe by id defensively. The store should return unique agents but a race
  // between the initial fetch and an SSE refresh can briefly surface the same
  // agent twice — without this guard React floods the console with duplicate
  // key warnings (which previously snowballed into OOM).
  const uniqueAgents = Array.from(new Map(agents.map((a) => [a.id, a])).values());

  if (uniqueAgents.length === 0) return null;

  return (
    <div className={`active-agents-panel ${className}`.trim()}>
      <div className="active-agents-panel-header">
        <Activity size={16} />
        <span>{t("agents.activeAgents", "Active Agents ({{count}})", { count: uniqueAgents.length })}</span>
      </div>
      <div className="active-agents-grid">
        {uniqueAgents.map(agent => (
          <LiveAgentCard key={agent.id} agent={agent} projectId={projectId} onSelect={onAgentSelect} onOpenTaskLogs={onOpenTaskLogs} />
        ))}
      </div>
    </div>
  );
}
