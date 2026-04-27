import { useState, useEffect, useCallback, useRef } from "react";
import type { CSSProperties } from "react";
import { X, RefreshCw, Activity, TrendingUp, CheckCircle, AlertTriangle, Eye, EyeOff } from "lucide-react";
import type { ProviderUsage, UsageWindow } from "../api";
import { useUsageData } from "../hooks/useUsageData";
import { ProviderIcon } from "./ProviderIcon";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";
import "./UsageIndicator.css";

interface UsageIndicatorProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
  anchorRect?: DOMRect | null;
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

function isWindowHidden(
  providerName: string,
  windowLabel: string,
  hidden: Record<string, string[]>
): boolean {
  return hidden[providerName]?.includes(windowLabel) ?? false;
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
  const colorClass = getUsageColorClass(window.percentUsed);
  const isRemainingMode = viewMode === 'remaining';

  // Display percentage based on view mode, but color always based on actual usage
  // Round percentages for cleaner display
  const displayPercent = Math.round(isRemainingMode ? window.percentLeft : window.percentUsed);
  const headerText = isRemainingMode
    ? `${Math.round(window.percentLeft)}% remaining`
    : `${Math.round(window.percentUsed)}% used`;
  const footerText = isRemainingMode
    ? `${Math.round(window.percentUsed)}% used`
    : `${Math.round(window.percentLeft)}% left`;

  // If resetText is null but resetAt exists, generate relative text from resetAt as a fallback
  let displayResetText = window.resetText;
  if (!displayResetText && window.resetAt) {
    const msLeft = new Date(window.resetAt).getTime() - Date.now();
    if (msLeft > 0) {
      const hours = Math.floor(msLeft / (60 * 60 * 1000));
      const days = Math.floor(hours / 24);
      const remHours = hours % 24;
      if (days > 0 && remHours > 0) {
        displayResetText = `resets in ${days}d ${remHours}h`;
      } else if (days > 0) {
        displayResetText = `resets in ${days}d`;
      } else if (hours > 0) {
        displayResetText = `resets in ${hours}h`;
      } else {
        const mins = Math.floor(msLeft / (60 * 1000));
        displayResetText = `resets in ${mins}m`;
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
          <button
            className="btn-icon usage-window-hide-btn"
            onClick={onToggleHidden}
            aria-label={`${isHidden ? "Show" : "Hide"} ${window.label}`}
            data-testid="usage-window-hide-btn"
          >
            {isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
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
  onToggleWindow: (providerName: string, windowLabel: string) => void;
  onShowAllHidden: (providerName: string) => void;
}

/**
 * Map provider names to ProviderIcon provider keys
 */
function getProviderIconKey(providerName: string): string {
  const normalized = providerName.toLowerCase();
  
  // Map common provider names to their icon keys
  if (normalized.includes('claude') || normalized.includes('anthropic')) {
    return 'anthropic';
  }
  if (normalized.includes('codex') || normalized.includes('openai') || normalized.includes('gpt')) {
    return 'openai';
  }
  if (normalized.includes('gemini') || normalized.includes('google')) {
    return 'google';
  }
  if (normalized.includes('ollama')) {
    return 'ollama';
  }
  if (normalized.includes('minimax')) {
    return 'minimax';
  }
  if (normalized.includes('zai') || normalized.includes('zhipu')) {
    return 'zai';
  }
  if (normalized.includes('kimi') || normalized.includes('moonshot')) {
    return 'kimi';
  }
  if (normalized.includes('bedrock') || normalized.includes('amazon')) {
    return 'bedrock';
  }
  if (normalized.includes('xai') || normalized.includes('grok')) {
    return 'xai';
  }
  if (normalized.includes('opencode')) {
    return 'opencode';
  }
  if (normalized.includes('copilot') || normalized === 'github copilot') {
    return 'github-copilot';
  }

  // Return the original name as fallback (ProviderIcon will show a default icon)
  return providerName;
}

/**
 * Provider card showing status and usage windows
 */
function ProviderCard({
  provider,
  viewMode,
  hiddenWindows,
  onToggleWindow,
  onShowAllHidden,
}: ProviderCardProps) {
  const hiddenCount = hiddenWindows[provider.name]?.length ?? 0;
  const getStatusBadge = () => {
    switch (provider.status) {
      case "ok":
        return null;
      case "error":
        return (
          <span className="usage-status-badge usage-status-badge--error">
            Error
          </span>
        );
      case "no-auth":
      default:
        return (
          <span className="usage-status-badge usage-status-badge--not-configured">
            Not configured
          </span>
        );
    }
  };

  return (
    <div className="usage-provider" data-provider={provider.name} data-status={provider.status}>
      <div className="usage-provider-header">
        <div className="usage-provider-info">
          <ProviderIcon provider={getProviderIconKey(provider.name)} size="md" />
          <span className="usage-provider-name">{provider.name}</span>
        </div>
        <div className="usage-provider-actions">
          {getStatusBadge()}
          {hiddenCount > 0 && (
            <button
              className="btn btn-sm usage-show-hidden-btn"
              onClick={() => onShowAllHidden(provider.name)}
              data-testid="usage-show-hidden-btn"
            >
              Show hidden ({hiddenCount})
            </button>
          )}
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

      {provider.windows.length > 0 ? (
        <div className="usage-provider-windows">
          {provider.windows.map((window, index) => {
            const hidden = isWindowHidden(provider.name, window.label, hiddenWindows);

            return (
              <UsageWindowRow
                key={`${provider.name}-${window.label}-${index}`}
                window={window}
                viewMode={viewMode}
                isHidden={hidden}
                onToggleHidden={() => onToggleWindow(provider.name, window.label)}
              />
            );
          })}
        </div>
      ) : provider.status === "ok" ? (
        <div className="usage-provider-empty">No usage data available</div>
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
export function UsageIndicator({ isOpen, onClose, projectId, anchorRect }: UsageIndicatorProps) {
  const { providers, loading, error, lastUpdated, refresh } = useUsageData({
    autoRefresh: isOpen, // Only poll when modal is open
  });

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDesktopViewport, setIsDesktopViewport] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 769 : false
  );
  const [viewMode, setViewMode] = useState<'used' | 'remaining'>('used');
  const [hiddenWindows, setHiddenWindowsState] = useState<Record<string, string[]>>(() =>
    getHiddenWindows(projectId)
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(isOpen);
  const hasCompletedInitialFetchRef = useRef(false);

  // Reset initial fetch flag when modal closes to show skeleton on next open
  useEffect(() => {
    if (!isOpen) {
      hasCompletedInitialFetchRef.current = false;
    }
  }, [isOpen]);

  // Track when initial fetch completes (providers are populated)
  useEffect(() => {
    if (providers.length > 0) {
      hasCompletedInitialFetchRef.current = true;
    }
  }, [providers.length]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleResize = () => {
      setIsDesktopViewport(window.innerWidth >= 769);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
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
  }, [projectId]);

  useEffect(() => {
    setHiddenWindows(hiddenWindows, projectId);
  }, [hiddenWindows, projectId]);

  const handleToggleWindow = useCallback((providerName: string, windowLabel: string) => {
    setHiddenWindowsState((previous) => {
      if (isWindowHidden(providerName, windowLabel, previous)) {
        const remaining = (previous[providerName] ?? []).filter((label) => label !== windowLabel);
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
        [providerName]: [...(previous[providerName] ?? []), windowLabel],
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

  // Handle manual refresh
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refresh();
    setIsRefreshing(false);
  }, [refresh]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

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
  const desktopGap = 8;
  const maxTopPadding = 12;
  const desktopTop = showDesktopPopover
    ? Math.min((anchorRect?.bottom ?? 0) + desktopGap, window.innerHeight - maxTopPadding)
    : undefined;
  const desktopRight = showDesktopPopover
    ? Math.max(window.innerWidth - (anchorRect?.right ?? 0), 0)
    : undefined;

  const usageContent = (
      <div
        className={`usage-modal${showDesktopPopover ? " usage-modal--popover" : " modal"}`}
        data-testid="usage-modal"
        style={
          showDesktopPopover
            ? ({
                position: "fixed",
                top: desktopTop,
                right: desktopRight,
              } as CSSProperties)
            : undefined
        }
      >
        <div className="modal-header">
          <div className="usage-header">
            <Activity size={18} className="usage-header-icon" />
            <h3>Usage</h3>
          </div>
          <div className="usage-header-actions">
            <div className="usage-view-toggle" role="group" aria-label="Usage view mode">
              <button
                className={`usage-view-toggle-btn ${viewMode === 'used' ? 'active' : ''}`}
                onClick={() => handleViewModeChange('used')}
                aria-pressed={viewMode === 'used'}
                data-testid="usage-view-toggle-used"
              >
                Used
              </button>
              <button
                className={`usage-view-toggle-btn ${viewMode === 'remaining' ? 'active' : ''}`}
                onClick={() => handleViewModeChange('remaining')}
                aria-pressed={viewMode === 'remaining'}
                data-testid="usage-view-toggle-remaining"
              >
                Remaining
              </button>
            </div>
            <button
              className="modal-close"
              onClick={onClose}
              aria-label="Close usage modal"
              data-testid="usage-modal-close"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="usage-content" ref={contentRef}>
          {(loading || (!hasCompletedInitialFetchRef.current && !error)) && providers.length === 0 ? (
            <UsageSkeleton />
          ) : error && providers.length === 0 ? (
            <div className="usage-error">
              <p>Failed to load usage data</p>
              <p className="usage-error-message">{error}</p>
              <button className="btn btn-sm" onClick={handleRefresh}>
                Retry
              </button>
            </div>
          ) : providers.length === 0 ? (
            <div className="usage-empty">
              <p>No AI providers configured</p>
              <p className="usage-empty-hint">
                Configure authentication in Settings to see usage data.
              </p>
            </div>
          ) : (
            <div className="usage-providers">
              {providers.map((provider) => (
                <ProviderCard
                  key={provider.name}
                  provider={provider}
                  viewMode={viewMode}
                  hiddenWindows={hiddenWindows}
                  onToggleWindow={handleToggleWindow}
                  onShowAllHidden={handleShowAllHidden}
                />
              ))}
            </div>
          )}
        </div>

        <div className="modal-actions usage-actions">
          <div className="modal-actions-left usage-actions-left">
            <div className="usage-last-updated">
              {lastUpdated && (
                <span>Last updated: {lastUpdated.toLocaleTimeString()}</span>
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
              Refresh
            </button>
            <button className="btn btn-primary btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
  );

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
    <div className="modal-overlay open" onClick={handleOverlayClick} data-testid="usage-modal-overlay">
      {usageContent}
    </div>
  );
}
