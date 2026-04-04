import { useState, useEffect, useCallback, useRef } from "react";
import { X, RefreshCw, Activity, TrendingUp, CheckCircle, AlertTriangle } from "lucide-react";
import type { ProviderUsage, UsageWindow } from "../api";
import { useUsageData } from "../hooks/useUsageData";
import { ProviderIcon } from "./ProviderIcon";

interface UsageIndicatorProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Format an ISO 8601 timestamp into a user-friendly absolute time string.
 * Shows time like "2:30 PM" for today, "Tue 2:30 PM" for this week,
 * or "Jan 15, 2:30 PM" for later dates.
 *
 * Used by UsageWindowRow to display the absolute reset time next to the
 * relative "resets in X" text when the backend provides a canonical resetAt
 * timestamp. Currently populated only for Claude session/windows where the
 * reset timestamp is available from the API or CLI fallback parser.
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

  // Check if within the next 7 days — show short weekday
  const daysUntil = Math.round(
    (date.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
  );
  if (daysUntil > 0 && daysUntil <= 6) {
    const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
    return `${weekday} ${timeStr}`;
  }

  // Beyond a week — show full date
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

interface UsageWindowRowProps {
  window: UsageWindow;
  viewMode: 'used' | 'remaining';
  providerName: string;
}

/**
 * Determine whether a usage window is a Claude weekly window.
 *
 * Claude weekly windows (e.g. "Weekly", "Weekly (Sonnet)", "Weekly (Opus)")
 * intentionally suppress the absolute reset timestamp display because the
 * relative text ("resets in 3d") already provides the most useful information
 * for weekly quota planning. Session windows (e.g. "Session (5h)") and
 * non-Claude providers continue to show the absolute timestamp when available.
 */
function isClaudeWeeklyWindow(providerName: string, windowLabel: string): boolean {
  const normalizedProvider = providerName.toLowerCase();
  const isClaudeProvider = normalizedProvider.includes("claude") || normalizedProvider.includes("anthropic");
  const isWeeklyWindow = windowLabel.toLowerCase().startsWith("weekly");
  return isClaudeProvider && isWeeklyWindow;
}

/**
 * Single usage window row with progress bar
 */
function UsageWindowRow({ window, viewMode, providerName }: UsageWindowRowProps) {
  const colorClass = getUsageColorClass(window.percentUsed);
  const isRemainingMode = viewMode === 'remaining';
  
  // Display percentage based on view mode, but color always based on actual usage
  // Round percentages for cleaner display
  const displayPercent = Math.round(isRemainingMode ? window.percentLeft : window.percentUsed);
  const headerText = isRemainingMode ? `${Math.round(window.percentLeft)}% remaining` : `${Math.round(window.percentUsed)}% used`;
  const footerText = isRemainingMode ? `${Math.round(window.percentUsed)}% used` : `${Math.round(window.percentLeft)}% left`;

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
    <div className="usage-window">
      <div className="usage-window-header">
        <span className="usage-window-label">{window.label}</span>
        <span className="usage-window-percentage">{headerText}</span>
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
          {window.resetText && (
            <span className="usage-window-reset">{window.resetText}</span>
          )}
          {/* Absolute reset timestamp: shown for session windows and non-Claude providers.
              Claude weekly windows intentionally suppress this — the relative "resets in Xd"
              text is more useful for weekly quota planning than an exact calendar timestamp. */}
          {window.resetAt && !isClaudeWeeklyWindow(providerName, window.label) && (
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
  
  // Return the original name as fallback (ProviderIcon will show a default icon)
  return providerName;
}

/**
 * Provider card showing status and usage windows
 */
function ProviderCard({ provider, viewMode }: ProviderCardProps) {
  const getStatusBadge = () => {
    switch (provider.status) {
      case "ok":
        return (
          <span className="usage-status-badge usage-status-badge--connected">
            Connected
          </span>
        );
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
        {getStatusBadge()}
      </div>

      {provider.error && (
        <div className="usage-provider-error">
          {provider.error}
        </div>
      )}

      {(provider.plan || provider.email) && (
        <div className="usage-provider-meta">
          {provider.plan && <span className="usage-provider-plan">{provider.plan}</span>}
          {provider.email && <span className="usage-provider-email">{provider.email}</span>}
        </div>
      )}

      {provider.windows.length > 0 ? (
        <div className="usage-provider-windows">
          {provider.windows.map((window, index) => (
            <UsageWindowRow key={`${provider.name}-${window.label}-${index}`} window={window} viewMode={viewMode} providerName={provider.name} />
          ))}
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
export function UsageIndicator({ isOpen, onClose }: UsageIndicatorProps) {
  const { providers, loading, error, lastUpdated, refresh } = useUsageData({
    autoRefresh: isOpen, // Only poll when modal is open
  });

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [viewMode, setViewMode] = useState<'used' | 'remaining'>('used');
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
    const savedMode = localStorage.getItem('kb-usage-view-mode');
    if (savedMode === 'used' || savedMode === 'remaining') {
      setViewMode(savedMode);
    }
  }, []);

  // Persist view mode to localStorage when it changes
  const handleViewModeChange = useCallback((mode: 'used' | 'remaining') => {
    setViewMode(mode);
    localStorage.setItem('kb-usage-view-mode', mode);
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

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick} data-testid="usage-modal-overlay">
      <div className="modal usage-modal" data-testid="usage-modal">
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
                <ProviderCard key={provider.name} provider={provider} viewMode={viewMode} />
              ))}
            </div>
          )}
        </div>

        <div className="modal-actions usage-actions">
          <div className="usage-last-updated">
            {lastUpdated && (
              <span>Last updated: {lastUpdated.toLocaleTimeString()}</span>
            )}
          </div>
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
}
