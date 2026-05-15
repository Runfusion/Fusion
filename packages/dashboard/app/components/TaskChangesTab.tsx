import { useState, useEffect, useCallback } from "react";
import { FileCode, ChevronDown, ChevronRight, ChevronLeft, AlertCircle, GitCommit, WrapText, Maximize2 } from "lucide-react";
import type { MergeDetails, Column } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import {
  fetchTaskDiff,
  fetchTaskCommitAssociations,
  type TaskDiff,
  type TaskCommitAssociationRow,
} from "../api";
import { highlightDiff } from "../utils/highlightDiff";
import { ChangesDiffModal } from "./ChangesDiffModal";
import "./TaskDiffShared.css";
import "./TaskChangesTab.css";

interface TaskChangesTabProps {
  taskId: string;
  worktree?: string;
  projectId?: string;
  column?: Column;
  mergeDetails?: MergeDetails;
  /**
   * Files modified by the task during execution, captured from the worktree.
   * Used as a last-resort fallback when the live worktree diff is empty or the
   * recorded `mergeDetails.commitSha` resolves to an empty git commit (which
   * can happen when the merger stores a per-branch SHA that gets collapsed
   * into a different squash on main).
   *
   * Done-task sources of truth:
   * - Authoritative landed diff: `/api/tasks/:id/diff` lineage union.
   * - Fallback labels: `Final commit summary` (`mergeDetails`) or
   *   `files touched during execution` (`modifiedFiles`).
   * - Never present fallback values as bare landed `files changed`.
   */
  modifiedFiles?: string[];
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

function renderModifiedFilesFallback(
  modifiedFiles: string[],
  isDone: boolean,
  mergeDetails?: MergeDetails,
) {
  return (
    <div className="detail-section task-changes-tab">
      {isDone && mergeDetails && (
        <div className="commit-diff-meta">
          {mergeDetails.commitSha && (
            <div className="commit-diff-sha">
              <GitCommit size={14} />
              <code>{mergeDetails.commitSha.slice(0, 7)}</code>
            </div>
          )}
          {mergeDetails.mergedAt && (
            <div className="commit-diff-timestamp">
              Merged {new Date(mergeDetails.mergedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}
      <div className="task-changes-state task-changes-state--empty">
        <FileCode size={24} />
        <p>{modifiedFiles.length} file{modifiedFiles.length === 1 ? "" : "s"} modified during execution.</p>
        <span className="task-changes-state-hint">
          {isDone
            // FN-4647: done-task fallback must explicitly describe executor-captured scope.
            ? "These are files captured from the worktree during execution. They may differ from the files that actually landed on main. The lineage-backed diff is unavailable for this task."
            : "The live worktree diff is empty. Showing the last file paths captured during execution — patches unavailable."}
        </span>
      </div>
      <div className="changes-file-list task-changes-file-list--compact">
        {modifiedFiles.map((path) => (
          <div key={path} className="changes-file-item">
            <div className="changes-file-header changes-file-header--static">
              <span
                className="changes-file-status changes-file-status--unknown"
                title="status unknown"
              >
                {getStatusLabel("unknown")}
              </span>
              <span className="changes-file-path" title={path}>
                <bdo dir="ltr">{path}</bdo>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
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
 * For done tasks it always attempts `/api/tasks/:id/diff` (lineage-backed when
 * needed) so the detailed view stays aligned with TaskCard/useTaskDiffStats.
 *
 * When a done task has no recorded merge commit SHA and the server returns no
 * diff rows (or diff loading fails), the tab falls back to the safe summary/
 * modifiedFiles view instead of showing a hard error. This preserves the prior
 * graceful behavior while allowing FN-4563/FN-4576 lineage-backed parity.
 */
export function TaskChangesTab({ taskId, worktree, projectId, column, mergeDetails, modifiedFiles }: TaskChangesTabProps) {
  const [files, setFiles] = useState<NormalizedFile[]>([]);
  const [stats, setStats] = useState<{ filesChanged: number; additions: number; deletions: number }>({ filesChanged: 0, additions: 0, deletions: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commitAssociations, setCommitAssociations] = useState<TaskCommitAssociationRow[]>([]);
  const [lineageId, setLineageId] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [currentFileIndex, setCurrentFileIndex] = useState<number | null>(null);
  const [wordWrap, setWordWrap] = useState(true);
  const [expandedViewOpen, setExpandedViewOpen] = useState(false);

  const isDone = column === "done";
  const isDoneWithCommit = isDone && Boolean(mergeDetails?.commitSha);

  const canLoad = column === "in-progress" || column === "in-review" || isDone;

  const loadDiff = useCallback(async () => {
    if (!canLoad && !isDone) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const associationsData = await fetchTaskCommitAssociations(taskId, projectId);
      setLineageId(associationsData.lineageId);
      setCommitAssociations(associationsData.associations);

      if (!canLoad) {
        setFiles([]);
        setStats({ filesChanged: 0, additions: 0, deletions: 0 });
        return;
      }

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
        setCurrentFileIndex(0);
      }
    } catch (err) {
      if (isDone && !mergeDetails?.commitSha) {
        setFiles([]);
        setStats({ filesChanged: 0, additions: 0, deletions: 0 });
        setError(null);
      } else {
        setError(getErrorMessage(err) || "Failed to load task changes");
      }
    } finally {
      setLoading(false);
    }
  }, [taskId, projectId, canLoad, isDone, mergeDetails?.commitSha]);

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
        // Update currentFileIndex to the newly expanded file
        const idx = files.findIndex((f) => f.path === filePath);
        if (idx !== -1) {
          setCurrentFileIndex(idx);
        }
      }
      return next;
    });
  };

  const navigateToFile = (index: number) => {
    if (index < 0 || index >= files.length) return;
    const targetPath = files[index].path;
    // Collapse all files and expand only the target
    setExpandedFiles(new Set([targetPath]));
    setCurrentFileIndex(index);
  };

  const canGoPrev = currentFileIndex !== null && currentFileIndex > 0;
  const canGoNext = currentFileIndex !== null && currentFileIndex < files.length - 1;

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

  // Non-done task without a worktree → only show fallback state when branch-fallback diff is empty.
  if (!isDone && !worktree && files.length === 0) {
    if (modifiedFiles && modifiedFiles.length > 0) {
      return renderModifiedFilesFallback(modifiedFiles, false);
    }

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


  const renderCommitAssociations = () => (
    <section className="task-lineage-associations" aria-label="Task commit associations">
      <div className="task-lineage-associations-header">
        <h4>
          <GitCommit size={16} />
          Lineage commit associations
        </h4>
        {lineageId && (
          <code className="task-lineage-id">{lineageId}</code>
        )}
      </div>
      {commitAssociations.length === 0 ? (
        <p className="task-lineage-associations-empty">No associated commits recorded yet.</p>
      ) : (
        <div className="task-lineage-associations-list">
          {commitAssociations.map((association) => {
            const matchedLabel = association.matchedBy.replace(/-/g, " ");
            return (
              <article
                key={`${association.commitSha}-${association.matchedBy}`}
                className={`task-lineage-association task-lineage-association--${association.confidence}`}
              >
                <div className="task-lineage-association-main">
                  <code className="task-lineage-sha">{association.commitSha.slice(0, 7)}</code>
                  <span className="task-lineage-subject">{association.commitSubject}</span>
                </div>
                <div className="task-lineage-association-meta">
                  <span>{new Date(association.authoredAt).toLocaleString()}</span>
                  <span>Confidence: {association.confidence}</span>
                  <span>Match: {matchedLabel}</span>
                  <span>Task snapshot: {association.taskIdSnapshot}</span>
                </div>
                {association.note && <p className="task-lineage-note">{association.note}</p>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );

  if (files.length === 0) {
    if (isDone && !isDoneWithCommit) {
      if (modifiedFiles && modifiedFiles.length > 0) {
        return renderModifiedFilesFallback(modifiedFiles, true, mergeDetails);
      }

      const summaryFiles = mergeDetails?.filesChanged;
      const summaryAdditions = mergeDetails?.insertions;
      const summaryDeletions = mergeDetails?.deletions;
      const hasSummary = summaryFiles != null || summaryAdditions != null || summaryDeletions != null;

      return (
        <div className="detail-section">
          <div className="task-changes-state task-changes-state--empty">
            <FileCode size={24} />
            <p>Detailed file changes unavailable.</p>
            <span className="task-changes-state-hint">
              {hasSummary
                ? `Final commit summary: ${summaryFiles ?? 0} file${(summaryFiles ?? 0) === 1 ? "" : "s"} changed, +${summaryAdditions ?? 0} additions, -${summaryDeletions ?? 0} deletions. Counts only the recorded merge/squash commit, not the full task lineage.`
                : "No merge commit was recorded for this task."}
            </span>
          </div>
        </div>
      );
    }

    if (modifiedFiles && modifiedFiles.length > 0) {
      return renderModifiedFilesFallback(modifiedFiles, isDone, mergeDetails);
    }

    return (
      <div className="detail-section task-changes-tab">
        {renderCommitAssociations()}
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
      {renderCommitAssociations()}
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
        <div className="task-changes-header-title">
          <h4>
            <FileCode size={16} />
            Files Changed ({stats.filesChanged})
          </h4>
          <span className="task-changes-stats changes-stat-summary">
            <span className="diff-add">+{stats.additions}</span>{" "}
            <span className="diff-del">-{stats.deletions}</span>
          </span>
        </div>
        <div className="changes-header-actions-wrapper">
          <div className="changes-header-actions">
            {files.length > 0 && (
              <div className="changes-nav">
                <button
                  className="btn btn-sm btn-icon"
                  onClick={() => canGoPrev && navigateToFile(currentFileIndex! - 1)}
                  disabled={!canGoPrev}
                  title="Previous file"
                  aria-label="Previous file"
                >
                  <ChevronLeft />
                </button>
                <span className="changes-nav-indicator" aria-live="polite">
                  {currentFileIndex !== null ? `${currentFileIndex + 1}/${files.length}` : `—/${files.length}`}
                </span>
                <button
                  className="btn btn-sm btn-icon"
                  onClick={() => canGoNext && navigateToFile(currentFileIndex! + 1)}
                  disabled={!canGoNext}
                  title="Next file"
                  aria-label="Next file"
                >
                  <ChevronRight />
                </button>
              </div>
            )}
            <button
              className={`btn btn-sm ${wordWrap ? "btn-primary" : ""}`}
              onClick={() => setWordWrap((prev) => !prev)}
              title={wordWrap ? "Disable word wrap" : "Enable word wrap"}
              aria-label="Toggle word wrap"
            >
              <WrapText size={14} />
            </button>
          </div>
          <div className="changes-header-actions-secondary">
            <button
              className="btn btn-sm"
              onClick={loadDiff}
              disabled={loading}
            >
              Refresh
            </button>
            <button
              className="btn btn-sm btn-icon"
              onClick={() => setExpandedViewOpen(true)}
              title="Expand to full-screen diff view"
              aria-label="Expand diff view"
            >
              <Maximize2 />
            </button>
          </div>
        </div>
      </div>

      <div className="changes-file-list task-changes-file-list--compact">
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
                  <bdo dir="ltr">{file.path}</bdo>
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
                  <pre className={`changes-diff-patch ${wordWrap ? "changes-diff-patch--wrap" : "changes-diff-patch--nowrap"}`}>
                    <code>{highlightDiff(file.patch)}</code>
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ChangesDiffModal
        isOpen={expandedViewOpen}
        taskId={taskId}
        files={files}
        stats={stats}
        mergeDetails={mergeDetails}
        column={column}
        onClose={() => setExpandedViewOpen(false)}
        onRefresh={loadDiff}
      />
    </div>
  );
}
