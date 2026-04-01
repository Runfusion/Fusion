import { useEffect, useMemo } from "react";
import { FileEdit, FileMinus, FilePlus, FileSymlink, FolderGit2, X } from "lucide-react";
import { useChangedFiles } from "../hooks/useChangedFiles";
import type { TaskFileDiff } from "../api";

interface ChangedFilesModalProps {
  taskId: string;
  worktree: string | undefined;
  column: string;
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
  const statLines = lines.filter((line) => line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ "));
  return statLines.join("\n").trim();
}

export function ChangedFilesModal({ taskId, worktree, column, isOpen, onClose }: ChangedFilesModalProps) {
  const { files, loading, error, selectedFile, setSelectedFile } = useChangedFiles(taskId, worktree, column);

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

  const selectedStat = useMemo(() => (selectedFile ? getDiffStat(selectedFile.diff) : ""), [selectedFile]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={onClose}>
      <div className="modal file-browser-modal changed-files-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header file-browser-modal-header">
          <div className="file-browser-header-title">
            <FolderGit2 size={18} />
            <span>Changed Files — {taskId}</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close changed files viewer">
            <X size={20} />
          </button>
        </div>

        <div className="file-browser-body">
          <aside className="file-browser-sidebar" style={{ flex: "0 0 30%" }}>
            {loading ? (
              <div className="gm-diff-loading">Loading changed files…</div>
            ) : error ? (
              <div className="gm-diff-error">{error}</div>
            ) : files.length === 0 ? (
              <div className="file-browser-empty-state">No files changed</div>
            ) : (
              <div className="file-browser-list" role="list" aria-label="Changed files list">
                {files.map((file) => {
                  const active = selectedFile?.path === file.path && selectedFile?.oldPath === file.oldPath;
                  return (
                    <button
                      key={`${file.oldPath ?? ""}:${file.path}`}
                      type="button"
                      role="listitem"
                      className={`file-browser-entry ${active ? "active" : ""}`}
                      onClick={() => setSelectedFile(file)}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        {getStatusIcon(file.status)}
                        <span>{file.path}</span>
                      </span>
                      <span className="badge">{getStatusLabel(file.status)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </aside>

          <section className="file-browser-content" style={{ flex: "0 0 70%" }}>
            {!loading && !error && files.length > 0 && !selectedFile ? (
              <div className="file-browser-empty-state">Select a file to view changes</div>
            ) : null}

            {selectedFile ? (
              <div className="gm-diff-section" aria-label={`Diff for ${selectedFile.path}`}>
                <div className="file-browser-toolbar">
                  <div className="file-browser-file-info">
                    <strong>{selectedFile.path}</strong>
                    <span className="badge">{getStatusLabel(selectedFile.status)}</span>
                    {selectedFile.oldPath ? <span>Renamed from {selectedFile.oldPath}</span> : null}
                  </div>
                </div>
                <div className="gm-diff-viewer">
                  {selectedStat ? <pre className="gm-diff-stat">{selectedStat}</pre> : null}
                  <pre className="gm-diff-patch">{selectedFile.diff || "No diff available"}</pre>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
