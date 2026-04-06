import { useState, useCallback, useEffect, useMemo } from "react";
import { X, Save, RotateCcw, Folder, FileType, ArrowLeft } from "lucide-react";
import { useWorkspaceFileBrowser } from "../hooks/useWorkspaceFileBrowser";
import { useWorkspaceFileEditor } from "../hooks/useWorkspaceFileEditor";
import { useWorkspaces } from "../hooks/useWorkspaces";
import { FileBrowser } from "./FileBrowser";
import { FileEditor } from "./FileEditor";
import { WorkspaceSelector } from "./WorkspaceSelector";

const MOBILE_BREAKPOINT = 768;

/**
 * Binary file extensions that should be displayed as read-only.
 */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svgz",
  ".exe", ".dll", ".so", ".dylib",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".mp3", ".mp4", ".avi", ".mov", ".webm", ".mkv", ".flv",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".wasm", ".bin",
]);

function isBinaryFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

interface FileBrowserModalProps {
  isOpen?: boolean;
  initialWorkspace?: string;
  onClose: () => void;
  onWorkspaceChange?: (workspace: string) => void;
}

/**
 * Workspace-aware file browser modal used by the top-level dashboard Files button.
 * Supports browsing the project root or any active task worktree from one shared UI.
 */
export function FileBrowserModal({
  initialWorkspace = "project",
  onClose,
  onWorkspaceChange,
}: FileBrowserModalProps) {
  const { projectName, workspaces } = useWorkspaces();
  const [currentWorkspace, setCurrentWorkspace] = useState(initialWorkspace);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "editor">("list");

  const {
    entries,
    currentPath,
    setPath,
    loading: browserLoading,
    error: browserError,
    refresh,
  } = useWorkspaceFileBrowser(currentWorkspace, true);

  const {
    content,
    setContent,
    originalContent,
    loading: editorLoading,
    saving,
    error: editorError,
    save,
    hasChanges,
    mtime,
  } = useWorkspaceFileEditor(currentWorkspace, selectedFile, true);

  useEffect(() => {
    setCurrentWorkspace(initialWorkspace);
  }, [initialWorkspace]);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useEffect(() => {
    if (!selectedFile) {
      setMobileView("list");
    }
  }, [selectedFile]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (hasChanges && !saving) {
          void save();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, hasChanges, saving, save]);

  const handleSelectFile = useCallback((path: string) => {
    setSelectedFile(path);
    if (isMobile) {
      setMobileView("editor");
    }
  }, [isMobile]);

  const handleBackToList = useCallback(() => {
    setMobileView("list");
  }, []);

  const handleDiscard = useCallback(() => {
    setContent(originalContent);
  }, [originalContent, setContent]);

  const handleWorkspaceSelect = useCallback((workspace: string) => {
    setCurrentWorkspace(workspace);
    setSelectedFile(null);
    setMobileView("list");
    onWorkspaceChange?.(workspace);
  }, [onWorkspaceChange]);

  const workspaceLabel = useMemo(() => {
    if (currentWorkspace === "project") {
      return "Project";
    }

    return workspaces.find((workspace) => workspace.id === currentWorkspace)?.id ?? currentWorkspace;
  }, [currentWorkspace, workspaces]);

  const modalTitle = `Files — ${workspaceLabel}`;

  const formatFileSize = (value: string): string => {
    const bytes = new Blob([value]).size;
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  return (
    <div className="modal-overlay open" onClick={onClose}>
      <div className="modal file-browser-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header file-browser-modal-header">
          <div className="file-browser-header-title">
            <Folder size={18} />
            <span>{modalTitle}</span>
            {selectedFile && (
              <span className="file-browser-header-path">
                {selectedFile}
              </span>
            )}
          </div>
          <div className="file-browser-header-actions">
            <WorkspaceSelector
              currentWorkspace={currentWorkspace}
              projectName={projectName}
              workspaces={workspaces}
              onSelect={handleWorkspaceSelect}
            />
            <button className="modal-close" onClick={onClose}>
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="file-browser-body">
          <div className={`file-browser-sidebar ${isMobile ? "mobile" : ""} ${mobileView === "list" ? "active" : ""}`}>
            <FileBrowser
              entries={entries}
              currentPath={currentPath}
              onSelectFile={handleSelectFile}
              onNavigate={setPath}
              loading={browserLoading}
              error={browserError}
              onRetry={refresh}
              workspace={currentWorkspace}
              onRefresh={refresh}
            />
          </div>

          <div className={`file-browser-content ${isMobile ? "mobile" : ""} ${mobileView === "editor" ? "active" : ""}`}>
            {selectedFile ? (
              <>
                <div className="file-browser-toolbar">
                  <div className="file-browser-file-info">
                    {isMobile && mobileView === "editor" && (
                      <button
                        className="file-browser-back-button"
                        onClick={handleBackToList}
                        aria-label="Back to file list"
                      >
                        <ArrowLeft size={16} />
                        <span>Back</span>
                      </button>
                    )}
                    {selectedFile}
                    {isBinaryFile(selectedFile) && (
                      <span className="file-browser-binary-indicator">
                        <FileType size={12} />
                        Binary file — read only
                      </span>
                    )}
                    {mtime && (
                      <span className="file-browser-mtime">
                        Modified: {new Date(mtime).toLocaleString()}
                      </span>
                    )}
                    {editorLoading && (
                      <span className="file-browser-loading">Loading...</span>
                    )}
                  </div>
                  <div className="file-browser-actions">
                    {hasChanges && (
                      <>
                        <button
                          className="btn btn-sm"
                          onClick={handleDiscard}
                          disabled={saving}
                        >
                          <RotateCcw size={14} />
                          Discard
                        </button>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => void save()}
                          disabled={saving}
                        >
                          <Save size={14} />
                          {saving ? "Saving..." : "Save"}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {editorError && (
                  <div className="file-browser-error-banner">{editorError}</div>
                )}

                <div className="file-editor-wrapper">
                  <FileEditor
                    content={content}
                    onChange={setContent}
                    filePath={selectedFile}
                    readOnly={isBinaryFile(selectedFile)}
                  />
                </div>

                <div className="file-browser-footer">
                  <span>{formatFileSize(content)}</span>
                  {hasChanges && <span className="file-browser-unsaved">Unsaved changes</span>}
                </div>
              </>
            ) : (
              <div className="file-browser-placeholder">
                <Folder size={48} opacity={0.3} />
                <p>Select a file to edit</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
