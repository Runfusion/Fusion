import { useState, useEffect, useCallback } from "react";
import { FileCode, ChevronDown, ChevronRight, AlertCircle, GitCommit } from "lucide-react";
import type { MergeDetails } from "@fusion/core";
import { fetchCommitDiff } from "../api";
import { highlightDiff } from "../utils/highlightDiff";

interface CommitDiffTabProps {
  commitSha: string;
  mergeDetails?: MergeDetails;
}

export interface ParsedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "unknown";
  additions: number;
  deletions: number;
  patch: string;
}

function getStatusColor(status: ParsedFile["status"]): string {
  switch (status) {
    case "added":
      return "#3fb950";
    case "deleted":
      return "#f85149";
    case "modified":
      return "#58a6ff";
    default:
      return "#8b949e";
  }
}

function getStatusLabel(status: ParsedFile["status"]): string {
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

export function parsePatch(rawPatch: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  // Split on diff boundaries, keeping the delimiter
  const parts = rawPatch.split(/(?=^diff --git )/m);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed.startsWith("diff --git ")) continue;

    // Extract file path from "diff --git a/path b/path"
    const headerMatch = trimmed.match(/^diff --git a\/(.+?) b\/(.+)/m);
    const path = headerMatch ? headerMatch[2] : "unknown";

    // Determine status
    let status: ParsedFile["status"] = "modified";
    if (trimmed.includes("new file mode")) status = "added";
    else if (trimmed.includes("deleted file mode")) status = "deleted";

    // Count additions and deletions from diff lines
    let additions = 0;
    let deletions = 0;
    const lines = trimmed.split("\n");
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    files.push({ path, status, additions, deletions, patch: trimmed });
  }

  return files;
}

/**
 * CommitDiffTab displays the file-by-file diff for a merge commit.
 *
 * It fetches the diff using the commit SHA from `mergeDetails` and renders
 * an expandable file list with syntax-highlighted diff output, similar to
 * the in-progress `TaskChangesTab` but sourced from git history.
 */
export function CommitDiffTab({ commitSha, mergeDetails }: CommitDiffTabProps) {
  const [files, setFiles] = useState<ParsedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const loadDiff = useCallback(async () => {
    if (!commitSha) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const data = await fetchCommitDiff(commitSha);
      const parsed = parsePatch(data.patch || "");
      setFiles(parsed);
      // Auto-expand first file
      if (parsed.length > 0) {
        setExpandedFiles(new Set([parsed[0].path]));
      }
    } catch (err: any) {
      setError(err.message || "Failed to load commit diff");
    } finally {
      setLoading(false);
    }
  }, [commitSha]);

  useEffect(() => {
    loadDiff();
  }, [loadDiff]);

  const toggleFile = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  if (!commitSha) {
    return (
      <div className="detail-section">
        <div className="task-changes-state task-changes-state--empty">
          <GitCommit size={24} />
          <p>No commit SHA available.</p>
          <span className="task-changes-state-hint">
            Commit diff is only available for tasks that were merged.
          </span>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="detail-section">
        <div className="task-changes-state task-changes-state--loading">
          <div className="loading-spinner" />
          <span>Loading commit diff...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="detail-section">
        <div className="task-changes-state task-changes-state--error">
          <AlertCircle size={16} />
          <span>Error loading commit diff: {error}</span>
        </div>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="detail-section">
        <div className="task-changes-state task-changes-state--empty">
          <FileCode size={24} />
          <p>No files changed in this commit.</p>
        </div>
      </div>
    );
  }

  const totalAdditions = mergeDetails?.insertions ?? files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = mergeDetails?.deletions ?? files.reduce((sum, f) => sum + f.deletions, 0);
  const totalFiles = mergeDetails?.filesChanged ?? files.length;

  return (
    <div className="detail-section task-changes-tab">
      {/* Commit metadata */}
      {mergeDetails && (
        <div className="commit-diff-meta">
          <div className="commit-diff-sha">
            <GitCommit size={14} />
            <code>{commitSha.slice(0, 7)}</code>
          </div>
          {mergeDetails.mergeCommitMessage && (
            <div className="commit-diff-message">{mergeDetails.mergeCommitMessage}</div>
          )}
        </div>
      )}

      <div className="changes-header">
        <h4>
          <FileCode size={16} />
          Files Changed ({totalFiles})
          <span className="changes-stat-summary">
            <span className="diff-add">+{totalAdditions}</span>{" "}
            <span className="diff-del">-{totalDeletions}</span>
          </span>
        </h4>
        <button className="btn btn-sm" onClick={loadDiff} disabled={loading}>
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
                  className="changes-file-status"
                  style={{ color: getStatusColor(file.status) }}
                  title={file.status}
                >
                  {getStatusLabel(file.status)}
                </span>
                <span className="changes-file-path" title={file.path}>
                  {file.path}
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
