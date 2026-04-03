import { useEffect, useMemo, useState, useCallback } from "react";
import {
  FileEdit,
  FileMinus,
  FilePlus,
  FileSymlink,
  FolderGit2,
  ArrowLeft,
  X,
} from "lucide-react";
import { useChangedFiles } from "../hooks/useChangedFiles";
import { highlightDiff } from "../utils/highlightDiff";
import type { TaskFileDiff } from "../api";

const MOBILE_BREAKPOINT = 768;

interface ChangedFilesModalProps {
  taskId: string;
  worktree: string | undefined;
  column: string;
  projectId?: string;
  isOpen: boolean;
  onClose: () => void;
}

function getStatusLabel(status: TaskFileDiff["status"]): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}

function getStatusIcon(status: TaskFileDiff["status"]) {
  switch (status) {
    case "added":
      return <FilePlus size={16} />;
    case "deleted":
      return <FileMinus size={16} />;
    case "renamed":
      return <FileSymlink size={16} />;
    default:
      return <FileEdit size={16} />;
  }
}

function getDiffStat(diff: string): string {
  const lines = diff.split("\n");
  const statLines = lines.filter(
    (line) =>
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ "),
  );
  return statLines.join("\n").trim();
}

export function ChangedFilesModal({
  taskId,
  worktree,
  column,
  projectId,
  isOpen,
  onClose,
}: ChangedFilesModalProps) {
  const { files, loading, error, selectedFile, setSelectedFile, resetSelection } = useChangedFiles(
    taskId,
    worktree,
    column,
    projectId,
  );

  const [isMobile, setIsMobile] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "diff">("list");

  // Detect mobile viewport
  useEffect(() => {
    if (!isOpen) return;

    const checkMobile = () => {
      setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, [isOpen]);

  // When resizing from desktop to mobile with a file selected, show diff pane
  // When resizing from mobile to desktop, no special action needed (both panes visible)
  useEffect(() => {
    if (!isOpen || !isMobile) return;
    // If we just became mobile and have a selected file, show diff
    if (selectedFile) {
      setMobileView("diff");
    }
  }, [isOpen, isMobile, selectedFile]);

  // Auto-select first file on desktop when files load
  useEffect(() => {
    if (!isOpen || isMobile) return;
    if (!loading && files.length > 0 && !selectedFile) {
      setSelectedFile(files[0]);
    }
  }, [isOpen, isMobile, loading, files, selectedFile, setSelectedFile]);

  // Reset mobile view and selection when modal opens
  useEffect(() => {
    if (isOpen) {
      setMobileView("list");
      resetSelection();
    }
  }, [isOpen, resetSelection]);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleSelectFile = useCallback(
    (file: TaskFileDiff) => {
      setSelectedFile(file);
      if (isMobile) {
        setMobileView("diff");
      }
    },
    [isMobile, setSelectedFile],
  );

  const handleBackToList = useCallback(() => {
    setMobileView("list");
  }, []);

  const selectedStat = useMemo(
    () => (selectedFile ? getDiffStat(selectedFile.diff) : ""),
    [selectedFile],
  );

  if (!isOpen) return null;

  const sidebarClasses = [
    "file-browser-sidebar",
    "changed-files-sidebar",
    isMobile ? "mobile" : "",
    isMobile && mobileView === "list" ? "active" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const contentClasses = [
    "file-browser-content",
    "changed-files-content",
    isMobile ? "mobile" : "",
    isMobile && mobileView === "diff" ? "active" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const showBackButton = isMobile && mobileView === "diff";

  return (
    <div className="modal-overlay open" onClick={onClose}>
      <div
        className="modal file-browser-modal changed-files-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header file-browser-modal-header">
          <div className="file-browser-header-title">
            <FolderGit2 size={18} />
            <span>Changed Files — {taskId}</span>
            {showBackButton && selectedFile ? (
              <span className="file-browser-header-path">{selectedFile.path}</span>
            ) : null}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close changed files viewer">
            <X size={20} />
          </button>
        </div>

        <div className="file-browser-body changed-files-layout">
          <aside className={sidebarClasses}>
            {loading ? (
              <div className="gm-diff-loading">Loading changed files…</div>
            ) : error ? (
              <div className="gm-diff-error">{error}</div>
            ) : files.length === 0 ? (
              <div className="file-browser-empty">No files changed</div>
            ) : (
              <div className="file-browser-list" role="list" aria-label="Changed files list">
                {files.map((file) => {
                  const active =
                    selectedFile?.path === file.path && selectedFile?.oldPath === file.oldPath;
                  return (
                    <button
                      key={`${file.oldPath ?? ""}:${file.path}`}
                      type="button"
                      role="listitem"
                      aria-label={file.path}
                      className={`file-node file-node--file changed-files-entry ${active ? "active" : ""}`}
                      onClick={() => handleSelectFile(file)}
                    >
                      <span className="file-node-icon">{getStatusIcon(file.status)}</span>
                      <span className="file-node-name">{file.path}</span>
                      <span className="detail-column-badge changed-files-badge">
                        {getStatusLabel(file.status)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </aside>

          <section className={contentClasses}>
            {selectedFile ? (
              <div
                className="gm-diff-section changed-files-diff-section"
                aria-label={`Diff for ${selectedFile.path}`}
              >
                <div className="file-browser-toolbar">
                  <div className="file-browser-file-info">
                    {showBackButton && (
                      <button
                        className="changed-files-back-button"
                        onClick={handleBackToList}
                        aria-label="Back to file list"
                      >
                        <ArrowLeft size={16} />
                        <span>Back</span>
                      </button>
                    )}
                    <strong>{selectedFile.path}</strong>
                    <span className="detail-column-badge changed-files-badge">
                      {getStatusLabel(selectedFile.status)}
                    </span>
                    {selectedFile.oldPath ? (
                      <span>Renamed from {selectedFile.oldPath}</span>
                    ) : null}
                  </div>
                </div>
                <div className="gm-diff-viewer">
                  {selectedStat ? <pre className="gm-diff-stat">{selectedStat}</pre> : null}
                  <pre className="gm-diff-patch">
                    <code>{highlightDiff(selectedFile.diff || "No diff available")}</code>
                  </pre>
                </div>
              </div>
            ) : !loading && !error && files.length > 0 ? (
              <div className="file-browser-empty">Select a file to view changes</div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
