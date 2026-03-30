import { useState, useCallback, useEffect } from "react";
import { X, Save, RotateCcw, Folder } from "lucide-react";
import { useFileBrowser } from "../hooks/useFileBrowser";
import { useFileEditor } from "../hooks/useFileEditor";
import { FileBrowser } from "./FileBrowser";
import { FileEditor } from "./FileEditor";

interface FileBrowserModalProps {
  taskId: string;
  worktreePath?: string;
  isOpen?: boolean;
  onClose: () => void;
}

export function FileBrowserModal({ taskId, worktreePath, onClose }: FileBrowserModalProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const {
    entries,
    currentPath,
    setPath,
    loading: browserLoading,
    error: browserError,
    refresh,
  } = useFileBrowser(taskId, true);

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
  } = useFileEditor(taskId, selectedFile, true);

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
  }, []);

  const handleDiscard = useCallback(() => {
    setContent(originalContent);
  }, [originalContent, setContent]);

  const formatFileSize = (content: string): string => {
    const bytes = new Blob([content]).size;
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  return (
    <div className="modal-overlay open" onClick={onClose}>
      <div className="modal file-browser-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="file-browser-header-title">
            <Folder size={18} />
            <span>Files</span>
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
          <div className="file-browser-sidebar">
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

          <div className="file-browser-content">
            {selectedFile ? (
              <>
                <div className="file-browser-toolbar">
                  <div className="file-browser-file-info">
                    {selectedFile}
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
