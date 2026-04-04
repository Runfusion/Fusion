import { useMemo } from "react";
import type { Task } from "@fusion/core";
import { Activity, AlertTriangle, Clock, Pause, Play, Zap } from "lucide-react";
import { useExecutorStats } from "../hooks/useExecutorStats";
import type { ExecutorState, AiSessionSummary } from "../api";
import { BackgroundTasksIndicator } from "./BackgroundTasksIndicator";

interface ExecutorStatusBarProps {
  /** Task list (shared with the board to keep counts in sync) */
  tasks: Task[];
  /** Project ID for fetching project-specific stats */
  projectId?: string;
  /** Project-level stuck task timeout in milliseconds (undefined = disabled) */
  taskStuckTimeoutMs?: number;
  /** Background AI sessions */
  backgroundSessions?: AiSessionSummary[];
  backgroundGenerating?: number;
  backgroundNeedsInput?: number;
  onOpenBackgroundSession?: (session: AiSessionSummary) => void;
  onDismissBackgroundSession?: (id: string) => void;
}

/**
 * Format a relative time string (e.g., "2m ago", "1h ago")
 */
function formatRelativeTime(timestamp: string | undefined): string {
  if (!timestamp) return "no activity";

  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  if (seconds > 10) return `${seconds}s ago`;
  return "just now";
}

/**
 * Get display configuration for an executor state
 */
function getStateDisplay(state: ExecutorState): { label: string; color: string; icon: typeof Play } {
  switch (state) {
    case "running":
      return { label: "Running", color: "var(--color-success)", icon: Play };
    case "paused":
      return { label: "Paused", color: "var(--triage)", icon: Pause };
    case "idle":
    default:
      return { label: "Idle", color: "var(--text-muted)", icon: Zap };
  }
}

/**
 * Footer status bar component that displays real-time executor statistics.
 * 
 * Shows:
 * - Running tasks count with pulsing animation when > 0
 * - Blocked tasks count with warning color when > 0
 * - Queued tasks count
 * - Executor state badge (idle/running/paused)
 * - Last activity timestamp
 */
export function ExecutorStatusBar({ tasks, projectId, taskStuckTimeoutMs, backgroundSessions, backgroundGenerating, backgroundNeedsInput, onOpenBackgroundSession, onDismissBackgroundSession }: ExecutorStatusBarProps) {
  const { stats, loading, error } = useExecutorStats(tasks, projectId, taskStuckTimeoutMs);

  const stateDisplay = useMemo(() => getStateDisplay(stats.executorState), [stats.executorState]);

  const relativeTime = useMemo(() => formatRelativeTime(stats.lastActivityAt), [stats.lastActivityAt]);

  const StateIcon = stateDisplay.icon;

  if (error) {
    return (
      <div className="executor-status-bar executor-status-bar--error" role="status" aria-label="Executor status">
        <span className="executor-status-bar__error">
          <AlertTriangle size={14} />
          {error}
        </span>
      </div>
    );
  }

  if (loading && stats.runningTaskCount === 0) {
    return (
      <div className="executor-status-bar executor-status-bar--loading" role="status" aria-label="Executor status">
        <span className="executor-status-bar__loading-text">Loading...</span>
      </div>
    );
  }

  return (
    <div
      className={`executor-status-bar ${stats.executorState === "running" ? "executor-status-bar--running" : ""}`}
      role="status"
      aria-label="Executor status"
    >
      {/* Background AI tasks indicator */}
      {backgroundSessions && backgroundSessions.length > 0 && onOpenBackgroundSession && onDismissBackgroundSession && (
        <>
          <BackgroundTasksIndicator
            sessions={backgroundSessions}
            generating={backgroundGenerating ?? 0}
            needsInput={backgroundNeedsInput ?? 0}
            onOpenSession={onOpenBackgroundSession}
            onDismissSession={onDismissBackgroundSession}
          />
          <span className="executor-status-bar__divider" aria-hidden="true" />
        </>
      )}

      {/* Running tasks */}
      <div className="executor-status-bar__segment">
        <span
          className={`executor-status-bar__indicator executor-status-bar__indicator--running ${stats.runningTaskCount > 0 ? "executor-status-bar__indicator--active" : ""}`}
          aria-hidden="true"
        />
        <span className="executor-status-bar__label">Running</span>
        <span className="executor-status-bar__count">{stats.runningTaskCount}</span>
        <span className="executor-status-bar__separator" aria-hidden="true">/</span>
        <span className="executor-status-bar__max">{stats.maxConcurrent}</span>
      </div>

      {/* Separator */}
      <span className="executor-status-bar__divider" aria-hidden="true" />

      {/* Blocked tasks */}
      <div className="executor-status-bar__segment">
        <span
          className={`executor-status-bar__indicator executor-status-bar__indicator--blocked ${stats.blockedTaskCount > 0 ? "executor-status-bar__indicator--active" : ""}`}
          aria-hidden="true"
        />
        <span className="executor-status-bar__label">Blocked</span>
        <span className={`executor-status-bar__count ${stats.blockedTaskCount > 0 ? "executor-status-bar__count--warning" : ""}`}>
          {stats.blockedTaskCount}
        </span>
      </div>

      {/* Separator */}
      <span className="executor-status-bar__divider" aria-hidden="true" />

      {/* Stuck tasks */}
      {stats.stuckTaskCount > 0 && (
        <>
          <div className="executor-status-bar__segment executor-status-bar__segment--stuck">
            <span className="executor-status-bar__indicator executor-status-bar__indicator--stuck executor-status-bar__indicator--active" aria-hidden="true" />
            <span className="executor-status-bar__label">Stuck</span>
            <span className="executor-status-bar__count executor-status-bar__count--error">{stats.stuckTaskCount}</span>
          </div>
          <span className="executor-status-bar__divider" aria-hidden="true" />
        </>
      )}

      {/* Queued tasks */}
      <div className="executor-status-bar__segment">
        <span className="executor-status-bar__indicator executor-status-bar__indicator--queued" aria-hidden="true" />
        <span className="executor-status-bar__label">Queued</span>
        <span className="executor-status-bar__count">{stats.queuedTaskCount}</span>
      </div>

      {/* Separator */}
      <span className="executor-status-bar__divider" aria-hidden="true" />

      {/* In review count */}
      <div className="executor-status-bar__segment">
        <span className="executor-status-bar__indicator executor-status-bar__indicator--review" aria-hidden="true" />
        <span className="executor-status-bar__label">In Review</span>
        <span className="executor-status-bar__count">{stats.inReviewCount}</span>
      </div>

      {/* Spacer */}
      <div className="executor-status-bar__spacer" />

      {/* Last activity */}
      <div className="executor-status-bar__segment executor-status-bar__segment--time">
        <Clock size={12} className="executor-status-bar__icon" aria-hidden="true" />
        <span className="executor-status-bar__time">{relativeTime}</span>
      </div>

      {/* Separator */}
      <span className="executor-status-bar__divider" aria-hidden="true" />

      {/* Executor state badge */}
      <div className="executor-status-bar__segment">
        <StateIcon size={12} style={{ color: stateDisplay.color }} aria-hidden="true" />
        <span className="executor-status-bar__state" style={{ color: stateDisplay.color }}>
          {stateDisplay.label}
        </span>
      </div>
    </div>
  );
}
