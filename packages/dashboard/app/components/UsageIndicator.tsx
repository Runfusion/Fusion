import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { CSSProperties, DragEvent } from "react";
import { X, RefreshCw, Activity, TrendingUp, CheckCircle, AlertTriangle, Eye, GripVertical, ChevronUp, ChevronDown } from "lucide-react";
import type { ProviderUsage, UsageWindow } from "../api";
import { useUsageData } from "../hooks/useUsageData";
import { ProviderIcon } from "./ProviderIcon";
import { inferProviderIconKey } from "../utils/providerIconKey";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";
import "./UsageIndicator.css";

interface UsageIndicatorProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
  anchorRect?: DOMRect | null;
  /**
   * FNXC:UsageIndicator 2026-06-22-00:00:
   * Right-dock redesign renders dock items inline instead of as popup modals.
   * "embedded" presentation makes the usage view render as a plain flow container
   * inside the right-dock (no fixed overlay, no popover anchoring, no close button,
   * filling its parent at width/height 100%). Modal behavior is unchanged when
   * presentation is "modal"/undefined.
   */
  presentation?: "modal" | "embedded";
}

/**
 * Format an ISO 8601 timestamp into a user-friendly absolute time string.
 *
 * Formatting tiers (applied consistently for all providers):
 *   - Today:          "2:30 PM"
 *   - Next 7 days:    "Tue 2:30 PM"   (weekday + time)
 *   - Beyond 7 days:  "Jan 15, 2:30 PM"
 *
 * Day difference is computed from calendar midnight boundaries rather than
 * raw millisecond division to avoid time-of-day rounding artifacts that could
 * cause inconsistent formatting (e.g., showing "Apr 6" instead of "Sun 2:30 PM"
 * for a reset that is just under 7 days away).
 *
 * Used by UsageWindowRow to display the absolute reset time next to the
 * relative "resets in X" text when the backend provides a canonical resetAt
 * timestamp.
 */
function formatResetAt(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const now = new Date();

  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return timeStr;
  }

  // Compute calendar-day distance using midnight boundaries.
  // This avoids floating-point rounding from raw millisecond division
  // that can cause off-by-one day counts depending on time-of-day.
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const calendarDaysUntil = Math.round(
    (startOfTarget.getTime() - startOfToday.getTime()) / (24 * 60 * 60 * 1000)
  );

  // Within the next 7 calendar days — show short weekday + time
  if (calendarDaysUntil >= 1 && calendarDaysUntil <= 7) {
    const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
    return `${weekday} ${timeStr}`;
  }

  // Beyond 7 days — show full date
  const dateStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${dateStr}, ${timeStr}`;
}

/**
 * Get color class for usage percentage
 * - >90%: high (red/error color)
 * - >70%: medium (yellow/triage color)
 * - <=70%: low (green/success color)
 */
function getUsageColorClass(percentUsed: number): string {
  if (percentUsed > 90) return "usage-progress-fill--high";
  if (percentUsed > 70) return "usage-progress-fill--medium";
  return "usage-progress-fill--low";
}

const HIDDEN_WINDOWS_STORAGE_KEY = "kb-usage-hidden-windows";
const MODAL_SIZE_STORAGE_KEY = "kb-usage-modal-size";
const PROVIDER_ORDER_KEY = "kb-usage-provider-order";
const DESKTOP_POPOVER_GAP = 8;
const DESKTOP_POPOVER_TOP_INSET = DESKTOP_POPOVER_GAP * 2;
/**
 * FNXC:UsageIndicator 2026-06-20-00:00:
 * The usage popover must render near the top of the board across all viewport heights and anchor positions.
 * Use a small absolute cap derived from the header inset instead of a viewport-height ratio so tall screens cannot push the surface far below the board header.
 */
const DESKTOP_POPOVER_NEAR_TOP_MAX = DESKTOP_POPOVER_TOP_INSET * 6;

interface ModalSize {
  width: number;
  height: number;
}

function getSavedModalSize(projectId: string | undefined): ModalSize | null {
  const stored = getScopedItem(MODAL_SIZE_STORAGE_KEY, projectId);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    if (
      parsed &&
      typeof parsed.width === "number" &&
      typeof parsed.height === "number" &&
      parsed.width > 0 &&
      parsed.height > 0
    ) {
      return { width: parsed.width, height: parsed.height };
    }
  } catch {
    // ignore
  }
  return null;
}

function getHiddenWindows(projectId: string | undefined): Record<string, string[]> {
  const stored = getScopedItem(HIDDEN_WINDOWS_STORAGE_KEY, projectId);
  if (!stored) {
    return {};
  }

  try {
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return Object.entries(parsed).reduce<Record<string, string[]>>((acc, [provider, labels]) => {
      if (Array.isArray(labels)) {
        const validLabels = labels.filter((label): label is string => typeof label === "string");
        if (validLabels.length > 0) {
          acc[provider] = validLabels;
        }
      }
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function setHiddenWindows(hidden: Record<string, string[]>, projectId: string | undefined): void {
  setScopedItem(HIDDEN_WINDOWS_STORAGE_KEY, JSON.stringify(hidden), projectId);
}

function getProviderOrder(projectId: string | undefined): string[] {
  const stored = getScopedItem(PROVIDER_ORDER_KEY, projectId);
  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((name): name is string => typeof name === "string");
  } catch {
    return [];
  }
}

function setProviderOrder(names: string[], projectId: string | undefined): void {
  setScopedItem(PROVIDER_ORDER_KEY, JSON.stringify(names), projectId);
}

const WINDOW_IDENTITY_DELIMITER = "::";

function getWindowIdentity(windowLabel: string, windowIndex: number): string {
  return `${windowIndex}${WINDOW_IDENTITY_DELIMITER}${windowLabel}`;
}

function matchesHiddenWindowEntry(
  persistedEntry: string,
  windowLabel: string,
  windowIndex: number
): boolean {
  return (
    persistedEntry === getWindowIdentity(windowLabel, windowIndex) ||
    persistedEntry === windowLabel
  );
}

function isWindowHidden(
  providerName: string,
  windowLabel: string,
  windowIndex: number,
  hidden: Record<string, string[]>
): boolean {
  return (hidden[providerName] ?? []).some((persistedEntry) =>
    matchesHiddenWindowEntry(persistedEntry, windowLabel, windowIndex)
  );
}

function getRenderedHiddenWindowCount(
  providerName: string,
  windows: UsageWindow[] | undefined,
  hidden: Record<string, string[]>
): number {
  return (windows ?? []).reduce((count, window, windowIndex) => {
    return count + (isWindowHidden(providerName, window.label, windowIndex, hidden) ? 1 : 0);
  }, 0);
}

function getRestorableHiddenWindowCount(
  providerName: string,
  windows: UsageWindow[] | undefined,
  hidden: Record<string, string[]>
): number {
  const liveWindows = windows ?? [];
  const renderedHiddenCount = getRenderedHiddenWindowCount(providerName, liveWindows, hidden);
  const persistedHiddenEntries = hidden[providerName] ?? [];

  if (persistedHiddenEntries.length === 0) {
    return renderedHiddenCount;
  }

  const orphanedHiddenCount = persistedHiddenEntries.reduce((count, persistedEntry) => {
    const matchesLiveWindow = liveWindows.some((window, windowIndex) =>
      matchesHiddenWindowEntry(persistedEntry, window.label, windowIndex)
    );
    return count + (matchesLiveWindow ? 0 : 1);
  }, 0);

  return renderedHiddenCount + orphanedHiddenCount;
}

interface UsageWindowRowProps {
  window: UsageWindow;
  viewMode: 'used' | 'remaining';
  isHidden: boolean;
  onToggleHidden: () => void;
}

/**
 * Single usage window row with progress bar
 */
function UsageWindowRow({ window, viewMode, isHidden, onToggleHidden }: UsageWindowRowProps) {
  const { t } = useTranslation("app");
  const colorClass = getUsageColorClass(window.percentUsed);
  const isRemainingMode = viewMode === 'remaining';

  // Display percentage based on view mode, but color always based on actual usage
  // Round percentages for cleaner display
  const displayPercent = Math.round(isRemainingMode ? window.percentLeft : window.percentUsed);
  const headerText = isRemainingMode
    ? t("usage.percentRemaining", "{{percent}}% remaining", { percent: Math.round(window.percentLeft) })
    : t("usage.percentUsed", "{{percent}}% used", { percent: Math.round(window.percentUsed) });
  const footerText = isRemainingMode
    ? t("usage.percentUsed", "{{percent}}% used", { percent: Math.round(window.percentUsed) })
    : t("usage.percentLeft", "{{percent}}% left", { percent: Math.round(window.percentLeft) });

  // If resetText is null but resetAt exists, generate relative text from resetAt as a fallback
  let displayResetText = window.resetText;
  if (!displayResetText && window.resetAt) {
    const msLeft = new Date(window.resetAt).getTime() - Date.now();
    if (msLeft > 0) {
      const hours = Math.floor(msLeft / (60 * 60 * 1000));
      const days = Math.floor(hours / 24);
      const remHours = hours % 24;
      if (days > 0 && remHours > 0) {
        displayResetText = t("usage.resetsInDaysHours", "resets in {{days}}d {{hours}}h", { days, hours: remHours });
      } else if (days > 0) {
        displayResetText = t("usage.resetsInDays", "resets in {{days}}d", { days });
      } else if (hours > 0) {
        displayResetText = t("usage.resetsInHours", "resets in {{hours}}h", { hours });
      } else {
        const mins = Math.floor(msLeft / (60 * 1000));
        displayResetText = t("usage.resetsInMinutes", "resets in {{mins}}m", { mins });
      }
    }
  }

  // Use pace from backend if available (for weekly windows)
  const pace = window.pace;
  const shouldShowPace = pace !== undefined;

  // Marker position for pace indicator (shows elapsed time position on progress bar)
  let markerPosition = 0;
  if (shouldShowPace) {
    markerPosition = isRemainingMode ? (100 - pace.percentElapsed) : pace.percentElapsed;
  }

  // Determine pace display status
  const isAhead = pace?.status === "ahead";
  const isBehind = pace?.status === "behind";
  const isOnTrack = pace?.status === "on-track";

  return (
    <div className={`usage-window ${isHidden ? "usage-window--hidden" : ""}`}>
      <div className="usage-window-header">
        <span className="usage-window-label">{window.label}</span>
        <div className="usage-window-header-controls">
          {!isHidden && <span className="usage-window-percentage">{headerText}</span>}
          {!isHidden && (
            <button
              type="button"
              className="btn-icon usage-window-hide-btn"
              onClick={onToggleHidden}
              aria-label={t("usage.hideWindow", "Hide {{label}}", { label: window.label })}
              data-testid="usage-window-hide-btn"
            >
              <Eye size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="usage-progress-wrapper">
        <div className="usage-progress-bar">
          <div
            className={`usage-progress-fill ${colorClass}`}
            style={{ width: `${displayPercent}%` }}
            role="progressbar"
            aria-valuenow={displayPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${window.label}: ${headerText}`}
          />
        </div>
        {shouldShowPace && (
          <div
            className="usage-pace-marker"
            style={{ left: `${markerPosition}%` }}
            aria-hidden="true"
            data-testid="pace-marker"
          />
        )}
      </div>
      <div className="usage-window-footer">
        <span className="usage-window-left">{footerText}</span>
        {/* Reset group: shows relative text ("resets in 2h") and, when available,
            the absolute reset time derived from the canonical resetAt timestamp.
            The absolute time is populated by the backend for Claude session/windows
            where the reset timestamp is known. Other providers will only show
            the relative text unless they also provide resetAt. */}
        <span className="usage-window-reset-group">
          {displayResetText && (
            <span className="usage-window-reset">{displayResetText}</span>
          )}
          {/* Absolute reset timestamp: shown for all windows when resetAt is available. */}
          {window.resetAt && (
            <span className="usage-window-reset-at">
              {formatResetAt(window.resetAt)}
            </span>
          )}
        </span>
      </div>
      {shouldShowPace && (
        <div className="usage-pace-row" data-testid="pace-row">
          {isAhead && (
            <>
              <AlertTriangle size={14} className="pace-icon pace-ahead" />
              <span className="pace-text pace-ahead">{pace.message}</span>
            </>
          )}
          {isBehind && (
            <>
              <TrendingUp size={14} className="pace-icon pace-behind" />
              <span className="pace-text pace-behind">{pace.message}</span>
            </>
          )}
          {isOnTrack && (
            <>
              <CheckCircle size={14} className="pace-icon pace-ontrack" />
              <span className="pace-text pace-ontrack">{pace.message}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface ProviderCardProps {
  provider: ProviderUsage;
  viewMode: 'used' | 'remaining';
  hiddenWindows: Record<string, string[]>;
  onToggleWindow: (providerName: string, windowLabel: string, windowIndex: number) => void;
  onShowAllHidden: (providerName: string) => void;
  isDragging: boolean;
  isDragOver: boolean;
  dragOverPosition: "before" | "after" | null;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  isTouchReorderMode: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

/*
FNXC:UsageIndicator 2026-07-22-17:04:
FN-8500 makes usage cards consume the canonical provider/model inference seam rather than duplicate it. This keeps Xiaomi MiMo labels and every existing shared mapping aligned with model, task, and analytics surfaces.
*/

/**
 * Provider card showing status and usage windows
 */
function ProviderCard({
  provider,
  viewMode,
  hiddenWindows,
  onToggleWindow,
  onShowAllHidden,
  isDragging,
  isDragOver,
  dragOverPosition,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  isTouchReorderMode,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
}: ProviderCardProps) {
  const { t } = useTranslation("app");
  const providerWindows = provider.windows ?? [];
  const hiddenCount = getRestorableHiddenWindowCount(provider.name, providerWindows, hiddenWindows);
  const getStatusBadge = () => {
    switch (provider.status) {
      case "ok":
        return null;
      case "error":
        return (
          <span className="usage-status-badge usage-status-badge--error">
            {t("usage.statusError", "Error")}
          </span>
        );
      case "no-auth":
      default:
        return (
          <span className="usage-status-badge usage-status-badge--not-configured">
            {t("usage.statusNotConfigured", "Not configured")}
          </span>
        );
    }
  };

  return (
    <div
      className={`usage-provider${isDragging ? " usage-provider--dragging" : ""}${
        isDragOver && dragOverPosition === "before" ? " usage-provider--drag-over-before" : ""
      }${isDragOver && dragOverPosition === "after" ? " usage-provider--drag-over-after" : ""}`}
      data-provider={provider.name}
      data-status={provider.status}
      draggable={!isTouchReorderMode}
      onDragStart={isTouchReorderMode ? undefined : onDragStart}
      onDragOver={isTouchReorderMode ? undefined : onDragOver}
      onDragLeave={isTouchReorderMode ? undefined : onDragLeave}
      onDrop={isTouchReorderMode ? undefined : onDrop}
      onDragEnd={isTouchReorderMode ? undefined : onDragEnd}
    >
      <div className="usage-provider-header">
        <div className="usage-provider-info">
          <ProviderIcon provider={inferProviderIconKey(provider.name)} size="md" />
          <span className="usage-provider-name">{provider.name}</span>
          {hiddenCount > 0 && (
            <button
              type="button"
              className="btn btn-sm usage-show-hidden-btn"
              onClick={() => onShowAllHidden(provider.name)}
              data-testid="usage-show-hidden-btn"
            >
              {t("usage.showHidden", "Show hidden ({{count}})", { count: hiddenCount })}
            </button>
          )}
        </div>
        <div className="usage-provider-actions">
          {isTouchReorderMode && (
            <div className="usage-provider-reorder-controls" role="group" aria-label={t("usage.reorderProvider", "Reorder {{provider}}", { provider: provider.name })}>
              <button
                className="btn-icon usage-provider-reorder-btn"
                type="button"
                onClick={onMoveUp}
                disabled={!canMoveUp}
                aria-label={t("usage.moveProviderUp", "Move {{provider}} up", { provider: provider.name })}
              >
                <ChevronUp size={14} />
              </button>
              <button
                className="btn-icon usage-provider-reorder-btn"
                type="button"
                onClick={onMoveDown}
                disabled={!canMoveDown}
                aria-label={t("usage.moveProviderDown", "Move {{provider}} down", { provider: provider.name })}
              >
                <ChevronDown size={14} />
              </button>
            </div>
          )}
          {getStatusBadge()}
          <div className="usage-provider-drag-handle" aria-hidden="true">
            <GripVertical size={16} />
          </div>
        </div>
      </div>

      {provider.error && (
        <div className="usage-provider-error">
          {provider.error}
        </div>
      )}

      {provider.plan && (
        <div className="usage-provider-meta">
          <span className="usage-provider-plan">{provider.plan}</span>
        </div>
      )}

      {providerWindows.length > 0 ? (
        <div className="usage-provider-windows">
          {providerWindows.map((window, index) => {
            const hidden = isWindowHidden(provider.name, window.label, index, hiddenWindows);

            return (
              <UsageWindowRow
                key={`${provider.name}-${window.label}-${index}`}
                window={window}
                viewMode={viewMode}
                isHidden={hidden}
                onToggleHidden={() => onToggleWindow(provider.name, window.label, index)}
              />
            );
          })}
        </div>
      ) : provider.status === "ok" ? (
        <div className="usage-provider-empty">{t("usage.noDataAvailable", "No usage data available")}</div>
      ) : null}
    </div>
  );
}

/**
 * Loading skeleton for usage providers
 */
function UsageSkeleton() {
  return (
    <div className="usage-skeleton">
      {[1, 2, 3].map((i) => (
        <div key={i} className="usage-skeleton-provider">
          <div className="usage-skeleton-header">
            <div className="usage-skeleton-icon" />
            <div className="usage-skeleton-name" />
            <div className="usage-skeleton-badge" />
          </div>
          <div className="usage-skeleton-bar" />
          <div className="usage-skeleton-text" />
        </div>
      ))}
    </div>
  );
}

/**
 * Usage Indicator Modal
 *
 * Displays AI provider subscription usage across multiple providers.
 * Shows hourly and weekly usage windows with percentage bars,
 * reset timers, and pace indicators.
 */
export function UsageIndicator({ isOpen, onClose, projectId, anchorRect, presentation = "modal" }: UsageIndicatorProps) {
  const { t } = useTranslation("app");
  const isEmbedded = presentation === "embedded";
  const { providers, loading, error, lastUpdated, hasFetched, refresh } = useUsageData({
    autoRefresh: isOpen, // Only poll when modal is open
  });

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDesktopViewport, setIsDesktopViewport] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 769 : false
  );
  const [isTouchReorderMode, setIsTouchReorderMode] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia?.("(pointer: coarse)").matches ?? false;
  });
  const [viewMode, setViewMode] = useState<'used' | 'remaining'>('used');
  const [hiddenWindows, setHiddenWindowsState] = useState<Record<string, string[]>>(() =>
    getHiddenWindows(projectId)
  );
  const [providerOrder, setProviderOrderState] = useState<string[]>(() => getProviderOrder(projectId));
  const [draggingProvider, setDraggingProvider] = useState<string | null>(null);
  const [dragOverProvider, setDragOverProvider] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<"before" | "after" | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(isOpen);
  const [savedSize, setSavedSize] = useState<ModalSize | null>(() => getSavedModalSize(projectId));

  useEffect(() => {
    setSavedSize(getSavedModalSize(projectId));
  }, [projectId]);

  // Persist user resizes via ResizeObserver (debounced).
  // FNXC:UsageIndicator 2026-06-22-00:00: embedded presentation has no resizable
  // popover surface, so skip the desktop popover resize-observer entirely.
  useEffect(() => {
    if (isEmbedded || !isOpen || !isDesktopViewport) return;
    const el = modalRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setScopedItem(
          MODAL_SIZE_STORAGE_KEY,
          JSON.stringify({ width: Math.round(width), height: Math.round(height) }),
          projectId
        );
      }, 250);
    });
    observer.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [isEmbedded, isOpen, isDesktopViewport, projectId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const touchMedia = window.matchMedia?.("(pointer: coarse)");
    const handleResize = () => {
      setIsDesktopViewport(window.innerWidth >= 769);
      setIsTouchReorderMode(touchMedia?.matches ?? false);
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    touchMedia?.addEventListener?.("change", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      touchMedia?.removeEventListener?.("change", handleResize);
    };
  }, []);

  // Trigger refresh when modal opens (isOpen transitions from false to true)
  useEffect(() => {
    // Only refresh when transitioning from closed to open
    if (!wasOpenRef.current && isOpen) {
      // Skip if data is fresh (within 5 seconds) to avoid duplicate requests
      if (!lastUpdated || Date.now() - lastUpdated.getTime() > 5000) {
        refresh();
      }
    }
    
    // Update ref for next render
    wasOpenRef.current = isOpen;
  }, [isOpen, lastUpdated, refresh]);

  // Load view mode preference from localStorage on mount
  useEffect(() => {
    const savedMode = getScopedItem("kb-usage-view-mode", projectId);
    if (savedMode === "used" || savedMode === "remaining") {
      setViewMode(savedMode);
      return;
    }
    setViewMode("used");
  }, [projectId]);

  // Persist view mode to localStorage when it changes
  const handleViewModeChange = useCallback((mode: "used" | "remaining") => {
    setViewMode(mode);
    setScopedItem("kb-usage-view-mode", mode, projectId);
  }, [projectId]);

  useEffect(() => {
    setHiddenWindowsState(getHiddenWindows(projectId));
    setProviderOrderState(getProviderOrder(projectId));
  }, [projectId]);

  useEffect(() => {
    setHiddenWindows(hiddenWindows, projectId);
  }, [hiddenWindows, projectId]);

  const handleToggleWindow = useCallback((providerName: string, windowLabel: string, windowIndex: number) => {
    setHiddenWindowsState((previous) => {
      const windowIdentity = getWindowIdentity(windowLabel, windowIndex);
      const providerHiddenWindows = previous[providerName] ?? [];

      if (isWindowHidden(providerName, windowLabel, windowIndex, previous)) {
        const remaining = providerHiddenWindows.filter(
          (persistedEntry) => !matchesHiddenWindowEntry(persistedEntry, windowLabel, windowIndex)
        );
        if (remaining.length === 0) {
          const { [providerName]: _removed, ...rest } = previous;
          return rest;
        }

        return {
          ...previous,
          [providerName]: remaining,
        };
      }

      return {
        ...previous,
        [providerName]: [...providerHiddenWindows, windowIdentity],
      };
    });
  }, []);

  const handleShowAllHidden = useCallback((providerName: string) => {
    setHiddenWindowsState((previous) => {
      if (!previous[providerName]) {
        return previous;
      }

      const { [providerName]: _removed, ...rest } = previous;
      return rest;
    });
  }, []);

  const reorderProviders = useCallback(
    (rawProviders: ProviderUsage[]): ProviderUsage[] => {
      if (providerOrder.length === 0) {
        return rawProviders;
      }

      const providerMap = new Map(rawProviders.map((provider) => [provider.name, provider]));
      const orderedProviders: ProviderUsage[] = [];

      for (const name of providerOrder) {
        const provider = providerMap.get(name);
        if (provider) {
          orderedProviders.push(provider);
          providerMap.delete(name);
        }
      }

      return [...orderedProviders, ...providerMap.values()];
    },
    [providerOrder]
  );

  const handleProviderDragStart = useCallback((event: DragEvent<HTMLDivElement>, name: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", name);
    setDraggingProvider(name);
  }, []);

  const handleProviderDragOver = useCallback((event: DragEvent<HTMLDivElement>, name: string) => {
    if (!draggingProvider || draggingProvider === name) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const { top, height } = event.currentTarget.getBoundingClientRect();
    const midpoint = top + height / 2;
    const position: "before" | "after" = event.clientY < midpoint ? "before" : "after";

    setDragOverProvider(name);
    setDragOverPosition(position);
  }, [draggingProvider]);

  const handleProviderDrop = useCallback((event: DragEvent<HTMLDivElement>, name: string) => {
    event.preventDefault();

    const draggedName = draggingProvider ?? event.dataTransfer.getData("text/plain");
    if (!draggedName || draggedName === name) {
      setDragOverProvider(null);
      setDragOverPosition(null);
      return;
    }

    const currentOrder = reorderProviders(providers).map((provider) => provider.name);
    const filteredOrder = currentOrder.filter((providerName) => providerName !== draggedName);
    const targetIndex = filteredOrder.indexOf(name);

    if (targetIndex < 0) {
      setDragOverProvider(null);
      setDragOverPosition(null);
      return;
    }

    const insertIndex = dragOverPosition === "after" ? targetIndex + 1 : targetIndex;
    filteredOrder.splice(insertIndex, 0, draggedName);

    setProviderOrder(filteredOrder, projectId);
    setProviderOrderState(filteredOrder);
    setDragOverProvider(null);
    setDragOverPosition(null);
  }, [draggingProvider, dragOverPosition, projectId, providers, reorderProviders]);

  const handleProviderDragEnd = useCallback(() => {
    setDraggingProvider(null);
    setDragOverProvider(null);
    setDragOverPosition(null);
  }, []);

  const moveProviderByOffset = useCallback((providerName: string, direction: -1 | 1) => {
    const currentOrder = reorderProviders(providers).map((provider) => provider.name);
    const currentIndex = currentOrder.indexOf(providerName);
    const targetIndex = currentIndex + direction;

    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= currentOrder.length) {
      return;
    }

    const nextOrder = [...currentOrder];
    const [moved] = nextOrder.splice(currentIndex, 1);
    nextOrder.splice(targetIndex, 0, moved);

    setProviderOrder(nextOrder, projectId);
    setProviderOrderState(nextOrder);
  }, [projectId, providers, reorderProviders]);

  // Handle manual refresh
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refresh();
    setIsRefreshing(false);
  }, [refresh]);

  // Close on Escape key
  // FNXC:UsageIndicator 2026-06-22-00:00: embedded presentation has no modal to
  // dismiss, so Escape-to-close is a modal-only behavior.
  useEffect(() => {
    if (isEmbedded || !isOpen) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isEmbedded, isOpen, onClose]);

  // Close on overlay click
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) return null;

  const showDesktopPopover = Boolean(anchorRect && isDesktopViewport);
  const defaultPopoverWidth = 420;
  const popoverWidth = savedSize?.width ?? defaultPopoverWidth;
  const desktopTop = showDesktopPopover
    ? Math.max(
        DESKTOP_POPOVER_TOP_INSET,
        Math.min((anchorRect?.bottom ?? 0) + DESKTOP_POPOVER_GAP, DESKTOP_POPOVER_NEAR_TOP_MAX)
      )
    : undefined;
  // Anchor popover so its right edge aligns with the anchor button's right edge,
  // but use `left` positioning so native resize (bottom-right handle) feels natural.
  const desktopLeft = showDesktopPopover
    ? Math.max(8, (anchorRect?.right ?? 0) - popoverWidth)
    : undefined;

  const sizeStyle: CSSProperties = isDesktopViewport && savedSize
    ? { width: savedSize.width, height: savedSize.height }
    : {};

  const orderedProviders = reorderProviders(providers);

  const usageContent = (
      <div
        ref={modalRef}
        className={
          isEmbedded
            ? "usage-modal usage-modal--embedded"
            : `usage-modal${showDesktopPopover ? " usage-modal--popover" : " modal"}`
        }
        data-testid="usage-modal"
        style={
          isEmbedded
            ? undefined
            : showDesktopPopover
            ? ({
                position: "fixed",
                top: desktopTop,
                left: desktopLeft,
                ...sizeStyle,
              } as CSSProperties)
            : sizeStyle
        }
      >
        <div className="modal-header">
          <div className="usage-header">
            <Activity size={18} className="usage-header-icon" />
            <h3>{t("usage.title", "Usage")}</h3>
          </div>
          <div className="usage-header-actions">
            <div className="usage-view-toggle" role="group" aria-label={t("usage.viewModeLabel", "Usage view mode")}>
              <button
                className={`usage-view-toggle-btn ${viewMode === 'used' ? 'active' : ''}`}
                onClick={() => handleViewModeChange('used')}
                aria-pressed={viewMode === 'used'}
                data-testid="usage-view-toggle-used"
              >
                {t("usage.viewModeUsed", "Used")}
              </button>
              <button
                className={`usage-view-toggle-btn ${viewMode === 'remaining' ? 'active' : ''}`}
                onClick={() => handleViewModeChange('remaining')}
                aria-pressed={viewMode === 'remaining'}
                data-testid="usage-view-toggle-remaining"
              >
                {t("usage.viewModeRemaining", "Remaining")}
              </button>
            </div>
            {/* FNXC:UsageIndicator 2026-06-22-00:00: embedded presentation drops the
                modal close button; the right-dock owns dismissal. */}
            {!isEmbedded && (
              <button
                className="modal-close"
                onClick={onClose}
                aria-label={t("actions.closeModal", "Close usage modal")}
                data-testid="usage-modal-close"
              >
                <X size={20} />
              </button>
            )}
          </div>
        </div>

        <div className="usage-content" ref={contentRef}>
          {(!hasFetched && !error) && providers.length === 0 ? (
            <UsageSkeleton />
          ) : error && providers.length === 0 ? (
            <div className="usage-error">
              <p>{t("usage.failedToLoad", "Failed to load usage data")}</p>
              <p className="usage-error-message">{error}</p>
              <button className="btn btn-sm" onClick={handleRefresh}>
                {t("actions.retry", "Retry")}
              </button>
            </div>
          ) : providers.length === 0 ? (
            <div className="usage-empty">
              <p>{t("usage.noProvidersConfigured", "No AI providers configured")}</p>
              <p className="usage-empty-hint">
                {t("usage.configureAuthHint", "Configure authentication in Settings to see usage data.")}
              </p>
            </div>
          ) : (
            <div className="usage-providers">
              {orderedProviders.map((provider, index) => (
                <ProviderCard
                  key={provider.name}
                  provider={provider}
                  viewMode={viewMode}
                  hiddenWindows={hiddenWindows}
                  onToggleWindow={handleToggleWindow}
                  onShowAllHidden={handleShowAllHidden}
                  isDragging={draggingProvider === provider.name}
                  isDragOver={dragOverProvider === provider.name}
                  dragOverPosition={dragOverProvider === provider.name ? dragOverPosition : null}
                  onDragStart={(event) => handleProviderDragStart(event, provider.name)}
                  onDragOver={(event) => handleProviderDragOver(event, provider.name)}
                  onDragLeave={() => {
                    if (dragOverProvider === provider.name) {
                      setDragOverProvider(null);
                      setDragOverPosition(null);
                    }
                  }}
                  onDrop={(event) => handleProviderDrop(event, provider.name)}
                  onDragEnd={handleProviderDragEnd}
                  isTouchReorderMode={isTouchReorderMode}
                  canMoveUp={index > 0}
                  canMoveDown={index < orderedProviders.length - 1}
                  onMoveUp={() => moveProviderByOffset(provider.name, -1)}
                  onMoveDown={() => moveProviderByOffset(provider.name, 1)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="modal-actions usage-actions">
          <div className="modal-actions-left usage-actions-left">
            <div className="usage-last-updated">
              {lastUpdated && (
                <span>{t("usage.lastUpdated", "Last updated: {{time}}", { time: lastUpdated.toLocaleTimeString() })}</span>
              )}
            </div>
          </div>
          <div className="modal-actions-right usage-actions-right">
            <button
              className="btn btn-sm"
              onClick={handleRefresh}
              disabled={loading || isRefreshing}
              data-testid="usage-refresh-btn"
            >
              <RefreshCw size={14} className={isRefreshing ? "spin" : ""} style={{ marginRight: 6 }} />
              {t("actions.refresh", "Refresh")}
            </button>
            <button className="btn btn-primary btn-sm" onClick={onClose}>
              {t("actions.close", "Close")}
            </button>
          </div>
        </div>
      </div>
  );

  // FNXC:UsageIndicator 2026-06-22-00:00: embedded presentation renders the usage
  // view as a plain flow container inside the right-dock (no fixed overlay, no
  // popover backdrop), filling its parent.
  if (isEmbedded) {
    return (
      <div className="usage-indicator-embedded right-dock-embedded-view">
        {usageContent}
      </div>
    );
  }

  if (showDesktopPopover) {
    return (
      <>
        <div
          className="usage-popover-backdrop"
          onClick={onClose}
          data-testid="usage-modal-overlay"
        />
        {usageContent}
      </>
    );
  }

  return (
    <div className="modal-overlay open usage-modal-overlay" onClick={handleOverlayClick} data-testid="usage-modal-overlay">
      {usageContent}
    </div>
  );
}
