import "./ExecutorStatusBar.css";
import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  HIGH_FANOUT_BLOCKER_TODO_THRESHOLD,
  STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS,
  type Task,
} from "@fusion/core";
import { AlertTriangle, Clock, Folder, Pause, Play, Zap } from "lucide-react";
import { computeBlockerFanoutMap } from "../hooks/useBlockerFanout";
import { useExecutorStats } from "../hooks/useExecutorStats";
import { isLikelyTabSuspensionError } from "../hooks/visibilitySuspension";
import { LoadingSpinner } from "./LoadingSpinner";
import type { ExecutorState, AiSessionSummary } from "../api";
import { BackgroundTasksIndicator } from "./BackgroundTasksIndicator";

interface ExecutorStatusBarProps {
  /** Task list (shared with the board to keep counts in sync) */
  tasks: Task[];
  /** Project ID for fetching project-specific stats */
  projectId?: string;
  /** Project-level stuck task timeout in milliseconds (undefined = disabled) */
  taskStuckTimeoutMs?: number;
  /** Age threshold in milliseconds before high fan-out blockers escalate in dashboard surfaces. */
  staleHighFanoutBlockerAgeThresholdMs?: number;
  /** Background AI sessions */
  backgroundSessions?: AiSessionSummary[];
  backgroundGenerating?: number;
  backgroundNeedsInput?: number;
  onOpenBackgroundSession?: (session: AiSessionSummary) => void;
  onDismissBackgroundSession?: (id: string) => void;
  /** Timestamp (ms) when task data was last confirmed fresh from the server. Used for freshness-aware stuck detection. */
  lastFetchTimeMs?: number;
  /** Absolute path for the currently selected project directory. */
  currentProjectPath?: string;
  /** Opens the workspace-aware file browser to the project workspace. */
  onOpenProjectDirectory?: () => void;
  /** When true on mobile, force bottom pinning so ICB compensation does not
   *  push the bar above the keyboard; keyboard may cover it instead. */
  keyboardOpen?: boolean;
  /** iOS-only hide guard to prevent footer drifting over content while
   *  visualViewport settles during keyboard transitions. */
  hideWhenKeyboardOpen?: boolean;
}

/**
 * Format a relative time string (e.g., "2m ago", "1h ago")
 */
function formatRelativeTime(timestamp: string | undefined, t: TFunction<"app">): string {
  if (!timestamp) return t("executor.noActivity", "no activity");

  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return t("executor.daysAgo", "{{count}}d ago", { count: days });
  if (hours > 0) return t("executor.hoursAgo", "{{count}}h ago", { count: hours });
  if (minutes > 0) return t("executor.minutesAgo", "{{count}}m ago", { count: minutes });
  if (seconds > 10) return t("executor.secondsAgo", "{{count}}s ago", { count: seconds });
  return t("executor.justNow", "just now");
}

/**
 * Get display configuration for an executor state
 */
function getStateDisplay(state: ExecutorState, t: TFunction<"app">): { label: string; color: string; icon: typeof Play } {
  switch (state) {
    case "running":
      return { label: t("executor.stateRunning", "Running"), color: "var(--color-success)", icon: Play };
    case "paused":
      return { label: t("executor.statePaused", "Paused"), color: "var(--triage)", icon: Pause };
    case "idle":
    default:
      return { label: t("executor.stateIdle", "Idle"), color: "var(--text-muted)", icon: Zap };
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
export function ExecutorStatusBar({ tasks, projectId, taskStuckTimeoutMs, staleHighFanoutBlockerAgeThresholdMs, backgroundSessions, backgroundGenerating, backgroundNeedsInput, onOpenBackgroundSession, onDismissBackgroundSession, lastFetchTimeMs, currentProjectPath, onOpenProjectDirectory, keyboardOpen, hideWhenKeyboardOpen }: ExecutorStatusBarProps) {
  const { t } = useTranslation("app");
  const { stats, loading, error } = useExecutorStats(tasks, projectId, taskStuckTimeoutMs, lastFetchTimeMs);
  const [isProjectPathVisible, setIsProjectPathVisible] = useState(false);

  const stateDisplay = useMemo(() => getStateDisplay(stats.executorState, t), [stats.executorState, t]);

  const relativeTime = useMemo(() => formatRelativeTime(stats.lastActivityAt, t), [stats.lastActivityAt, t]);

  const highestOverlapBlocker = useMemo(() => {
    const fanoutMap = computeBlockerFanoutMap(tasks, {
      staleHighFanoutAgeThresholdMs:
        staleHighFanoutBlockerAgeThresholdMs ?? STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS,
    });
    const candidates = Array.from(fanoutMap.entries())
      .map(([blockerId, entry]) => ({ blockerId, entry }))
      .filter(({ entry }) => entry.isHighFanout)
      .sort((a, b) => {
        if (b.entry.overlapBlockedTodoCount !== a.entry.overlapBlockedTodoCount) return b.entry.overlapBlockedTodoCount - a.entry.overlapBlockedTodoCount;
        const aAge = a.entry.escalation?.blockingAgeMs ?? 0;
        const bAge = b.entry.escalation?.blockingAgeMs ?? 0;
        if (bAge !== aAge) return bAge - aAge;
        return a.blockerId.localeCompare(b.blockerId, "en", { numeric: true, sensitivity: "base" });
      });

    return candidates[0] ?? null;
  }, [tasks, staleHighFanoutBlockerAgeThresholdMs]);

  const StateIcon = stateDisplay.icon;

  // Keyboard-open guard runs after all hooks: toggling it must not change the
  // hook count between renders (Rules of Hooks).
  if (hideWhenKeyboardOpen) return null;

  if (error) {
    if (isLikelyTabSuspensionError(error)) {
      return (
        <div className="executor-status-bar executor-status-bar--connecting" role="status" aria-label={t("executor.status", "Executor status")}>
          <span className="executor-status-bar__connecting">
            <span className="executor-status-bar__indicator executor-status-bar__indicator--connecting executor-status-bar__indicator--active" aria-hidden="true" />
            {t("executor.connecting", "Connecting…")}
          </span>
        </div>
      );
    }

    return (
      <div className="executor-status-bar executor-status-bar--error" role="status" aria-label={t("executor.status", "Executor status")}>
        <span className="executor-status-bar__error">
          <AlertTriangle size={14} />
          {error}
        </span>
      </div>
    );
  }

  if (loading && stats.runningTaskCount === 0) {
    return (
      <div className="executor-status-bar executor-status-bar--loading" role="status" aria-label={t("executor.status", "Executor status")}>
        <LoadingSpinner className="executor-status-bar__loading-text" label={t("executor.loading", "Loading...")} />
      </div>
    );
  }

  return (
    <div
      className={`executor-status-bar ${stats.executorState === "running" ? "executor-status-bar--running" : ""}${keyboardOpen ? " executor-status-bar--keyboard-open" : ""}`}
      role="status"
      aria-label={t("executor.status", "Executor status")}
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

      {/* Queued tasks */}
      <div className="executor-status-bar__segment">
        <span className="executor-status-bar__indicator executor-status-bar__indicator--queued" aria-hidden="true" />
        <span className="executor-status-bar__label">{t("executor.queued", "Queued")}</span>
        <span className="executor-status-bar__count">{stats.queuedTaskCount}</span>
      </div>

      {/* Separator */}
      <span className="executor-status-bar__divider" aria-hidden="true" />

      {/* Running tasks */}
      <div className="executor-status-bar__segment">
        <span
          className={`executor-status-bar__indicator executor-status-bar__indicator--running ${stats.runningTaskCount > 0 ? "executor-status-bar__indicator--active" : ""}`}
          aria-hidden="true"
        />
        <span className="executor-status-bar__label">{t("executor.running", "Running")}</span>
        <span className="executor-status-bar__count">{stats.runningTaskCount}</span>
        <span className="executor-status-bar__separator" aria-hidden="true">/</span>
        <span className="executor-status-bar__max">{stats.maxConcurrent}</span>
      </div>

      {/* Separator */}
      <span className="executor-status-bar__divider" aria-hidden="true" />

      {/* Stuck tasks */}
      {stats.stuckTaskCount > 0 && (
        <>
          <div className="executor-status-bar__segment executor-status-bar__segment--stuck">
            <span className="executor-status-bar__indicator executor-status-bar__indicator--stuck executor-status-bar__indicator--active" aria-hidden="true" />
            <span className="executor-status-bar__label">{t("executor.stuck", "Stuck")}</span>
            <span className="executor-status-bar__count executor-status-bar__count--error">{stats.stuckTaskCount}</span>
          </div>
          <span className="executor-status-bar__divider" aria-hidden="true" />
        </>
      )}

      {/* Blocked tasks */}
      <div className="executor-status-bar__segment">
        <span
          className={`executor-status-bar__indicator executor-status-bar__indicator--blocked ${stats.blockedTaskCount > 0 ? "executor-status-bar__indicator--active" : ""}`}
          aria-hidden="true"
        />
        <span className="executor-status-bar__label">{t("executor.blocked", "Blocked")}</span>
        <span className={`executor-status-bar__count ${stats.blockedTaskCount > 0 ? "executor-status-bar__count--warning" : ""}`}>
          {stats.blockedTaskCount}
        </span>
      </div>

      {/* Separator */}
      <span className="executor-status-bar__divider" aria-hidden="true" />

      {/* In review count */}
      <div className="executor-status-bar__segment">
        <span className="executor-status-bar__indicator executor-status-bar__indicator--review" aria-hidden="true" />
        <span className="executor-status-bar__label">{t("executor.inReview", "In Review")}</span>
        <span className="executor-status-bar__count">{stats.inReviewCount}</span>
      </div>

      {highestOverlapBlocker && (
        <>
          <span className="executor-status-bar__divider" aria-hidden="true" />
          <div className="executor-status-bar__segment executor-status-bar__segment--fanout">
            <span className="executor-status-bar__indicator executor-status-bar__indicator--fanout executor-status-bar__indicator--active" aria-hidden="true" />
            <span className="executor-status-bar__label">{t("executor.overlapQueue", "Overlap queue")}</span>
            <span
              className="executor-status-bar__fanout-summary"
              title={t("executor.overlapBottleneck", "{{status}} overlap bottleneck {{blockerId}}: {{count}} {{todoStatus}} blocked via blockedBy (threshold {{threshold}})", {
                status: highestOverlapBlocker.entry.escalation ? t("executor.escalated", "Escalated") : t("executor.temporary", "Temporary"),
                blockerId: highestOverlapBlocker.blockerId,
                count: highestOverlapBlocker.entry.overlapBlockedTodoCount,
                todoStatus: t("executor.todoStatus", "todo"),
                threshold: HIGH_FANOUT_BLOCKER_TODO_THRESHOLD,
              })}
            >
              {t("executor.overlapSummary", "{{blockerId}} · {{count}} todo", { blockerId: highestOverlapBlocker.blockerId, count: highestOverlapBlocker.entry.overlapBlockedTodoCount })}{highestOverlapBlocker.entry.escalation ? t("executor.escalatedSuffix", " (escalated)") : ""}
            </span>
          </div>
        </>
      )}

      {currentProjectPath && onOpenProjectDirectory && (
        <>
          <span className="executor-status-bar__divider" aria-hidden="true" />
          <div className="executor-status-bar__segment executor-status-bar__segment--project-directory">
            <button
              className={`executor-status-bar__folder-toggle${isProjectPathVisible ? " executor-status-bar__folder-toggle--active" : ""}`}
              onClick={() => setIsProjectPathVisible((prev) => !prev)}
              aria-label={isProjectPathVisible ? t("executor.hideProjectDir", "Hide project directory") : t("executor.showProjectDir", "Show project directory")}
              aria-expanded={isProjectPathVisible}
              data-testid="executor-project-path-toggle"
              title={isProjectPathVisible ? t("executor.hideProjectDir", "Hide project directory") : t("executor.showProjectDir", "Show project directory")}
            >
              <Folder size={12} aria-hidden="true" />
            </button>
            {isProjectPathVisible && (
              <button
                className="executor-status-bar__project-path"
                onClick={onOpenProjectDirectory}
                title={currentProjectPath}
                data-testid="executor-project-path-link"
              >
                {currentProjectPath}
              </button>
            )}
          </div>
        </>
      )}

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
