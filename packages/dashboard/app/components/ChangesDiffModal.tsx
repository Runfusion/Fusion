import { useState, useEffect, useCallback, useRef } from "react";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import {
  X,
  FileCode,
  ChevronLeft,
  ChevronRight,
  WrapText,
  RefreshCw,
  GitCommit,
} from "lucide-react";
import type { MergeDetails, Column } from "@fusion/core";
import { highlightDiff } from "../utils/highlightDiff";
import { truncateMiddle } from "../utils/truncatePath";
import "./TaskDiffShared.css";
import "./ChangesDiffModal.css";

/** Normalized file entry — re-exported from TaskChangesTab for shared use */
export interface NormalizedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "unknown";
  additions: number;
  deletions: number;
  patch: string;
}

interface ChangesDiffModalProps {
  isOpen: boolean;
  taskId: string;
  files: NormalizedFile[];
  stats: { filesChanged: number; additions: number; deletions: number };
  mergeDetails?: MergeDetails;
  column?: Column;
  onClose: () => void;
  onRefresh?: () => void;
}

function getStatusLabel(
  status: "added" | "modified" | "deleted" | "unknown"
): string {
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

/**
 * ChangesDiffModal is a two-panel file browser + diff viewer modal.
 *
 * The left panel lists changed files with status badges (A/M/D) and +/- stats.
 * The right panel displays the syntax-highlighted diff for the selected file.
 */
export function ChangesDiffModal({
  isOpen,
  taskId,
  files,
  stats,
  mergeDetails,
  column,
  onClose,
  onRefresh,
}: ChangesDiffModalProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [wordWrap, setWordWrap] = useState(true);
  const modalRef = useRef<HTMLDivElement>(null);
  useModalResizePersist(modalRef, isOpen, "fusion:changes-diff-modal-size");
  const overlayDismissProps = useOverlayDismiss(onClose);

  // Auto-select first file when files change
  useEffect(() => {
    if (files.length > 0 && selectedIndex === null) {
      setSelectedIndex(0);
    }
  }, [files, selectedIndex]);

  const navigatePrev = useCallback(() => {
    setSelectedIndex((prev) => (prev !== null && prev > 0 ? prev - 1 : prev));
  }, []);

  const navigateNext = useCallback(() => {
    setSelectedIndex((prev) =>
      prev !== null && prev < files.length - 1 ? prev + 1 : prev
    );
  }, []);

  // Keyboard handler
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowUp" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        navigatePrev();
      }
      if (e.key === "ArrowDown" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        navigateNext();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, navigatePrev, navigateNext]);

  if (!isOpen) return null;

  const selectedFile =
    selectedIndex !== null ? files[selectedIndex] : null;
  const isDone = column === "done";

  return (
    <div className="modal-overlay open" {...overlayDismissProps} role="dialog" aria-modal="true">
      <div
        className="modal changes-diff-modal"
        ref={modalRef}
      >
        {/* Header */}
        <div className="modal-header changes-diff-modal-header">
          <div className="changes-diff-header-title">
            <FileCode size={18} />
            <span>Changes — {taskId}</span>
            <span className="changes-stat-summary">
              <span className="diff-add">+{stats.additions}</span>{" "}
              <span className="diff-del">-{stats.deletions}</span>
            </span>
          </div>
          <div className="changes-diff-header-actions">
            {files.length > 0 && (
              <div className="changes-nav">
                <button
                  className="btn btn-sm btn-icon"
                  onClick={navigatePrev}
                  disabled={selectedIndex === null || selectedIndex <= 0}
                  title="Previous file (Ctrl+↑)"
                  aria-label="Previous file"
                >
                  <ChevronLeft size={14} />
                </button>
                <span className="changes-nav-indicator" aria-live="polite">
                  {selectedIndex !== null
                    ? `${selectedIndex + 1}/${files.length}`
                    : `—/${files.length}`}
                </span>
                <button
                  className="btn btn-sm btn-icon"
                  onClick={navigateNext}
                  disabled={
                    selectedIndex === null || selectedIndex >= files.length - 1
                  }
                  title="Next file (Ctrl+↓)"
                  aria-label="Next file"
                >
                  <ChevronRight size={14} />
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
            {onRefresh && (
              <button className="btn btn-sm" onClick={onRefresh}>
                <RefreshCw size={14} />
                Refresh
              </button>
            )}
            <button className="modal-close" onClick={onClose} aria-label="Close">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="changes-diff-body">
          {/* Left panel — file list */}
          <div className="changes-diff-sidebar">
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
                  <div className="commit-diff-message">
                    {mergeDetails.mergeCommitMessage}
                  </div>
                )}
                {mergeDetails.mergedAt && (
                  <div className="commit-diff-timestamp">
                    Merged {new Date(mergeDetails.mergedAt).toLocaleString()}
                  </div>
                )}
              </div>
            )}
            <div className="changes-diff-file-list">
              {files.map((file, index) => (
                <button
                  key={file.path}
                  className={`changes-diff-file-item ${selectedIndex === index ? "selected" : ""}`}
                  onClick={() => setSelectedIndex(index)}
                  title={file.path}
                >
                  <span
                    className={`changes-file-status changes-file-status--${file.status}`}
                  >
                    {getStatusLabel(file.status)}
                  </span>
                  <span className="changes-diff-file-path">{truncateMiddle(file.path)}</span>
                  <span className="changes-diff-file-stat">
                    +{file.additions} -{file.deletions}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Right panel — diff viewer */}
          <div className="changes-diff-content">
            {selectedFile ? (
              <>
                <div className="changes-diff-file-header-bar">
                  <span className="changes-diff-file-header-name">
                    {selectedFile.path}
                  </span>
                  <span className="changes-diff-file-header-stats">
                    +{selectedFile.additions} -{selectedFile.deletions}
                  </span>
                </div>
                {selectedFile.patch ? (
                  <div className="changes-diff-viewer">
                    <pre
                      className={`changes-diff-patch ${wordWrap ? "changes-diff-patch--wrap" : "changes-diff-patch--nowrap"}`}
                    >
                      <code>{highlightDiff(selectedFile.patch)}</code>
                    </pre>
                  </div>
                ) : (
                  <div className="changes-diff-empty">
                    No diff available for this file.
                  </div>
                )}
              </>
            ) : (
              <div className="changes-diff-empty">
                <FileCode size={48} opacity={0.3} />
                <p>Select a file to view its diff</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
