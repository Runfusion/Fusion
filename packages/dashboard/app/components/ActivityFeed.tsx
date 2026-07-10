import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import "./ActivityFeed.css";
import {
  GitMerge,
  CheckCircle, 
  XCircle, 
  Plus, 
  ArrowRightLeft, 
  Settings,
  AlertTriangle,
  Folder,
  Trash2,
} from "lucide-react";
import type { ActivityFeedEntry } from "../api";
import { getRelativeTimeBucket } from "../utils/relativeTimeAgo";

export interface ActivityFeedProps {
  entries: ActivityFeedEntry[];
  isLoading?: boolean;
  error?: string | null;
  projectNames?: Record<string, string>;
  emptyMessage?: string;
}

const TYPE_CONFIG: Record<ActivityFeedEntry["type"], { 
  label: string; 
  icon: typeof Plus; 
  color: string;
}> = {
  "task:created": { label: "Created", icon: Plus, color: "var(--todo)" },
  "task:moved": { label: "Moved", icon: ArrowRightLeft, color: "var(--in-progress)" },
  "task:updated": { label: "Updated", icon: Settings, color: "var(--text-muted)" },
  "task:merge-worktree-reacquired": { label: "Merge Worktree Reacquired", icon: Settings, color: "var(--color-info)" },
  "task:deleted": { label: "Deleted", icon: XCircle, color: "var(--color-error)" },
  "task:merged": { label: "Merged", icon: GitMerge, color: "var(--color-success)" },
  "task:failed": { label: "Failed", icon: AlertTriangle, color: "var(--color-error)" },
  "task:duplicate-warning-overridden": { label: "Duplicate Override", icon: AlertTriangle, color: "var(--color-warning)" },
  "task:auto-archived-ghost-bug": { label: "Auto-Archived (Ghost Bug)", icon: AlertTriangle, color: "var(--color-warning)" },
  "task:auto-archived-duplicate": { label: "Auto-Archived (Duplicate)", icon: Trash2, color: "var(--text-muted)" },
  "task:auto-archived-deterministic-duplicate": { label: "Auto-Archived (Deterministic Duplicate)", icon: Trash2, color: "var(--text-muted)" },
  "task:auto-archived-near-duplicate": { label: "Auto-Archived (Near-Duplicate)", icon: Trash2, color: "var(--text-muted)" },
  "task:near-duplicate-flagged": { label: "Near-Duplicate Flagged", icon: AlertTriangle, color: "var(--color-warning)" },
  "settings:updated": { label: "Settings", icon: Settings, color: "var(--text-muted)" },
  "project:isolation-transition": { label: "Isolation", icon: Folder, color: "var(--color-info)" },
};

/*
FNXC:ActivityFeedTimestamps 2026-06-17-17:27:
FN-6601 routes ActivityFeed through the shared relative-time bucket helper while preserving this surface's capitalized "Just now" label and locale-date fallback.
*/
function formatRelativeTime(timestamp: string): string {
  const bucket = getRelativeTimeBucket(timestamp);
  if (!bucket) {
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime()) ? "Just now" : date.toLocaleDateString();
  }

  switch (bucket.bucket) {
    case "just-now":
      return "Just now";
    case "minutes":
      return `${bucket.count}m ago`;
    case "hours":
      return `${bucket.count}h ago`;
    case "days":
      return `${bucket.count}d ago`;
    case "weeks":
    case "older":
      return bucket.date.toLocaleDateString();
  }
}

function formatFullTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

interface ActivityFeedItemProps {
  entry: ActivityFeedEntry;
  projectName?: string;
}

function ActivityFeedItem({ entry, projectName }: ActivityFeedItemProps) {
  const config = TYPE_CONFIG[entry.type];
  const Icon = config.icon;

  return (
    <div className="activity-feed-item" data-type={entry.type}>
      <div className="activity-feed-icon" style={{ color: config.color }}>
        <Icon size={16} />
      </div>
      <div className="activity-feed-content">
        <div className="activity-feed-header">
          <span className="activity-feed-type">{config.label}</span>
          {projectName && (
            <span className="activity-feed-project-badge">
              <Folder size={10} />
              {projectName}
            </span>
          )}
        </div>
        <div className="activity-feed-details">
          {entry.taskId && (
            <span className="activity-feed-task-id">{entry.taskId}</span>
          )}
          {entry.taskTitle && (
            <span className="activity-feed-task-title" title={entry.taskTitle}>
              {entry.taskTitle}
            </span>
          )}
          <span className="activity-feed-description">{entry.details}</span>
        </div>
        <div className="activity-feed-meta">
          <span className="activity-feed-time" title={formatFullTime(entry.timestamp)}>
            {formatRelativeTime(entry.timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
}

function areActivityFeedPropsEqual(previous: ActivityFeedProps, next: ActivityFeedProps): boolean {
  if (previous.isLoading !== next.isLoading) return false;
  if (previous.error !== next.error) return false;
  if (previous.entries.length !== next.entries.length) return false;
  
  for (let i = 0; i < previous.entries.length; i++) {
    const prev = previous.entries[i];
    const curr = next.entries[i];
    if (prev.id !== curr.id) return false;
    if (prev.timestamp !== curr.timestamp) return false;
    if (prev.type !== curr.type) return false;
    if (prev.details !== curr.details) return false;
    if (prev.taskId !== curr.taskId) return false;
    if (prev.taskTitle !== curr.taskTitle) return false;
  }
  
  return true;
}

function ActivityFeedInner({
  entries,
  isLoading = false,
  error = null,
  projectNames = {},
  emptyMessage,
}: ActivityFeedProps) {
  const { t } = useTranslation("app");
  const resolvedEmptyMessage = emptyMessage ?? t("activityFeed.noRecentActivity", "No recent activity");

  const getProjectName = useCallback((projectId: string): string => {
    return projectNames[projectId] || projectId;
  }, [projectNames]);

  const groupedEntries = useMemo(() => {
    const groups: { date: string; entries: ActivityFeedEntry[] }[] = [];
    let currentGroup: { date: string; entries: ActivityFeedEntry[] } | null = null;

    for (const entry of entries) {
      const date = new Date(entry.timestamp).toLocaleDateString();
      
      if (!currentGroup || currentGroup.date !== date) {
        currentGroup = { date, entries: [] };
        groups.push(currentGroup);
      }
      currentGroup.entries.push(entry);
    }

    return groups;
  }, [entries]);

  if (isLoading) {
    return (
      <div className="activity-feed activity-feed-loading">
        <div className="activity-feed-skeleton">
          {[1, 2, 3].map((i) => (
            <div key={i} className="activity-feed-skeleton-item">
              <div className="activity-feed-skeleton-icon" />
              <div className="activity-feed-skeleton-content">
                <div className="activity-feed-skeleton-line" />
                <div className="activity-feed-skeleton-line short" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="activity-feed activity-feed-error">
        <div className="activity-feed-error-message">
          <AlertTriangle size={24} />
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="activity-feed activity-feed-empty">
        <div className="activity-feed-empty-state">
          <CheckCircle size={32} />
          <p>{resolvedEmptyMessage}</p>
          <span className="activity-feed-empty-hint">
            {t("activityFeed.emptyHint", "Activity will appear here when tasks are created, moved, or completed")}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="activity-feed">
      {groupedEntries.map((group) => (
        <div key={group.date} className="activity-feed-group">
          <div className="activity-feed-group-header">
            <span className="activity-feed-group-date">{group.date}</span>
            <span className="activity-feed-group-count">
              {t("activityFeed.eventCount", { count: group.entries.length, defaultValue_one: "{{count}} event", defaultValue_other: "{{count}} events" })}
            </span>
          </div>
          <div className="activity-feed-list">
            {group.entries.map((entry) => (
              <ActivityFeedItem
                key={entry.id}
                entry={entry}
                projectName={getProjectName(entry.projectId)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export const ActivityFeed = memo(ActivityFeedInner, areActivityFeedPropsEqual);
