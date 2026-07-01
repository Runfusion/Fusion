import "./FileBrowser.css";
import { useState, useCallback, useEffect, useMemo, useId, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X, Save, RotateCcw, Folder, FileType, ArrowLeft, ChevronDown, ChevronUp } from "lucide-react";
import { useWorkspaceFileBrowser } from "../hooks/useWorkspaceFileBrowser";
import { useWorkspaceFileEditor } from "../hooks/useWorkspaceFileEditor";
import { useWorkspaces } from "../hooks/useWorkspaces";
import { downloadFileUrl } from "../api";
import { FileBrowser } from "./FileBrowser";
import { FileEditor } from "./FileEditor";
import { FloatingWindow } from "./FloatingWindow";
import { WorkspaceSelector } from "./WorkspaceSelector";
import { getFilePreviewKind, IMAGE_PREVIEW_EXTENSIONS, VIDEO_PREVIEW_EXTENSIONS, AUDIO_PREVIEW_EXTENSIONS, PDF_PREVIEW_EXTENSIONS } from "../utils/file-preview-kind";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";

const MOBILE_BREAKPOINT = 768;
const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 500;
const SIDEBAR_STORAGE_KEY = "fusion:file-browser-sidebar-width";
const FILES_LINE_NUMBERS_STORAGE_KEY = "kb-files-line-numbers";

/**
 * Binary file extensions that should be displayed as read-only when the browser cannot preview them natively.
 */
const BINARY_EXTENSIONS = new Set([
  ...IMAGE_PREVIEW_EXTENSIONS,
  ...VIDEO_PREVIEW_EXTENSIONS,
  ...AUDIO_PREVIEW_EXTENSIONS,
  ...PDF_PREVIEW_EXTENSIONS,
  ".exe", ".dll", ".so", ".dylib",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".avi", ".mkv", ".flv",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".wasm", ".bin",
]);

function isBinaryFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return Boolean(getFilePreviewKind(filename)) || BINARY_EXTENSIONS.has(ext);
}

function getParentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  /*
  FNXC:FileBrowser 2026-06-29-21:30:
  Initial absolute files in the filesystem root, such as `/README.md`, must reopen the browser at `/` instead of workspace root. The absolute-path setting is slash-prefixed only, so preserve POSIX root semantics here without adding Windows drive-letter behavior.
  */
  if (normalized.startsWith("/") && lastSlash === 0) {
    return "/";
  }
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : ".";
}

interface FileBrowserModalProps {
  isOpen?: boolean;
  initialWorkspace?: string;
  initialFile?: string | null;
  onClose: () => void;
  onWorkspaceChange?: (workspace: string) => void;
  projectId?: string;
  onSendSelectionToTask?: (description: string) => void;
}

/**
 * Workspace-aware file browser modal used by the top-level dashboard Files button.
 * Supports browsing the project root or any active task worktree from one shared UI.
 */
export function FileBrowserModal({
  initialWorkspace = "project",
  initialFile = null,
  onClose,
  onWorkspaceChange,
  projectId,
  onSendSelectionToTask,
}: FileBrowserModalProps) {
  const { t } = useTranslation("app");
  const { projectName, workspaces } = useWorkspaces(projectId);
  const [currentWorkspace, setCurrentWorkspace] = useState(initialWorkspace);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const [viewportMobile, setViewportMobile] = useState(false);
  const [modalWidth, setModalWidth] = useState<number | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "editor">("list");
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [showLineNumbers, setShowLineNumbers] = useState(false);
  const [toolbarActionsExpanded, setToolbarActionsExpanded] = useState(false);
  const toolbarActionsId = useId();

  const {
    entries,
    currentPath,
    setPath,
    loading: browserLoading,
    error: browserError,
    refresh,
  } = useWorkspaceFileBrowser(currentWorkspace, true, projectId);

  const selectedPreviewKind = useMemo(() => getFilePreviewKind(selectedFile), [selectedFile]);
  const isPreviewOnlyFile = selectedPreviewKind !== null;

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
  } = useWorkspaceFileEditor(currentWorkspace, selectedFile, !isPreviewOnlyFile, projectId);

  useEffect(() => {
    setCurrentWorkspace(initialWorkspace);
  }, [initialWorkspace]);

  useEffect(() => {
    const checkMobile = () => {
      setViewportMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  /*
  FNXC:FileBrowser 2026-06-22-17:25:
  The Files floating window can be resized narrower than the desktop two-pane layout while the browser viewport is still desktop-sized. Mirror Chat's ResizeObserver-driven responsive mode: once the modal itself is at mobile width, switch to the list/editor single-pane flow and hide the sidebar after a file opens.

  FNXC:FileBrowser 2026-06-23-23:45:
  The Files modal layout should be responsive to its own floating-window width: wide modals show the two-pane browser/editor split, narrow modals show the mobile list/editor flow. Viewport width is only a pre-measurement fallback so a widened modal can always return to the split view.
  */
  useLayoutEffect(() => {
    const element = modalRef.current;
    if (!element) {
      return;
    }

    const update = () => {
      const measuredWidth = element.getBoundingClientRect().width || element.clientWidth || window.innerWidth;
      setModalWidth(measuredWidth);
    };

    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const isMobile = modalWidth === null ? viewportMobile : modalWidth <= MOBILE_BREAKPOINT;

  useEffect(() => {
    if (!selectedFile) {
      setMobileView("list");
    }
    setToolbarActionsExpanded(false);
  }, [selectedFile]);

  useEffect(() => {
    if (isMobile && selectedFile) {
      setMobileView("editor");
    }
  }, [isMobile, selectedFile]);

  useEffect(() => {
    if (!initialFile) {
      setSelectedFile(null);
      return;
    }

    setSelectedFile(initialFile);
    setPath(getParentDirectory(initialFile));
    if (isMobile) {
      setMobileView("editor");
    }
  }, [initialFile, isMobile, setPath]);

  useEffect(() => {
    try {
      const rawWidth = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (!rawWidth) return;
      const parsedWidth = Number.parseInt(rawWidth, 10);
      if (!Number.isNaN(parsedWidth)) {
        const clampedWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, parsedWidth));
        setSidebarWidth(clampedWidth);
      }
    } catch {
      // Ignore storage errors.
    }
  }, []);

  useEffect(() => {
    const savedPreference = getScopedItem(FILES_LINE_NUMBERS_STORAGE_KEY, projectId);
    setShowLineNumbers(savedPreference === "true");
  }, [projectId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (!isPreviewOnlyFile && hasChanges && !saving) {
          void save();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, hasChanges, saving, save, isPreviewOnlyFile]);

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

  /*
  FNXC:FileBrowser 2026-06-29-00:00:
  Worktree switches must keep the last selected file path so users can recover from a load error caused by viewing the right path in the wrong workspace. The raw browser hook still resets each new workspace to root, so the modal re-points the sidebar to the selected file's parent directory after that reset while mobile keeps the editor pane active.
  */
  const previousWorkspaceRef = useRef(currentWorkspace);
  useEffect(() => {
    const workspaceChanged = previousWorkspaceRef.current !== currentWorkspace;
    if (workspaceChanged && selectedFile) {
      setPath(getParentDirectory(selectedFile));
      if (isMobile) {
        setMobileView("editor");
      }
    }
    previousWorkspaceRef.current = currentWorkspace;
  }, [currentWorkspace, isMobile, selectedFile, setPath]);

  const handleWorkspaceSelect = useCallback((workspace: string) => {
    setCurrentWorkspace(workspace);
    setMobileView(selectedFile ? "editor" : "list");
    onWorkspaceChange?.(workspace);
  }, [onWorkspaceChange, selectedFile]);

  const persistSidebarWidth = useCallback((width: number) => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(width));
    } catch {
      // Ignore storage errors.
    }
  }, []);

  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const resizeHandle = event.currentTarget;
    if (typeof resizeHandle.setPointerCapture === "function") {
      resizeHandle.setPointerCapture(event.pointerId);
    }

    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latestWidth = startWidth;

    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const nextWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidth + deltaX));
      latestWidth = nextWidth;
      setSidebarWidth(nextWidth);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      if (typeof resizeHandle.releasePointerCapture === "function") {
        resizeHandle.releasePointerCapture(upEvent.pointerId);
      }

      document.body.style.userSelect = "";
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      persistSidebarWidth(latestWidth);
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }, [isMobile, persistSidebarWidth, sidebarWidth]);

  const handleResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isMobile) {
      return;
    }

    const step = 20;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();

    const delta = event.key === "ArrowLeft" ? -step : step;
    const nextWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, sidebarWidth + delta));
    setSidebarWidth(nextWidth);
    persistSidebarWidth(nextWidth);
  }, [isMobile, persistSidebarWidth, sidebarWidth]);

  const handleToggleLineNumbers = useCallback(() => {
    setShowLineNumbers((previousValue) => {
      const nextValue = !previousValue;
      setScopedItem(FILES_LINE_NUMBERS_STORAGE_KEY, String(nextValue), projectId);
      return nextValue;
    });
  }, [projectId]);

  const workspaceLabel = useMemo(() => {
    if (currentWorkspace === "project") {
      return t("fileBrowser.workspaceProject", "Project");
    }

    return workspaces.find((workspace) => workspace.id === currentWorkspace)?.id ?? currentWorkspace;
  }, [currentWorkspace, workspaces, t]);

  const modalTitle = t("fileBrowser.modalTitle", "Files — {{workspace}}", { workspace: workspaceLabel });
  const isNarrowEditorView = Boolean(isMobile && selectedFile && mobileView === "editor" && !isBinaryFile(selectedFile));

  /*
  FNXC:FileBrowser 2026-06-25-00:00:
  Known image, video, audio, and PDF files must use browser-native previews from the workspace-safe download route without fetching binary content into CodeMirror. Editable text and unknown binary files keep the existing editor/read-only paths so save/discard, selection comments, and binary indicators remain scoped to editor-backed files.
  */
  const previewUrl = useMemo(() => {
    if (!selectedFile || !selectedPreviewKind) return null;
    return downloadFileUrl(currentWorkspace, selectedFile, projectId, { inline: true });
  }, [currentWorkspace, projectId, selectedFile, selectedPreviewKind]);

  const selectedPreviewLabel = selectedFile
    ? t("fileBrowser.previewOnly", "Preview only")
    : null;
  const selectedPreviewTitle = selectedFile
    ? t("fileBrowser.previewTitle", "Preview for {{file}}", { file: selectedFile })
    : "";

  const formatFileSize = (value: string): string => {
    const bytes = new Blob([value]).size;
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  return (
    <FloatingWindow
      windowKey="file-browser"
      title={modalTitle}
      onClose={onClose}
      hideHeader
      dragHandleSelector=".file-browser-modal-header"
      className="floating-window--file-browser"
      defaultSize={{ width: 1120, height: 720 }}
      minSize={{ width: 360, height: 420 }}
      persistGeometryKey="fusion:files-modal-window"
    >
      {/*
       * FNXC:FileBrowser 2026-06-22-15:22:
       * The file browser modal uses the shared FloatingWindow shell so it is smoothly movable/resizable like Chat and task detail pop-outs, with a transparent non-blurring backdrop and its own title row as the drag handle.
       */}
      <div ref={modalRef} className={`modal file-browser-modal${isMobile ? " file-browser-modal--narrow" : ""}`}>
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
            <button className="modal-close" onClick={onClose} aria-label={t("actions.close", "Close")}>
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="file-browser-body">
          <div
            className={`file-browser-sidebar ${isMobile ? "mobile" : ""} ${mobileView === "list" ? "active" : ""}`}
            style={isMobile ? undefined : { width: `${sidebarWidth}px` }}
          >
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
              projectId={projectId}
            />
          </div>

          {!isMobile && (
            <div
              className="file-browser-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-valuemin={SIDEBAR_MIN_WIDTH}
              aria-valuemax={SIDEBAR_MAX_WIDTH}
              aria-valuenow={sidebarWidth}
              aria-label={t("fileBrowser.resizeSidebar", "Resize sidebar")}
              tabIndex={0}
              onPointerDown={handleResizeStart}
              onKeyDown={handleResizeKeyDown}
            />
          )}

          <div className={`file-browser-content ${isMobile ? "mobile" : ""} ${mobileView === "editor" ? "active" : ""}`}>
            {selectedFile ? (
              <>
                <div className="file-browser-toolbar">
                  <div className="file-browser-file-info">
                    {isMobile && mobileView === "editor" && (
                      <button
                        className="file-browser-back-button"
                        onClick={handleBackToList}
                        aria-label={t("fileBrowser.back", "Back to file list")}
                      >
                        <ArrowLeft size={16} />
                        <span>{t("actions.back", "Back")}</span>
                      </button>
                    )}
                    {!isBinaryFile(selectedFile) && !isNarrowEditorView && (
                      <button
                        className="btn btn-sm btn-icon file-editor-toolbar-button"
                        onClick={() => setToolbarActionsExpanded((prev) => !prev)}
                        aria-label={t("fileBrowser.toggleEditorOptions", "Toggle editor options")}
                        title={t("fileBrowser.toggleEditorOptions", "Toggle editor options")}
                        aria-expanded={toolbarActionsExpanded}
                        aria-controls={toolbarActionsId}
                      >
                        {toolbarActionsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                    )}
                    {selectedFile}
                    {selectedPreviewKind && selectedPreviewLabel ? (
                      <span className="file-browser-preview-indicator">
                        <FileType size={12} />
                        {selectedPreviewLabel}
                      </span>
                    ) : isBinaryFile(selectedFile) ? (
                      <span className="file-browser-binary-indicator">
                        <FileType size={12} />
                        {t("fileBrowser.binaryReadOnly", "Binary file — read only")}
                      </span>
                    ) : null}
                    {mtime && (
                      <span className="file-browser-mtime">
                        {t("fileBrowser.modified", "Modified: {{date}}", { date: new Date(mtime).toLocaleString() })}
                      </span>
                    )}
                    {editorLoading && (
                      <span className="file-browser-loading">{t("fileBrowser.loading", "Loading…")}</span>
                    )}
                  </div>
                  <div className="file-browser-actions">
                    {!previewUrl && hasChanges && (
                      <>
                        <button
                          className="btn btn-sm"
                          onClick={handleDiscard}
                          disabled={saving}
                        >
                          <RotateCcw size={14} />
                          {t("actions.discard", "Discard")}
                        </button>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => void save()}
                          disabled={saving}
                        >
                          <Save size={14} />
                          {saving ? t("fileBrowser.saving", "Saving…") : t("actions.save", "Save")}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {editorError && !previewUrl && (
                  <div className="file-browser-error-banner">{editorError}</div>
                )}

                {previewUrl && selectedPreviewKind ? (
                  <div className={`file-browser-preview file-browser-preview--${selectedPreviewKind}`}>
                    {selectedPreviewKind === "image" && (
                      <img
                        src={previewUrl}
                        alt={selectedFile ?? ""}
                        className="file-browser-preview-media file-browser-preview-media--image"
                      />
                    )}
                    {selectedPreviewKind === "video" && (
                      <video
                        src={previewUrl}
                        controls
                        aria-label={selectedPreviewTitle}
                        className="file-browser-preview-media file-browser-preview-media--video"
                      />
                    )}
                    {selectedPreviewKind === "audio" && (
                      <audio
                        src={previewUrl}
                        controls
                        aria-label={selectedPreviewTitle}
                        className="file-browser-preview-media file-browser-preview-media--audio"
                      />
                    )}
                    {selectedPreviewKind === "pdf" && (
                      <iframe
                        src={previewUrl}
                        title={selectedPreviewTitle}
                        className="file-browser-preview-media file-browser-preview-media--pdf"
                      />
                    )}
                  </div>
                ) : (
                  <div className="file-editor-wrapper">
                    <FileEditor
                      content={content}
                      onChange={setContent}
                      filePath={selectedFile}
                      readOnly={isBinaryFile(selectedFile)}
                      showLineNumbers={showLineNumbers && !isBinaryFile(selectedFile)}
                      onToggleLineNumbers={handleToggleLineNumbers}
                      canToggleLineNumbers={!isBinaryFile(selectedFile)}
                      toolbarExpanded={isNarrowEditorView ? true : toolbarActionsExpanded}
                      forceToolbarActionsVisible={isNarrowEditorView}
                      toolbarActionsId={toolbarActionsId}
                      onSendSelectionToTask={onSendSelectionToTask}
                    />
                  </div>
                )}

                {!previewUrl && (
                  <div className="file-browser-footer">
                    <span>{formatFileSize(content)}</span>
                    {hasChanges && <span className="file-browser-unsaved">{t("fileBrowser.unsavedChanges", "Unsaved changes")}</span>}
                  </div>
                )}
              </>
            ) : (
              <div className="file-browser-placeholder">
                <Folder size={48} opacity={0.3} />
                <p>{t("fileBrowser.selectFileToEdit", "Select a file to edit")}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </FloatingWindow>
  );
}
