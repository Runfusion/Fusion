import { useState, useEffect, useCallback, useRef } from "react";
import { X, RefreshCw, Activity } from "lucide-react";
import type { ProviderUsage, UsageWindow } from "../api";
import { useUsageData } from "../hooks/useUsageData";

interface UsageIndicatorProps {
  isOpen: boolean;
  onClose: () => void;
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

/**
 * Single usage window row with progress bar
 */
function UsageWindowRow({ window }: { window: UsageWindow }) {
  const colorClass = getUsageColorClass(window.percentUsed);

  return (
    <div className="usage-window">
      <div className="usage-window-header">
        <span className="usage-window-label">{window.label}</span>
        <span className="usage-window-percentage">{window.percentUsed}% used</span>
      </div>
      <div className="usage-progress-bar">
        <div
          className={`usage-progress-fill ${colorClass}`}
          style={{ width: `${window.percentUsed}%` }}
          role="progressbar"
          aria-valuenow={window.percentUsed}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${window.label} usage: ${window.percentUsed}%`}
        />
      </div>
      <div className="usage-window-footer">
        <span className="usage-window-left">{window.percentLeft}% left</span>
        {window.resetText && (
          <span className="usage-window-reset">{window.resetText}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Provider card showing status and usage windows
 */
function ProviderCard({ provider }: { provider: ProviderUsage }) {
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
          <span className="usage-provider-icon" role="img" aria-label={provider.name}>
            {provider.icon}
          </span>
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
            <UsageWindowRow key={`${provider.name}-${window.label}-${index}`} window={window} />
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
  const contentRef = useRef<HTMLDivElement>(null);

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
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Close usage modal"
            data-testid="usage-modal-close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="usage-content" ref={contentRef}>
          {loading && providers.length === 0 ? (
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
                <ProviderCard key={provider.name} provider={provider} />
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
            <RefreshCw size={14} className={isRefreshing ? "spin" : ""} />
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
