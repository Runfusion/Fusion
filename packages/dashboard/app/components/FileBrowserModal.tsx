import { useState, useCallback, useEffect } from "react";
import { X, Save, RotateCcw, Folder, FileType, ArrowLeft } from "lucide-react";
import { useFileBrowser } from "../hooks/useFileBrowser";
import { useFileEditor } from "../hooks/useFileEditor";
import { useProjectFileBrowser } from "../hooks/useProjectFileBrowser";
import { useProjectFileEditor } from "../hooks/useProjectFileEditor";
import { FileBrowser } from "./FileBrowser";
import { FileEditor } from "./FileEditor";

// Mobile breakpoint - must match existing codebase
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

/**
 * Check if a file is a binary file based on extension.
 */
function isBinaryFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

type TaskModeProps = {
  taskId: string;
  worktreePath?: string;
  projectRoot?: never;
};

type ProjectModeProps = {
  projectRoot: string;
  taskId?: never;
  worktreePath?: never;
};

type FileBrowserModalProps = {
  isOpen?: boolean;
  onClose: () => void;
} & (TaskModeProps | ProjectModeProps);

export function FileBrowserModal(props: FileBrowserModalProps) {
  const { taskId, projectRoot, onClose } = props;
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  
  // Mobile detection and view state (following GitHubImportModal pattern)
  const [isMobile, setIsMobile] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'editor'>('list');
  
  // Detect mobile viewport
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    };
    
    // Check initially
    checkMobile();
    
    // Listen for resize
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);
  
  // Reset to list view when modal opens (selectedFile becomes null)
  useEffect(() => {
    if (!selectedFile) {
      setMobileView('list');
    }
  }, [selectedFile]);

  // Determine mode based on which prop is provided
  const isTaskMode = taskId !== undefined;
  const isProjectMode = projectRoot !== undefined;

  // Use appropriate hooks based on mode
  const taskBrowser = useFileBrowser(taskId ?? "", isTaskMode);
  const projectBrowser = useProjectFileBrowser(projectRoot ?? "", isProjectMode);

  const taskEditor = useFileEditor(taskId ?? "", selectedFile, isTaskMode);
  const projectEditor = useProjectFileEditor(projectRoot ?? "", selectedFile, isProjectMode);

  // Select the active hooks based on mode
  const {
    entries,
    currentPath,
    setPath,
    loading: browserLoading,
    error: browserError,
    refresh,
  } = isTaskMode ? taskBrowser : projectBrowser;

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
  } = isTaskMode ? taskEditor : projectEditor;

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (hasChanges && !saving) {
          save();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, hasChanges, saving, save]);

  const handleSelectFile = useCallback((path: string) => {
    setSelectedFile(path);
    // On mobile, switch to editor view when a file is selected
    if (isMobile) {
      setMobileView('editor');
    }
  }, [isMobile]);
  
  // Handle back button - return to list view on mobile
  const handleBackToList = useCallback(() => {
    setMobileView('list');
  }, []);

  const handleDiscard = useCallback(() => {
    setContent(originalContent);
  }, [originalContent, setContent]);

  const formatFileSize = (content: string): string => {
    const bytes = new Blob([content]).size;
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  // Determine modal title based on mode
  const modalTitle = isTaskMode ? `Files — ${taskId}` : "Files — Project";

  return (
    <div className="modal-overlay open" onClick={onClose}>
      <div className="modal file-browser-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="file-browser-header-title">
            <Folder size={18} />
            <span>{modalTitle}</span>
            {selectedFile && (
              <span className="file-browser-header-path">
                {currentPath === "." ? "" : currentPath + "/"}
                {selectedFile}
              </span>
            )}
          </div>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="file-browser-body">
          <div className={`file-browser-sidebar ${isMobile ? 'mobile' : ''} ${mobileView === 'list' ? 'active' : ''}`}>
            <FileBrowser
              entries={entries}
              currentPath={currentPath}
              onSelectFile={handleSelectFile}
              onNavigate={setPath}
              loading={browserLoading}
              error={browserError}
              onRetry={refresh}
            />
          </div>

          <div className={`file-browser-content ${isMobile ? 'mobile' : ''} ${mobileView === 'editor' ? 'active' : ''}`}>
            {selectedFile ? (
              <>
                <div className="file-browser-toolbar">
                  <div className="file-browser-file-info">
                    {isMobile && mobileView === 'editor' && (
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
                    {selectedFile && isBinaryFile(selectedFile) && (
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
                          onClick={save}
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
                    readOnly={selectedFile ? isBinaryFile(selectedFile) : false}
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
