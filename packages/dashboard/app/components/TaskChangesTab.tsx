import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FileCode, ChevronDown, ChevronRight, ChevronLeft, AlertCircle, GitCommit, WrapText, Maximize2 } from "lucide-react";
import type { MergeDetails, ColumnId } from "@fusion/core";
import { LoadingSpinner } from "./LoadingSpinner";
import { getErrorMessage } from "@fusion/core";
import {
  fetchTaskDiff,
  type TaskDiff,
} from "../api";
import { highlightDiff } from "../utils/highlightDiff";
import { ChangesDiffModal } from "./ChangesDiffModal";
import "./TaskDiffShared.css";
import "./TaskChangesTab.css";

interface TaskChangesTabProps {
  taskId: string;
  worktree?: string;
  projectId?: string;
  column?: ColumnId;
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
   * - Fallback views keep a consistent `N file(s) changed` headline.
   * - Provenance is disclosed in `task-changes-state-hint` text.
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
  fileList: string[],
  isDone: boolean,
  mergeDetails?: MergeDetails,
  source: "landed" | "execution" = "execution",
  t?: ReturnType<typeof useTranslation>["t"],
) {
  const getT = (key: string, defaultValue: string, options?: Record<string, unknown>) =>
    t ? t(key, defaultValue, options) : defaultValue;
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
              {getT("taskChanges.merged", "Merged {{date}}", { date: new Date(mergeDetails.mergedAt).toLocaleString() })}
            </div>
          )}
        </div>
      )}
      <div className="task-changes-state task-changes-state--empty">
        <FileCode size={24} />
        <p>{getT(`taskChanges.fileCount`, "{{count}} file{{plural}} changed.", { count: fileList.length, plural: fileList.length === 1 ? "" : "s" })}</p>
        <span className="task-changes-state-hint">
          {isDone
            // FN-4647: done-task fallback must explicitly describe executor-captured scope.
            ? source === "landed"
              ? getT("taskChanges.landedFilesHint", "These are files captured from the merged commit metadata. The lineage-backed diff is unavailable for this task.")
              : getT("taskChanges.executionFilesHint", "These are files captured from the worktree during execution. They may differ from the files that actually landed on main. The lineage-backed diff is unavailable for this task.")
            : getT("taskChanges.emptyWorktreeHint", "The live worktree diff is empty. Showing the last file paths captured during execution — patches unavailable.")}
        </span>
      </div>
      <div className="changes-file-list task-changes-file-list--compact">
        {fileList.map((path) => (
          <div key={path} className="changes-file-item">
            <div className="changes-file-header changes-file-header--static">
              <span
                className="changes-file-status changes-file-status--unknown"
                title={getT("taskChanges.statusUnknown", "status unknown")}
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
  const { t } = useTranslation("app");
  const [files, setFiles] = useState<NormalizedFile[]>([]);
  const [stats, setStats] = useState<{ filesChanged: number; additions: number; deletions: number }>({ filesChanged: 0, additions: 0, deletions: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
        setError(getErrorMessage(err) || t("taskChanges.loadError", "Failed to load task changes"));
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

  const renderChangesHeader = () => (
    <div className="changes-header">
      <div className="task-changes-header-title">
        <h4>
          <FileCode size={16} />
          {t("taskChanges.filesChangedHeading", "Files Changed ({{count}})", { count: stats.filesChanged })}
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
                title={t("taskChanges.previousFile", "Previous file")}
                aria-label={t("taskChanges.previousFile", "Previous file")}
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
                title={t("taskChanges.nextFile", "Next file")}
                aria-label={t("taskChanges.nextFile", "Next file")}
              >
                <ChevronRight />
              </button>
            </div>
          )}
          <button
            className={`btn btn-sm ${wordWrap ? "btn-primary" : ""}`}
            onClick={() => setWordWrap((prev) => !prev)}
            title={t(`taskChanges.${wordWrap ? "disableWordWrap" : "enableWordWrap"}`, wordWrap ? "Disable word wrap" : "Enable word wrap")}
            aria-label={t("taskChanges.toggleWordWrap", "Toggle word wrap")}
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
            {t("common.refresh", "Refresh")}
          </button>
          <button
            className="btn btn-sm btn-icon"
            onClick={() => setExpandedViewOpen(true)}
            title={t("taskChanges.expandDiff", "Expand to full-screen diff view")}
            aria-label={t("taskChanges.expandDiffView", "Expand diff view")}
          >
            <Maximize2 />
          </button>
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="detail-section">
        <div className="task-changes-state task-changes-state--loading">
          <LoadingSpinner label={t("taskChanges.loading", "Loading changes...")} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="detail-section">
        <div className="task-changes-state task-changes-state--error">
          <AlertCircle size={16} />
          <span>{t("taskChanges.error", "Error loading changes: {{error}}", { error })}</span>
        </div>
      </div>
    );
  }

  // Non-done task without a worktree → only show fallback state when branch-fallback diff is empty.
  if (!isDone && !worktree && files.length === 0) {
    if (modifiedFiles && modifiedFiles.length > 0) {
      return renderModifiedFilesFallback(modifiedFiles, false, undefined, "execution", t);
    }

    return (
      <div className="detail-section">
        <div className="task-changes-state task-changes-state--empty">
          <FileCode size={24} />
          <p>{t("taskChanges.noWorktree", "No worktree available for this task.")}</p>
          <span className="task-changes-state-hint">
            {t("taskChanges.noWorktreeHint", "Changes will be shown once the task is in progress.")}
          </span>
        </div>
      </div>
    );
  }


  if (files.length === 0) {
    if (isDone && !isDoneWithCommit) {
      const doneFallbackFiles = mergeDetails?.landedFiles && mergeDetails.landedFiles.length > 0
        ? mergeDetails.landedFiles
        : modifiedFiles;
      if (doneFallbackFiles && doneFallbackFiles.length > 0) {
        return renderModifiedFilesFallback(doneFallbackFiles, true, mergeDetails, mergeDetails?.landedFiles?.length ? "landed" : "execution", t);
      }

      const summaryFiles = mergeDetails?.filesChanged;
      const summaryAdditions = mergeDetails?.insertions;
      const summaryDeletions = mergeDetails?.deletions;
      const hasSummary = summaryFiles != null || summaryAdditions != null || summaryDeletions != null;

      return (
        <div className="detail-section">
          <div className="task-changes-state task-changes-state--empty">
            <FileCode size={24} />
            <p>{t("taskChanges.unavailable", "Detailed file changes unavailable.")}</p>
            <span className="task-changes-state-hint">
              {hasSummary
                ? t("taskChanges.summaryHint", "Final commit summary: {{files}} file{{plural}} changed, +{{additions}} additions, -{{deletions}} deletions. Counts only the recorded merge/squash commit, not the full task lineage.", { files: summaryFiles ?? 0, plural: (summaryFiles ?? 0) === 1 ? "" : "s", additions: summaryAdditions ?? 0, deletions: summaryDeletions ?? 0 })
                : t("taskChanges.noMergeCommit", "No merge commit was recorded for this task.")}
            </span>
          </div>
        </div>
      );
    }

    if (!isDone && modifiedFiles && modifiedFiles.length > 0) {
      return renderModifiedFilesFallback(modifiedFiles, isDone, mergeDetails, "execution", t);
    }

    return (
      <div className="detail-section task-changes-tab">
        {renderChangesHeader()}
        <div className="task-changes-state task-changes-state--empty">
          <FileCode size={24} />
          <p>{t("taskChanges.noFilesModified", "No files modified.")}</p>
          <span className="task-changes-state-hint">
            {isDone
              ? t("taskChanges.noMergeFileChanges", "No file changes were recorded in the merge commit.")
              : t("taskChanges.noExecutionModifications", "The agent did not modify any files during execution.")}
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
              {t("taskChanges.mergedAt", "Merged {{date}}", { date: new Date(mergeDetails.mergedAt).toLocaleString() })}
            </div>
          )}
          {mergeDetails.noOpVerifiedShortCircuit && (
            <div className="text-muted">{t("taskChanges.noOpShortCircuit", "Verified short-circuit — work was already on main (rebase walked foreign commits).")}</div>
          )}
          {mergeDetails.landedFilesCaptureFallback === "attribution-failed" && (
            <div className="text-muted">{t("taskChanges.attributionFailed", "Landed-files set may include foreign commits (attribution unavailable).")}</div>
          )}
        </div>
      )}

      {renderChangesHeader()}

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
