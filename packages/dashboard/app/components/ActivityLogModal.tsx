// ActivityLogModal styles (.activity-log-*, .activity-icon, etc.) currently live
// in ScriptsModal.css. Until extracted, import that file so this eager modal is styled.
import "./ScriptsModal.css";
import { useState, useEffect } from "react";
import { X, History, Trash2, Filter, RefreshCw, CheckCircle, XCircle, ArrowRight, Plus, Settings, AlertCircle, Loader2, Folder } from "lucide-react";
import { clearActivityLog, type ActivityLogEntry, type ActivityEventType, type ActivityFeedEntry } from "../api";
import { useActivityLog } from "../hooks/useActivityLog";
import type { Task, ProjectInfo } from "@fusion/core";

interface ActivityLogModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: Task[];
  onOpenTaskDetail?: (taskId: string) => void;
  /** When provided, shows only activity for this project */
  projectId?: string;
  /** List of all projects for filter dropdown */
  projects?: ProjectInfo[];
  /** Called when project filter changes */
  onProjectFilterChange?: (projectId: string | undefined) => void;
  /** Current project context - when set, uses per-project activity log */
  currentProject?: ProjectInfo | null;
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

/**
 * ActivityLogModal - Activity log with project attribution and filtering
 *
 * Data source selection:
 * - Project view (currentProject set): reads from the per-project activity
 *   log via /api/activity, which is always populated with task lifecycle events.
 * - Overview mode (no currentProject): reads from the unified central
 *   feed via /api/activity-feed, which aggregates activity across all projects.
 *   The project filter dropdown allows narrowing results to a specific project.
 *
 * Features:
 * - Project name badge for each activity entry
 * - Project filter dropdown (when projects list provided)
 * - Event type filter
 * - Real-time updates via useActivityLog hook
 */
export function ActivityLogModal({ 
  isOpen,
  onClose,
  tasks: _tasks,
  onOpenTaskDetail,
  projectId,
  projects = [],
  onProjectFilterChange,
  currentProject,
}: ActivityLogModalProps) {
  const [filteredType, setFilteredType] = useState<ActivityEventType | "all">("all");
  const [filteredProjectId, setFilteredProjectId] = useState<string | "all">(projectId || "all");
  const [showConfirmClear, setShowConfirmClear] = useState(false);
  
  // Sync with external projectId prop
  useEffect(() => {
    setFilteredProjectId(projectId || "all");
  }, [projectId]);
  
  // Convert filters to the format expected by useActivityLog
  const activityType = filteredType === "all" ? undefined : filteredType;
  const activeProjectId = filteredProjectId === "all" ? undefined : filteredProjectId;
  
  // Determine data source:
  // - In project view (currentProject set): use per-project activity log (/api/activity)
  //   which is always populated with task lifecycle events for the current project.
  // - In overview mode (no currentProject): use unified central feed (/api/activity-feed)
  //   which aggregates activity across all registered projects.
  // The project filter dropdown (projects prop) still appears to filter by project,
  // but the default data source is the per-project log in project view.
  const useCentralFeed = !currentProject && projects.length > 0;

  // Use the hook for data fetching
  const { 
    entries, 
    loading: isLoading, 
    error, 
    refresh, 
    hasMore 
  } = useActivityLog({ 
    projectId: activeProjectId, 
    type: activityType, 
    limit: 100,
    autoRefresh: isOpen,
    useCentralFeed,
  });

  // Convert entries to ActivityLogEntry format for compatibility
  const convertedEntries: ActivityLogEntry[] = entries.map((entry: ActivityFeedEntry) => ({
    id: entry.id,
    timestamp: entry.timestamp,
    type: entry.type,
    taskId: entry.taskId,
    taskTitle: entry.taskTitle,
    details: entry.details,
    metadata: entry.metadata,
    projectId: entry.projectId,
    projectName: entry.projectName,
  }));

  const handleClearLog = async () => {
    try {
      await clearActivityLog();
      refresh();
      setShowConfirmClear(false);
    } catch {
      // Error handled by hook
      setShowConfirmClear(false);
    }
  };

  const handleTaskClick = (taskId: string) => {
    if (onOpenTaskDetail) {
      onOpenTaskDetail(taskId);
    }
  };

  const handleProjectFilterChange = (value: string) => {
    setFilteredProjectId(value);
    onProjectFilterChange?.(value === "all" ? undefined : value);
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

  // Determine if any filter is active
  const isFilterActive = filteredType !== "all" || filteredProjectId !== "all";

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      data-testid="activity-log-modal-overlay"
    >
      <div className="modal modal-lg activity-log-modal" data-testid="activity-log-modal">
        {/* Header — uses shared modal-header pattern for consistent close control */}
        <div className="modal-header activity-log-header">
          <div className="activity-log-title">
            <History size={18} />
            <span>Activity Log</span>
          </div>
          <div className="activity-log-actions">
            {/* Project filter dropdown (when projects provided) */}
            {projects.length > 0 && (
              <div className="activity-log-filter activity-log-filter--project">
                <Folder size={14} />
                <select
                  value={filteredProjectId}
                  onChange={(e) => handleProjectFilterChange(e.target.value)}
                  className="activity-log-filter-select"
                  data-testid="activity-project-filter"
                >
                  <option value="all">All Projects</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Event type filter dropdown */}
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
              onClick={() => refresh()}
              title="Refresh"
              data-testid="activity-refresh"
            >
              {isLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            </button>

            {/* Clear button */}
            {convertedEntries.length > 0 && (
              <button
                className="activity-log-clear"
                onClick={() => setShowConfirmClear(true)}
                title="Clear Log"
                data-testid="activity-clear"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
          {/* Close button — uses shared modal-close for consistent sizing and alignment */}
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            data-testid="activity-close"
          >
            ×
          </button>
        </div>

        {/* Active filters display */}
        {isFilterActive && (
          <div className="activity-log-active-filters">
            <span className="activity-log-filter-label">Active filters:</span>
            {filteredProjectId !== "all" && (
              <span className="activity-log-filter-badge">
                Project: {projects.find(p => p.id === filteredProjectId)?.name || filteredProjectId}
              </span>
            )}
            {filteredType !== "all" && (
              <span className="activity-log-filter-badge">
                Type: {EVENT_TYPE_LABELS[filteredType]}
              </span>
            )}
            <button
              className="activity-log-clear-filters"
              onClick={() => {
                setFilteredType("all");
                setFilteredProjectId("all");
                onProjectFilterChange?.(undefined);
              }}
            >
              Clear all
            </button>
          </div>
        )}

        {/* Content */}
        <div className="activity-log-content" data-testid="activity-log-content">
          {error && (
            <div className="activity-log-error" data-testid="activity-error">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          {convertedEntries.length === 0 && !isLoading && !error && (
            <div className="activity-log-empty" data-testid="activity-empty">
              <History size={48} className="activity-log-empty-icon" />
              <p>
                {isFilterActive 
                  ? "No activity matches the current filters" 
                  : "No activity recorded yet"}
              </p>
              {isFilterActive && (
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setFilteredType("all");
                    setFilteredProjectId("all");
                    onProjectFilterChange?.(undefined);
                  }}
                >
                  Clear Filters
                </button>
              )}
            </div>
          )}

          <div className="activity-log-list">
            {convertedEntries.map((entry) => (
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
                      {typeof entry.metadata.from === "string" && typeof entry.metadata.to === "string" && (
                        <span className="activity-log-metadata-item">
                          {entry.metadata.from} → {entry.metadata.to}
                        </span>
                      )}
                      {typeof entry.metadata.merged === "boolean" && (
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
              onClick={refresh}
              data-testid="activity-load-more"
            >
              Load More
            </button>
          )}

          {isLoading && convertedEntries.length > 0 && (
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
