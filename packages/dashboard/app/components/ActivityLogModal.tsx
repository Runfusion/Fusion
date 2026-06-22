// Base ActivityLogModal styles (.activity-log-*, .activity-icon, etc.) currently live
// in ScriptsModal.css. Until fully extracted, import that file so this eager modal is styled.
import "./ScriptsModal.css";
// Embedded (right-dock) activity-log styles were extracted to their own file next to this component.
import "./ActivityLogModal.css";
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { X, History, Trash2, Filter, RefreshCw, CheckCircle, XCircle, ArrowRight, Plus, Settings, AlertCircle, Loader2, Folder } from "lucide-react";
import { clearActivityLog, type ActivityLogEntry, type ActivityEventType, type ActivityFeedEntry } from "../api";
import { useActivityLog } from "../hooks/useActivityLog";
import { useEmbeddedPresentation, type ModalPresentation } from "../hooks/useEmbeddedPresentation";
import type { Task, ProjectInfo } from "@fusion/core";
import { linkifyFilePaths } from "../utils/filePathLinkify";
import { getRelativeTimeBucket } from "../utils/relativeTimeAgo";

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
  /*
  FNXC:RightDockEmbedded 2026-06-22-00:00:
  Right-dock redesign renders dock items inline (not as fixed popup overlays). When presentation="embedded" the component drops the .modal-overlay fixed full-screen host and the modal close button (the dock owns its own header/close), and disables modal-only Escape-to-close. presentation="modal" (default) stays byte-identical to preserve existing modal behavior.
  */
  presentation?: ModalPresentation;
}

function getEventTypeLabels(t: TFunction<"app">): Record<ActivityEventType, string> {
  return {
    "task:created": t("activityLog.eventType.taskCreated", "Task Created"),
    "task:moved": t("activityLog.eventType.taskMoved", "Task Moved"),
    "task:updated": t("activityLog.eventType.taskUpdated", "Task Updated"),
    "task:deleted": t("activityLog.eventType.taskDeleted", "Task Deleted"),
    "task:merged": t("activityLog.eventType.taskMerged", "Task Merged"),
    "task:failed": t("activityLog.eventType.taskFailed", "Task Failed"),
    "task:release-authorization-required": t("activityLog.eventType.releaseAuthorizationRequired", "Release Authorization Required"),
    "task:duplicate-warning-overridden": t("activityLog.eventType.duplicateWarningOverridden", "Duplicate Warning Overridden"),
    "task:auto-archived-ghost-bug": t("activityLog.eventType.autoArchivedGhostBug", "Task Auto-Archived (Ghost Bug)"),
    "task:auto-archived-duplicate": t("activityLog.eventType.autoArchivedDuplicate", "Task Auto-Archived (Duplicate)"),
    "task:merge-worktree-reacquired": t("activityLog.eventType.mergeWorktreeReacquired", "Merge Worktree Reacquired"),
    "task:auto-archived-deterministic-duplicate": t("activityLog.eventType.autoArchivedDeterministicDuplicate", "Task Auto-Archived (Deterministic Duplicate)"),
    "task:auto-archived-near-duplicate": t("activityLog.eventType.autoArchivedNearDuplicate", "Task Auto-Archived (Near-Duplicate)"),
    "task:near-duplicate-flagged": t("activityLog.eventType.nearDuplicateFlagged", "Near-Duplicate Flagged"),
    "settings:updated": t("activityLog.eventType.settingsUpdated", "Settings Updated"),
    "project:isolation-transition": t("activityLog.eventType.projectIsolationTransition", "Project Isolation Transition"),
  };
}

const EVENT_TYPE_ICONS: Record<ActivityEventType, React.ReactNode> = {
  "task:created": <Plus size={14} className="activity-icon created" />,
  "task:moved": <ArrowRight size={14} className="activity-icon moved" />,
  "task:updated": <RefreshCw size={14} className="activity-icon updated" />,
  "task:deleted": <X size={14} className="activity-icon deleted" />,
  "task:merged": <CheckCircle size={14} className="activity-icon merged" />,
  "task:failed": <XCircle size={14} className="activity-icon failed" />,
  /*
  FNXC:ReleaseAuthorizationGate 2026-06-15-04:00:
  The release gate parks unauthorized publish-class tasks; activity logs must expose that blocked state with warning styling so a human can authorize or revise the task.
  */
  "task:release-authorization-required": <AlertCircle size={14} className="activity-icon updated" />,
  "task:duplicate-warning-overridden": <AlertCircle size={14} className="activity-icon updated" />,
  "task:auto-archived-ghost-bug": <AlertCircle size={14} className="activity-icon failed" />,
  "task:auto-archived-duplicate": <Trash2 size={14} className="activity-icon deleted" />,
  "task:auto-archived-deterministic-duplicate": <Trash2 size={14} className="activity-icon deleted" />,
  "task:auto-archived-near-duplicate": <Trash2 size={14} className="activity-icon deleted" />,
  "task:near-duplicate-flagged": <AlertCircle size={14} className="activity-icon updated" />,
  "task:merge-worktree-reacquired": <RefreshCw size={14} className="activity-icon updated" />,
  "settings:updated": <Settings size={14} className="activity-icon settings" />,
  "project:isolation-transition": <Folder size={14} className="activity-icon settings" />,
};

function formatTimestamp(timestamp: string, t: TFunction<"app">): string {
  /*
   * FNXC:RelativeTime 2026-06-17-20:48:
   * FN-6618 centralizes ActivityLogModal bucket math without changing its activityLog.time.* keys, uppercase Just now default, future-as-just-now behavior, or Invalid Date fallback.
   */
  const bucket = getRelativeTimeBucket(timestamp);
  if (!bucket) {
    const timestampMs = Date.parse(timestamp);
    if (Number.isFinite(timestampMs) && Date.now() - timestampMs < 0) return t("activityLog.time.justNow", "Just now");
    return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  switch (bucket.bucket) {
    case "just-now":
      return t("activityLog.time.justNow", "Just now");
    case "minutes":
      return t("activityLog.time.minutesAgo", "{{count}}m ago", { count: bucket.count });
    case "hours":
      return t("activityLog.time.hoursAgo", "{{count}}h ago", { count: bucket.count });
    case "days":
      return t("activityLog.time.daysAgo", "{{count}}d ago", { count: bucket.count });
    case "weeks":
    case "older":
      return bucket.date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
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
  presentation = "modal",
}: ActivityLogModalProps) {
  const { isEmbedded, escapeEnabled } = useEmbeddedPresentation(presentation);
  const { t } = useTranslation("app");
  const EVENT_TYPE_LABELS = getEventTypeLabels(t);
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

  // Handle escape key to close.
  // FNXC:RightDockEmbedded 2026-06-22-00:00: Embedded presentation must not auto-close on Escape; the dock owns lifecycle.
  useEffect(() => {
    if (!isOpen || !escapeEnabled) return;
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
  }, [isOpen, escapeEnabled, onClose, showConfirmClear]);

  // Determine if any filter is active
  const isFilterActive = filteredType !== "all" || filteredProjectId !== "all";

  if (!isOpen) return null;

  /*
  FNXC:RightDockEmbedded 2026-06-22-00:00:
  Shared modal body for both presentations. In embedded mode the root is a plain flow container (.activity-log-embedded.right-dock-embedded-view) instead of a position:fixed .modal-overlay, the inner panel gains --embedded sizing, and the modal close "×" is dropped (dock supplies its own header/close). Modal mode stays byte-identical.
  */
  const body = (
      <div
        className={isEmbedded ? "modal modal-lg activity-log-modal activity-log-modal--embedded" : "modal modal-lg activity-log-modal"}
        data-testid="activity-log-modal"
      >
        {/* Header — uses shared modal-header pattern for consistent close control */}
        <div className="modal-header activity-log-header">
          <div className="activity-log-title">
            <History size={18} />
            <span>{t("activityLog.title", "Activity Log")}</span>
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
                  <option value="all">{t("activityLog.allProjects", "All Projects")}</option>
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
                <option value="all">{t("activityLog.allEvents", "All Events")}</option>
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
              title={t("activityLog.refresh", "Refresh")}
              data-testid="activity-refresh"
            >
              {isLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            </button>

            {/* Clear button */}
            {convertedEntries.length > 0 && (
              <button
                className="activity-log-clear"
                onClick={() => setShowConfirmClear(true)}
                title={t("activityLog.clearLog", "Clear Log")}
                data-testid="activity-clear"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
          {/* Close button — uses shared modal-close for consistent sizing and alignment.
              FNXC:RightDockEmbedded 2026-06-22-00:00: Dropped in embedded mode; the dock provides its own close. */}
          {!isEmbedded && (
            <button
              className="modal-close"
              onClick={onClose}
              aria-label={t("actions.close", "Close")}
              title={t("actions.close", "Close")}
              data-testid="activity-close"
            >
              ×
            </button>
          )}
        </div>

        {/* Active filters display */}
        {isFilterActive && (
          <div className="activity-log-active-filters">
            <span className="activity-log-filter-label">{t("activityLog.activeFilters", "Active filters:")}</span>
            {filteredProjectId !== "all" && (
              <span className="activity-log-filter-badge">
                {t("activityLog.projectFilterBadge", "Project: {{project}}", { project: projects.find(p => p.id === filteredProjectId)?.name || filteredProjectId })}
              </span>
            )}
            {filteredType !== "all" && (
              <span className="activity-log-filter-badge">
                {t("activityLog.typeFilterBadge", "Type: {{type}}", { type: EVENT_TYPE_LABELS[filteredType] })}
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
              {t("activityLog.clearFilters", "Clear all")}
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
                  ? t("activityLog.noMatchingActivity", "No activity matches the current filters")
                  : t("activityLog.noActivityRecorded", "No activity recorded yet")}
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
                  {t("activityLog.clearFiltersBtnLabel", "Clear Filters")}
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
                      {formatTimestamp(entry.timestamp, t)}
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
                    <span className="activity-log-entry-text">{linkifyFilePaths(entry.details ?? "")}</span>
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
                          {entry.metadata.merged
                            ? t("activityLog.merged", "Merged")
                            : t("activityLog.notMerged", "Not merged")}
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
              {t("activityLog.loadMore", "Load More")}
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
              <h3>{t("activityLog.confirmClear", "Clear Activity Log?")}</h3>
              <p>{t("activityLog.confirmClearMessage", "This will permanently delete all activity log entries. This action cannot be undone.")}</p>
              <div className="activity-log-confirm-actions">
                <button
                  className="activity-log-confirm-cancel"
                  onClick={() => setShowConfirmClear(false)}
                >
                  {t("actions.cancel", "Cancel")}
                </button>
                <button
                  className="activity-log-confirm-clear"
                  onClick={handleClearLog}
                >
                  {t("activityLog.confirmClearButton", "Clear Log")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
  );

  if (isEmbedded) {
    // FNXC:RightDockEmbedded 2026-06-22-00:00: Plain flow container — no fixed overlay, no backdrop click-to-close. Dock owns the chrome.
    return <div className="activity-log-embedded right-dock-embedded-view">{body}</div>;
  }

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
      {body}
    </div>
  );
}
