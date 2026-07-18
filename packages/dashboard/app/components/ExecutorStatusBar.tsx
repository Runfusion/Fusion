import "./ExecutorStatusBar.css";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  HIGH_FANOUT_BLOCKER_TODO_THRESHOLD,
  STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS,
  type Task,
} from "@fusion/core";
import { AlertTriangle, Clock, Folder, MessageSquare, Pause, Play, Square, Zap } from "lucide-react";
import { computeBlockerFanoutMap } from "../hooks/useBlockerFanout";
import { useExecutorStats } from "../hooks/useExecutorStats";
import { isLikelyTabSuspensionError } from "../hooks/visibilitySuspension";
import { LoadingSpinner } from "./LoadingSpinner";
import type { ExecutorState } from "../api";
import { EngineControlMenu, type EngineControlMenuHandle } from "./EngineControlMenu";
import { TerminalLauncher } from "./TerminalLauncher";
import { useViewportMode } from "../hooks/useViewportMode";

type FooterStatId = "queued" | "running" | "stuck" | "blocked" | "review" | "fanout";

interface OpenStatTooltip {
  id: FooterStatId;
  label: string;
  rect: DOMRect;
}

interface MobileStatSegmentProps {
  className?: string;
  id: FooterStatId;
  isMobile: boolean;
  isOpen: boolean;
  label: string;
  onToggle: (id: FooterStatId, label: string, rect: DOMRect) => void;
  children: ReactNode;
}

function MobileStatSegment({ className = "", id, isMobile, isOpen, label, onToggle, children }: MobileStatSegmentProps) {
  const segmentClassName = `executor-status-bar__segment executor-status-bar__segment--stat ${className}`.trim();
  if (!isMobile) return <div className={segmentClassName}>{children}</div>;

  const tooltipId = `executor-status-bar-tooltip-${id}`;
  return (
    <button
      type="button"
      className={segmentClassName}
      onClick={(event) => onToggle(id, label, event.currentTarget.getBoundingClientRect())}
      aria-label={label}
      aria-expanded={isOpen}
      aria-describedby={isOpen ? tooltipId : undefined}
      data-testid={`executor-stat-${id}`}
    >
      {children}
    </button>
  );
}

interface ExecutorStatusBarProps {
  /** Task list (shared with the board to keep counts in sync) */
  tasks: Task[];
  /** Project ID for fetching project-specific stats */
  projectId?: string;
  /** Project-level stuck task timeout in milliseconds (undefined = disabled) */
  taskStuckTimeoutMs?: number;
  /** Age threshold in milliseconds before high fan-out blockers escalate in dashboard surfaces. */
  staleHighFanoutBlockerAgeThresholdMs?: number;
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
  /** Opens or closes the terminal surface from the desktop/tablet footer launcher. */
  onToggleTerminal?: () => void;
  /** Opens the scripts management modal from the footer launcher dropdown. */
  onOpenScripts?: () => void;
  /** Runs a configured script in the terminal from the footer launcher dropdown. */
  onRunScript?: (name: string, command: string) => void;
  /** Quick Chat launcher placement from Settings. */
  quickChatButtonMode?: "floating" | "footer" | "off";
  /** Opens the full Chat modal from the footer launcher. */
  onOpenQuickChat?: () => void;
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
 * Get display configuration for an executor state.
 *
 * FNXC:EngineControls 2026-06-22-00:00:
 * A stopped engine must use the same stop-rectangle affordance as the engine-control menu and error-red status text so operators do not confuse it with idle capacity.
 */
function getStateDisplay(state: ExecutorState, t: TFunction<"app">): { label: string; color: string; icon: typeof Play } {
  switch (state) {
    case "running":
      return { label: t("executor.stateRunning", "Running"), color: "var(--color-success)", icon: Play };
    case "paused":
      return { label: t("executor.statePaused", "Paused"), color: "var(--triage)", icon: Pause };
    case "stopped":
      return { label: t("executor.stateStopped", "Stopped"), color: "var(--color-error)", icon: Square };
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
 * - Executor state badge (idle/running/paused/stopped)
 * - Last activity timestamp
 */
export function ExecutorStatusBar({ tasks, projectId, taskStuckTimeoutMs, staleHighFanoutBlockerAgeThresholdMs, lastFetchTimeMs, currentProjectPath, onOpenProjectDirectory, keyboardOpen, hideWhenKeyboardOpen, onToggleTerminal, onOpenScripts, onRunScript, quickChatButtonMode = "off", onOpenQuickChat }: ExecutorStatusBarProps) {
  const { t } = useTranslation("app");
  const viewportMode = useViewportMode();
  const isMobile = viewportMode === "mobile";
  const showTerminalLauncher = !isMobile && Boolean(onToggleTerminal);
  /*
   * FNXC:ChatLauncher 2026-06-22-15:18:
   * Settings can route Quick Chat to a footer launcher beside Terminal, keep the draggable floating FAB, or hide the launcher entirely. Footer launch stays desktop/tablet-only like Terminal while mobile opens from the floating path as a full-screen modal.
   */
  const showQuickChatFooterLauncher = !isMobile && quickChatButtonMode === "footer" && Boolean(onOpenQuickChat);
  const { stats, loading, error } = useExecutorStats(tasks, projectId, taskStuckTimeoutMs, lastFetchTimeMs);
  const [isProjectPathVisible, setIsProjectPathVisible] = useState(false);
  const [openStatTooltip, setOpenStatTooltip] = useState<OpenStatTooltip | null>(null);
  const engineControlMenuRef = useRef<EngineControlMenuHandle>(null);
  const hasRenderedPopulatedStatsRef = useRef(false);

  useEffect(() => {
    if (!loading && !error) {
      hasRenderedPopulatedStatsRef.current = true;
    }
  }, [error, loading]);

  /*
   * FNXC:MobileFooter 2026-07-16-00:00:
   * Mobile hides footer stat labels, so tapping a stat must reveal its name. The
   * executor-status-bar--mobile class and this interaction share isMobile so
   * short-landscape phones cannot expose both labels and tap controls. The
   * popover is portaled below to escape the footer's overflow clipping.
   */
  useEffect(() => {
    if (!isMobile || !openStatTooltip) return;

    const dismissTooltip = () => setOpenStatTooltip(null);
    const dismissOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".executor-status-bar__segment--stat")) return;
      dismissTooltip();
    };
    const dismissOnFocus = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest(".executor-status-bar__segment--stat")) return;
      dismissTooltip();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissTooltip();
    };

    document.addEventListener("pointerdown", dismissOnPointerDown);
    document.addEventListener("focusin", dismissOnFocus);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("scroll", dismissTooltip, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOnPointerDown);
      document.removeEventListener("focusin", dismissOnFocus);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("scroll", dismissTooltip, true);
    };
  }, [isMobile, openStatTooltip]);

  useEffect(() => {
    if (!isMobile) setOpenStatTooltip(null);
  }, [isMobile]);

  const toggleStatTooltip = (id: FooterStatId, label: string, rect: DOMRect) => {
    setOpenStatTooltip((current) => current?.id === id ? null : { id, label, rect });
  };

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

  /*
   * FNXC:ExecutorStatusBar 2026-06-27-00:00:
   * The loading subtree is initial-load-only. Once the populated footer has mounted, a heartbeat poll must keep this branch suppressed so EngineControlMenu stays mounted and an open concurrency popover survives routine stats refreshes (FN-7163).
   */
  if (loading && stats.runningTaskCount === 0 && !hasRenderedPopulatedStatsRef.current) {
    return (
      <div className="executor-status-bar executor-status-bar--loading" role="status" aria-label={t("executor.status", "Executor status")}>
        <LoadingSpinner className="executor-status-bar__loading-text" label={t("executor.loading", "Loading...")} />
      </div>
    );
  }

  return (
    <div
      className={`executor-status-bar${isMobile ? " executor-status-bar--mobile" : ""}${stats.executorState === "running" ? " executor-status-bar--running" : ""}${keyboardOpen ? " executor-status-bar--keyboard-open" : ""}`}
      role="status"
      aria-label={t("executor.status", "Executor status")}
    >
      {/*
       * FNXC:ExecutorStatusBar 2026-07-16-20:55:
       * FN-8229 removes the redundant AI-session footer segment. The banner and
       * Planning navigation now own session visibility, leaving this footer for
       * executor statistics and launch controls only.
       */}

      {/* Queued tasks */}
      <MobileStatSegment
        id="queued"
        isMobile={isMobile}
        isOpen={openStatTooltip?.id === "queued"}
        label={t("executor.queued", "Queued")}
        onToggle={toggleStatTooltip}
      >
        <span className="executor-status-bar__indicator executor-status-bar__indicator--queued" aria-hidden="true" />
        <span className="executor-status-bar__label">{t("executor.queued", "Queued")}</span>
        <span className="executor-status-bar__count">{stats.queuedTaskCount}</span>
      </MobileStatSegment>

      {/* Separator */}
      <span className="executor-status-bar__divider" aria-hidden="true" />

      {/* Running tasks */}
      <MobileStatSegment
        id="running"
        isMobile={isMobile}
        isOpen={openStatTooltip?.id === "running"}
        label={t("executor.running", "Running")}
        onToggle={toggleStatTooltip}
      >
        <span
          className={`executor-status-bar__indicator executor-status-bar__indicator--running ${stats.runningTaskCount > 0 ? "executor-status-bar__indicator--active" : ""}`}
          aria-hidden="true"
        />
        <span className="executor-status-bar__label">{t("executor.running", "Running")}</span>
        <span className="executor-status-bar__count">{stats.runningTaskCount}</span>
        <span className="executor-status-bar__separator" aria-hidden="true">/</span>
        <span className="executor-status-bar__max">{stats.maxConcurrent}</span>
      </MobileStatSegment>

      {/* Separator */}
      <span className="executor-status-bar__divider" aria-hidden="true" />

      {/* Stuck tasks */}
      {stats.stuckTaskCount > 0 && (
        <>
          <MobileStatSegment
            className="executor-status-bar__segment--stuck"
            id="stuck"
            isMobile={isMobile}
            isOpen={openStatTooltip?.id === "stuck"}
            label={t("executor.stuck", "Stuck")}
            onToggle={toggleStatTooltip}
          >
            <span className="executor-status-bar__indicator executor-status-bar__indicator--stuck executor-status-bar__indicator--active" aria-hidden="true" />
            <span className="executor-status-bar__label">{t("executor.stuck", "Stuck")}</span>
            <span className="executor-status-bar__count executor-status-bar__count--error">{stats.stuckTaskCount}</span>
          </MobileStatSegment>
          <span className="executor-status-bar__divider" aria-hidden="true" />
        </>
      )}

      {/* Blocked tasks */}
      <MobileStatSegment
        id="blocked"
        isMobile={isMobile}
        isOpen={openStatTooltip?.id === "blocked"}
        label={t("executor.blocked", "Blocked")}
        onToggle={toggleStatTooltip}
      >
        <span
          className={`executor-status-bar__indicator executor-status-bar__indicator--blocked ${stats.blockedTaskCount > 0 ? "executor-status-bar__indicator--active" : ""}`}
          aria-hidden="true"
        />
        <span className="executor-status-bar__label">{t("executor.blocked", "Blocked")}</span>
        <span className={`executor-status-bar__count ${stats.blockedTaskCount > 0 ? "executor-status-bar__count--warning" : ""}`}>
          {stats.blockedTaskCount}
        </span>
      </MobileStatSegment>

      {/* Separator */}
      <span className="executor-status-bar__divider" aria-hidden="true" />

      {/* In review count */}
      <MobileStatSegment
        id="review"
        isMobile={isMobile}
        isOpen={openStatTooltip?.id === "review"}
        label={t("executor.inReview", "In Review")}
        onToggle={toggleStatTooltip}
      >
        <span className="executor-status-bar__indicator executor-status-bar__indicator--review" aria-hidden="true" />
        <span className="executor-status-bar__label">{t("executor.inReview", "In Review")}</span>
        <span className="executor-status-bar__count">{stats.inReviewCount}</span>
      </MobileStatSegment>

      {highestOverlapBlocker && (
        <>
          <span className="executor-status-bar__divider" aria-hidden="true" />
          <MobileStatSegment
            className="executor-status-bar__segment--fanout"
            id="fanout"
            isMobile={isMobile}
            isOpen={openStatTooltip?.id === "fanout"}
            label={t("executor.overlapQueue", "Overlap queue")}
            onToggle={toggleStatTooltip}
          >
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
          </MobileStatSegment>
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

      {openStatTooltip && typeof document !== "undefined" && createPortal(
        <div
          id={`executor-status-bar-tooltip-${openStatTooltip.id}`}
          className="executor-status-bar__stat-tooltip"
          role="tooltip"
          style={{ left: openStatTooltip.rect.left + openStatTooltip.rect.width / 2, top: openStatTooltip.rect.top }}
        >
          {openStatTooltip.label}
        </div>,
        document.body,
      )}

      {/* Spacer */}
      <div className="executor-status-bar__spacer" />

      {showQuickChatFooterLauncher && (
        <>
          <div className="executor-status-bar__segment executor-status-bar__segment--quick-chat-launcher" data-testid="executor-quick-chat-launcher-segment">
            <button
              type="button"
              className="executor-status-bar__footer-launcher"
              onClick={onOpenQuickChat}
              aria-label={t("chat.openQuickChat", "Open Quick Chat")}
              data-testid="executor-quick-chat-launcher"
            >
              <MessageSquare size={12} aria-hidden="true" />
              <span>{t("chat.quickChat", "Quick Chat")}</span>
            </button>
          </div>
          <span className="executor-status-bar__divider" aria-hidden="true" />
        </>
      )}

      {showTerminalLauncher && (
        <>
          <div className="executor-status-bar__segment executor-status-bar__segment--terminal-launcher" data-testid="executor-terminal-launcher-segment">
            <TerminalLauncher
              projectId={projectId}
              onToggleTerminal={onToggleTerminal}
              onOpenScripts={onOpenScripts}
              onRunScript={onRunScript}
              variant="footer"
            />
          </div>
          <span className="executor-status-bar__divider" aria-hidden="true" />
        </>
      )}

      {/* Last activity */}
      <div className="executor-status-bar__segment executor-status-bar__segment--time">
        <Clock size={12} className="executor-status-bar__icon" aria-hidden="true" />
        <span className="executor-status-bar__time">{relativeTime}</span>
      </div>

      {/* Separator */}
      <span className="executor-status-bar__divider" aria-hidden="true" />

      {/* Executor state badge and engine controls */}
      <div className="executor-status-bar__segment executor-status-bar__segment--engine-controls">
        <button
          type="button"
          className="executor-status-bar__state-trigger"
          onClick={() => engineControlMenuRef.current?.open()}
          aria-label={t("executor.openEngineControlsForState", "Open engine controls for {{state}} state", { state: stateDisplay.label })}
          data-testid="executor-state-engine-control-trigger"
        >
          <StateIcon size={12} style={{ color: stateDisplay.color }} aria-hidden="true" />
          <span className="executor-status-bar__state" style={{ color: stateDisplay.color }}>
            {stateDisplay.label}
          </span>
        </button>
        <EngineControlMenu ref={engineControlMenuRef} projectId={projectId} />
      </div>
    </div>
  );
}
