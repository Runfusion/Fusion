import { useState, useEffect, useCallback, useRef } from "react";
import { X, History, Trash2, Filter, RefreshCw, CheckCircle, XCircle, ArrowRight, Plus, Settings, AlertCircle, Loader2 } from "lucide-react";
import { fetchActivityLog, clearActivityLog, type ActivityLogEntry, type ActivityEventType } from "../api";
import type { Task } from "@kb/core";

interface ActivityLogModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: Task[];
  onOpenTaskDetail?: (taskId: string) => void;
}

const EVENT_TYPE_LABELS: Record<ActivityEventType, string> = {
  "task:created": "Task Created",
  "task:moved": "Task Moved",
  "task:updated": "Task Updated",
  "task:deleted": "Task Deleted",
  "task:merged": "Task Merged",
  "task:failed": "Task Failed",
  "settings:updated": "Settings Updated",
};

const EVENT_TYPE_ICONS: Record<ActivityEventType, React.ReactNode> = {
  "task:created": <Plus size={14} className="activity-icon created" />,
  "task:moved": <ArrowRight size={14} className="activity-icon moved" />,
  "task:updated": <RefreshCw size={14} className="activity-icon updated" />,
  "task:deleted": <X size={14} className="activity-icon deleted" />,
  "task:merged": <CheckCircle size={14} className="activity-icon merged" />,
  "task:failed": <XCircle size={14} className="activity-icon failed" />,
  "settings:updated": <Settings size={14} className="activity-icon settings" />,
};

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ActivityLogModal({ isOpen, onClose, tasks, onOpenTaskDetail }: ActivityLogModalProps) {
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [filteredType, setFilteredType] = useState<ActivityEventType | "all">("all");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirmClear, setShowConfirmClear] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  const loadActivityLog = useCallback(async (since?: string) => {
    try {
      setIsLoading(true);
      setError(null);
      const options: { limit: number; since?: string; type?: ActivityEventType } = {
        limit: 100,
        since,
      };
      if (filteredType !== "all") {
        options.type = filteredType;
      }
      const data = await fetchActivityLog(options);
      if (since) {
        // Append older entries
        setEntries((prev) => [...prev, ...data]);
      } else {
        // Replace with fresh entries
        setEntries(data);
      }
      setHasMore(data.length === 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity log");
    } finally {
      setIsLoading(false);
    }
  }, [filteredType]);

  // Initial load and filter change
  useEffect(() => {
    if (isOpen) {
      loadActivityLog();
    }
  }, [isOpen, loadActivityLog]);

  // Auto-refresh every 30 seconds when modal is open
  useEffect(() => {
    if (isOpen) {
      pollingRef.current = setInterval(() => {
        loadActivityLog();
      }, 30000);
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [isOpen, loadActivityLog]);

  const handleLoadMore = () => {
    if (entries.length > 0) {
      const lastEntry = entries[entries.length - 1];
      loadActivityLog(lastEntry.timestamp);
    }
  };

  const handleClearLog = async () => {
    try {
      await clearActivityLog();
      setEntries([]);
      setShowConfirmClear(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear activity log");
    }
  };

  const handleTaskClick = (taskId: string) => {
    if (onOpenTaskDetail) {
      onOpenTaskDetail(taskId);
    }
  };

  // Handle escape key to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showConfirmClear) {
          setShowConfirmClear(false);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose, showConfirmClear]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="activity-log-modal-overlay"
    >
      <div className="modal activity-log-modal" data-testid="activity-log-modal">
        {/* Header */}
        <div className="activity-log-header">
          <div className="activity-log-title">
            <History size={18} />
            <span>Activity Log</span>
          </div>
          <div className="activity-log-actions">
            {/* Filter dropdown */}
            <div className="activity-log-filter">
              <Filter size={14} />
              <select
                value={filteredType}
                onChange={(e) => setFilteredType(e.target.value as ActivityEventType | "all")}
                className="activity-log-filter-select"
                data-testid="activity-filter"
              >
                <option value="all">All Events</option>
                {Object.entries(EVENT_TYPE_LABELS).map(([type, label]) => (
                  <option key={type} value={type}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            {/* Refresh button */}
            <button
              className="activity-log-refresh"
              onClick={() => loadActivityLog()}
              disabled={isLoading}
              title="Refresh"
              data-testid="activity-refresh"
            >
              {isLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            </button>

            {/* Clear button */}
            {entries.length > 0 && (
              <button
                className="activity-log-clear"
                onClick={() => setShowConfirmClear(true)}
                title="Clear Log"
                data-testid="activity-clear"
              >
                <Trash2 size={14} />
              </button>
            )}

            {/* Close button */}
            <button
              className="activity-log-close"
              onClick={onClose}
              title="Close"
              data-testid="activity-close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="activity-log-content" data-testid="activity-log-content">
          {error && (
            <div className="activity-log-error" data-testid="activity-error">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          {entries.length === 0 && !isLoading && !error && (
            <div className="activity-log-empty" data-testid="activity-empty">
              <History size={48} className="activity-log-empty-icon" />
              <p>No activity recorded yet</p>
            </div>
          )}

          <div className="activity-log-list">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="activity-log-entry"
                data-testid="activity-entry"
              >
                <div className="activity-log-entry-icon">
                  {EVENT_TYPE_ICONS[entry.type]}
                </div>
                <div className="activity-log-entry-content">
                  <div className="activity-log-entry-header">
                    <span className="activity-log-entry-type">
                      {EVENT_TYPE_LABELS[entry.type]}
                    </span>
                    <span className="activity-log-entry-time">
                      {formatTimestamp(entry.timestamp)}
                    </span>
                  </div>
                  <div className="activity-log-entry-details">
                    {entry.taskId && (
                      <button
                        className="activity-log-task-link"
                        onClick={() => handleTaskClick(entry.taskId!)}
                        data-testid="activity-task-link"
                      >
                        {entry.taskId}
                      </button>
                    )}
                    {entry.taskTitle && (
                      <span className="activity-log-task-title">{entry.taskTitle}</span>
                    )}
                    <span className="activity-log-entry-text">{entry.details}</span>
                  </div>
                  {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                    <div className="activity-log-entry-metadata">
                      {entry.metadata.from && entry.metadata.to && (
                        <span className="activity-log-metadata-item">
                          {entry.metadata.from} → {entry.metadata.to}
                        </span>
                      )}
                      {entry.metadata.merged !== undefined && (
                        <span className={`activity-log-metadata-item ${entry.metadata.merged ? "success" : "error"}`}>
                          {entry.metadata.merged ? "Merged" : "Not merged"}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {hasMore && !isLoading && (
            <button
              className="activity-log-load-more"
              onClick={handleLoadMore}
              data-testid="activity-load-more"
            >
              Load More
            </button>
          )}

          {isLoading && entries.length > 0 && (
            <div className="activity-log-loading">
              <Loader2 size={20} className="spin" />
            </div>
          )}
        </div>

        {/* Confirmation dialog for clear */}
        {showConfirmClear && (
          <div className="activity-log-confirm-overlay">
            <div className="activity-log-confirm-dialog">
              <h3>Clear Activity Log?</h3>
              <p>This will permanently delete all activity log entries. This action cannot be undone.</p>
              <div className="activity-log-confirm-actions">
                <button
                  className="activity-log-confirm-cancel"
                  onClick={() => setShowConfirmClear(false)}
                >
                  Cancel
                </button>
                <button
                  className="activity-log-confirm-clear"
                  onClick={handleClearLog}
                >
                  Clear Log
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
