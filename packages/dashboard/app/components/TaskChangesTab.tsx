import { useState, useEffect, useCallback } from "react";
import { FileCode, ChevronDown, ChevronRight, AlertCircle, GitCommit } from "lucide-react";
import type { MergeDetails, Column } from "@fusion/core";
import { fetchTaskDiff, type TaskDiff } from "../api";
import { highlightDiff } from "../utils/highlightDiff";
import { truncateMiddle } from "../utils/truncatePath";

interface TaskChangesTabProps {
  taskId: string;
  worktree?: string;
  projectId?: string;
  column?: Column;
  mergeDetails?: MergeDetails;
}

function getStatusLabel(status: "added" | "modified" | "deleted" | "unknown"): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "modified":
      return "M";
    default:
      return "?";
  }
}

/** Normalized file entry used by both worktree-backed and commit-backed paths */
interface NormalizedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "unknown";
  additions: number;
  deletions: number;
  patch: string;
}

/**
 * TaskChangesTab displays file-level diffs for a task.
 *
 * For in-progress/in-review tasks it loads the diff from the live worktree.
 * For done tasks with a recorded merge commit (mergeDetails.commitSha) it loads
 * the diff from git history instead, so changes remain visible even after the
 * worktree is cleaned up.
 */
export function TaskChangesTab({ taskId, worktree, projectId, column, mergeDetails }: TaskChangesTabProps) {
  const [files, setFiles] = useState<NormalizedFile[]>([]);
  const [stats, setStats] = useState<{ filesChanged: number; additions: number; deletions: number }>({ filesChanged: 0, additions: 0, deletions: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const canLoad = column === "in-progress" || column === "in-review" || column === "done";

  const loadDiff = useCallback(async () => {
    if (!canLoad) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const data: TaskDiff = await fetchTaskDiff(taskId, undefined, projectId);
      const normalized: NormalizedFile[] = data.files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      }));
      setFiles(normalized);
      setStats(data.stats);
      if (normalized.length > 0) {
        setExpandedFiles(new Set([normalized[0].path]));
      }
    } catch (err: any) {
      setError(err.message || "Failed to load diff");
    } finally {
      setLoading(false);
    }
  }, [taskId, projectId, canLoad]);

  useEffect(() => {
    loadDiff();
  }, [loadDiff]);

  const toggleFile = (filePath: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <div className="detail-section">
        <div className="task-changes-state task-changes-state--loading">
          <div className="loading-spinner" />
          <span>Loading changes...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="detail-section">
        <div className="task-changes-state task-changes-state--error">
          <AlertCircle size={16} />
          <span>Error loading changes: {error}</span>
        </div>
      </div>
    );
  }

  const isDone = column === "done";

  // Non-done task without a worktree → show worktree empty state
  if (!isDone && !worktree) {
    return (
      <div className="detail-section">
        <div className="task-changes-state task-changes-state--empty">
          <FileCode size={24} />
          <p>No worktree available for this task.</p>
          <span className="task-changes-state-hint">
            Changes will be shown once the task is in progress.
          </span>
        </div>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="detail-section">
        <div className="task-changes-state task-changes-state--empty">
          <FileCode size={24} />
          <p>No files modified.</p>
          <span className="task-changes-state-hint">
            {isDone
              ? "No file changes were recorded in the merge commit."
              : "The agent did not modify any files during execution."}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="detail-section task-changes-tab">
      {/* Commit metadata for done tasks */}
      {isDone && mergeDetails && (
        <div className="commit-diff-meta">
          {mergeDetails.commitSha && (
            <div className="commit-diff-sha">
              <GitCommit size={14} />
              <code>{mergeDetails.commitSha.slice(0, 7)}</code>
            </div>
          )}
          {mergeDetails.mergeCommitMessage && (
            <div className="commit-diff-message">{mergeDetails.mergeCommitMessage}</div>
          )}
          {mergeDetails.mergedAt && (
            <div className="commit-diff-timestamp">
              Merged {new Date(mergeDetails.mergedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      <div className="changes-header">
        <h4>
          <FileCode size={16} />
          Files Changed ({stats.filesChanged})
          <span className="changes-stat-summary">
            <span className="diff-add">+{stats.additions}</span>{" "}
            <span className="diff-del">-{stats.deletions}</span>
          </span>
        </h4>
        <button
          className="btn btn-sm"
          onClick={loadDiff}
          disabled={loading}
        >
          Refresh
        </button>
      </div>

      <div className="changes-file-list">
        {files.map((file) => {
          const isExpanded = expandedFiles.has(file.path);

          return (
            <div
              key={file.path}
              className={`changes-file-item ${isExpanded ? "expanded" : ""}`}
            >
              <button
                className="changes-file-header"
                onClick={() => toggleFile(file.path)}
              >
                <span className="changes-file-toggle">
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
                <span
                  className={`changes-file-status changes-file-status--${file.status}`}
                  title={file.status}
                >
                  {getStatusLabel(file.status)}
                </span>
                <span className="changes-file-path" title={file.path}>
                  {truncateMiddle(file.path)}
                </span>
                <span
                  className="changes-file-stat"
                  title={`+${file.additions} -${file.deletions}`}
                >
                  +{file.additions} -{file.deletions}
                </span>
              </button>

              {isExpanded && file.patch && (
                <div className="changes-file-content">
                  <pre className="changes-diff-patch">
                    <code>{highlightDiff(file.patch)}</code>
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
