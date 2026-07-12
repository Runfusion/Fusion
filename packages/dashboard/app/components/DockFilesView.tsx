import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Maximize2, Save } from "lucide-react";
import type { PluginDashboardViewContext } from "../plugins/types";
import { downloadFileUrl } from "../api";
import { useWorkspaceFileBrowser } from "../hooks/useWorkspaceFileBrowser";
import { useWorkspaceFileEditor } from "../hooks/useWorkspaceFileEditor";
import { useAutoSavePreference } from "../hooks/useAutoSavePreference";
import { getScopedItem, removeScopedItem, scopedKey, setScopedItem } from "../utils/projectStorage";
import { getFilePreviewKind, IMAGE_PREVIEW_EXTENSIONS, VIDEO_PREVIEW_EXTENSIONS, AUDIO_PREVIEW_EXTENSIONS, PDF_PREVIEW_EXTENSIONS } from "../utils/file-preview-kind";
import { FileBrowser } from "./FileBrowser";
import { FileEditor } from "./FileEditor";
import "./DockFilesView.css";

interface DockFilesViewProps {
  projectId?: string;
  openFile?: PluginDashboardViewContext["openFile"];
  /*
  FNXC:RightDockFiles 2026-06-22-15:00:
  Deterministic layout selector, replacing the fragile container-query-only approach.
  - "auto" (default, compact right dock): keep the container-query single-panel stack (tree, then viewer overlays on select).
  - "two-pane" (RightDockExpandModal pop-out): force the LEFT|RIGHT split (tree left, viewer right) via a root modifier class, NOT gated by any @container width. The container query never reliably fired inside the modal body (the content-box landed under the breakpoint), so the pop-out kept stacking.
  */
  layout?: "auto" | "two-pane";
}

/*
FNXC:RightDockFiles 2026-06-22-23:30:
The compact dock Files view and the popped-out (expand) Files view are SEPARATE component instances (one renders in the dock body, the other inside RightDockExpandModal). The currently-viewed file lived in each instance's local `selectedFile` state, so popping out always opened with no file selected.
Share the current-file path through scoped localStorage (`kb-dashboard-dock-files-current`, keyed per project via projectStorage). Selecting/clearing a file writes the key; on mount each instance reads it so the expand opens the SAME file the dock was showing. A `storage` listener keeps both instances live-synced when the other tab/instance changes selection.
*/
export const DOCK_FILES_CURRENT_KEY = "kb-dashboard-dock-files-current";

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

function isBinaryFile(filename?: string | null): boolean {
  if (!filename) {
    return false;
  }
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex < 0) {
    return false;
  }
  return BINARY_EXTENSIONS.has(filename.slice(dotIndex).toLowerCase());
}

/*
FNXC:RightDockFiles 2026-06-22-00:00:
The right-dock Files tool opens a clicked file INLINE inside the dock as a read-only viewer instead of immediately launching the resizable/movable FileBrowserModal.
Clicking a file in the tree sets local `selectedFile` (it does NOT call `openFile`); the inline viewer reuses the read-only `FileEditor` so markdown previews and syntax highlighting match the rest of the app.
The viewer header carries a BACK button (clears `selectedFile`, returning to the tree) and a POP-OUT button that calls `openFile(path, { workspace: "project" })` to escalate to the existing resizable/movable modal. This preserves the modal path; it is now opt-in via pop-out rather than the default click behavior.

FNXC:Files 2026-06-22-00:00:
Responsive layout. BOTH the tree pane and the viewer pane are always rendered in the DOM; CSS decides what is visible.
- AUTO (dock, default `layout="auto"`): container-query single-panel stack. Tree shows alone; selecting a file reveals the viewer pane which overlays the stack, and the BACK button returns to the tree. This preserves the prior navigation-stack UX.
- TWO-PANE (RightDockExpandModal pop-out, `layout="two-pane"`): two-pane side-by-side. Left pane = tree (clamped width, scrollable). Right pane = viewer (flex:1, scrollable) showing an empty-state until a file is selected. Selecting a file updates the right pane without hiding the tree, so the BACK button is hidden.

FNXC:RightDockFiles 2026-06-22-15:00:
The two-pane split is now DETERMINISTIC via the `layout` prop / `.dock-files-view--two-pane` modifier, NOT the @container query. The container query was unreliable inside the expand modal body (the root's content-box measured under the breakpoint at common laptop widths), so the pop-out kept stacking. The container-query path remains only for the `auto` (dock) layout.
*/
export function DockFilesView({ projectId, openFile, layout = "auto" }: DockFilesViewProps) {
  const { t } = useTranslation("app");
  const { entries, currentPath, setPath, loading, error, refresh } = useWorkspaceFileBrowser("project", true, projectId);

  // FNXC:RightDockFiles 2026-06-22-12:00: selected file drives the inline read-only viewer; null returns to the tree.
  // FNXC:RightDockFiles 2026-06-22-23:30: initialize from the shared scoped-storage key so the expand pop-out opens the same file the dock is showing.
  const [selectedFile, setSelectedFile] = useState<string | null>(() => getScopedItem(DOCK_FILES_CURRENT_KEY, projectId) || null);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const { autoSaveEnabled, toggleAutoSave } = useAutoSavePreference();

  /*
  FNXC:RightDockFiles 2026-06-22-23:30:
  Persist the current file to the shared scoped key and update local state in one place. Writing the key lets the OTHER instance (dock or expand) pick up the change on its next mount or via the `storage` listener below. An empty/null path clears the key (returns to the tree everywhere).
  */
  const selectFile = useCallback((path: string | null) => {
    setSelectedFile(path);
    if (path) {
      setScopedItem(DOCK_FILES_CURRENT_KEY, path, projectId);
    } else {
      removeScopedItem(DOCK_FILES_CURRENT_KEY, projectId);
    }
  }, [projectId]);

  // FNXC:RightDockFiles 2026-06-22-23:30: re-read the shared key when the project changes, and live-sync from cross-instance `storage` events so dock and expand stay in lockstep.
  useEffect(() => {
    setSelectedFile(getScopedItem(DOCK_FILES_CURRENT_KEY, projectId) || null);

    if (typeof window === "undefined") return;
    const watchedKey = scopedKey(DOCK_FILES_CURRENT_KEY, projectId);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== watchedKey) return;
      setSelectedFile(event.newValue || null);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [projectId]);

  const selectedPreviewKind = useMemo(() => getFilePreviewKind(selectedFile), [selectedFile]);
  const isPreviewOnlyFile = selectedPreviewKind !== null;
  const isReadOnlyBinaryFile = Boolean(selectedFile && !isPreviewOnlyFile && isBinaryFile(selectedFile));
  const previewUrl = useMemo(() => {
    if (!selectedFile || !selectedPreviewKind) {
      return null;
    }
    return downloadFileUrl("project", selectedFile, projectId, { inline: true });
  }, [projectId, selectedFile, selectedPreviewKind]);

  /*
  FNXC:RightDockFiles 2026-06-22-16:28:
  The right-sidebar file viewer must be the same editor surface as the modal/mobile file browser: real workspace editor state, visible toolbar options, Preview/Edit for markdown, Line #, and Wrap. Use the shared editor hook instead of the old read-only content fetch so edits can be saved and the toolbar is not a reduced sidebar-only variant.

  FNXC:RightDockFiles 2026-06-25-00:00:
  Known image/video/audio/PDF selections render through browser-native previews loaded from the workspace-safe download route. Keep those preview-only files out of CodeMirror so binary bytes are never fetched as editor text; editable text keeps the existing FileEditor + Save path, while known non-preview binary extensions stay read-only without loading bytes as editor content.
  */
  const {
    content,
    setContent,
    loading: contentLoading,
    saving,
    error: contentError,
    save,
    hasChanges,
  } = useWorkspaceFileEditor("project", selectedFile, Boolean(selectedFile) && !isPreviewOnlyFile && !isReadOnlyBinaryFile, projectId, autoSaveEnabled);

  const handleBack = useCallback(() => selectFile(null), [selectFile]);
  const handlePopOut = useCallback(() => {
    if (selectedFile) openFile?.(selectedFile, { workspace: "project" });
  }, [openFile, selectedFile]);
  const handleToggleLineNumbers = useCallback(() => setShowLineNumbers((current) => !current), []);

  const fileName = selectedFile ? selectedFile.split("/").pop() || selectedFile : "";
  const selectedPreviewTitle = selectedFile
    ? t("fileBrowser.previewTitle", "Preview for {{file}}", { file: selectedFile })
    : "";

  // FNXC:Files 2026-06-22-00:00:
  // `data-selected` on the root lets the container query distinguish "no file selected" (narrow: viewer pane hidden so only the tree shows) from "file selected" (narrow: viewer pane covers the stack). When wide both panes are always visible regardless of this flag.
  return (
    <div
      /*
      FNXC:RightDockFiles 2026-06-22-15:00:
      `--two-pane` modifier deterministically forces the LEFT|RIGHT split for the expand pop-out. The default ("auto") keeps the container-query-driven dock behavior.
      */
      className={`dock-files-view${layout === "two-pane" ? " dock-files-view--two-pane" : ""}`}
      data-testid="right-dock-files-view"
      data-layout={layout}
      data-selected={selectedFile ? "true" : "false"}
    >
      {/* FNXC:RightDockFiles 2026-06-22-12:00: left pane: tree. Always in the DOM; CSS hides it only in the narrow single-panel stack when a file is selected. */}
      <div className="dock-files-view__tree" data-testid="right-dock-files-tree">
        <FileBrowser
          entries={entries}
          currentPath={currentPath}
          onSelectFile={(path) => selectFile(path)}
          onNavigate={setPath}
          loading={loading}
          error={error}
          onRetry={refresh}
          workspace="project"
          onRefresh={refresh}
          projectId={projectId}
          showProjectFileControls
        />
      </div>

      {/* FNXC:RightDockFiles 2026-06-22-12:00: right pane: viewer. Always in the DOM; CSS shows it side-by-side when wide, or as the single-panel stack when narrow + a file is selected. */}
      <div className="dock-files-view__viewer" data-testid="right-dock-files-viewer">
        <div className="dock-files-viewer__header">
          {/* FNXC:RightDockFiles 2026-06-22-12:00: BACK only matters in the narrow stack (returns to the tree); CSS hides it when wide since the tree is always visible. */}
          <button
            type="button"
            className="btn btn-sm btn-icon dock-files-viewer__back"
            onClick={handleBack}
            aria-label={t("fileViewer.back", "Back to files")}
            title={t("fileViewer.back", "Back to files")}
            data-testid="right-dock-files-back"
          >
            <ArrowLeft size={14} />
          </button>
          <span className="dock-files-viewer__title" title={selectedFile ?? undefined}>{fileName}</span>
          <button
            type="button"
            className="btn btn-sm btn-icon dock-files-viewer__popout"
            onClick={handlePopOut}
            disabled={!selectedFile}
            aria-label={t("fileViewer.popOut", "Open in resizable window")}
            title={t("fileViewer.popOut", "Open in resizable window")}
            data-testid="right-dock-files-popout"
          >
            <Maximize2 size={14} />
          </button>
          {selectedFile && !isPreviewOnlyFile && !isReadOnlyBinaryFile ? (
            <button
              type="button"
              className="btn btn-sm btn-primary dock-files-viewer__save"
              onClick={() => void save()}
              disabled={!hasChanges || saving}
              data-testid="right-dock-files-save"
            >
              <Save size={14} />
              {saving ? t("fileBrowser.saving", "Saving…") : t("actions.save", "Save")}
            </button>
          ) : null}
        </div>
        <div className="dock-files-viewer__body">
          {!selectedFile ? (
            <div className="dock-files-viewer__status dock-files-viewer__empty" data-testid="right-dock-files-empty">
              {t("fileViewer.selectAFile", "Select a file")}
            </div>
          ) : previewUrl && selectedPreviewKind ? (
            <div className={`file-browser-preview file-browser-preview--${selectedPreviewKind} dock-files-preview`}>
              {selectedPreviewKind === "image" ? (
                <img
                  src={previewUrl}
                  alt={selectedFile}
                  className="file-browser-preview-media file-browser-preview-media--image dock-files-preview__media"
                />
              ) : null}
              {selectedPreviewKind === "video" ? (
                <video
                  src={previewUrl}
                  controls
                  aria-label={selectedPreviewTitle}
                  className="file-browser-preview-media file-browser-preview-media--video dock-files-preview__media"
                />
              ) : null}
              {selectedPreviewKind === "audio" ? (
                <audio
                  src={previewUrl}
                  controls
                  aria-label={selectedPreviewTitle}
                  className="file-browser-preview-media file-browser-preview-media--audio dock-files-preview__media"
                />
              ) : null}
              {selectedPreviewKind === "pdf" ? (
                <iframe
                  src={previewUrl}
                  title={selectedPreviewTitle}
                  className="file-browser-preview-media file-browser-preview-media--pdf dock-files-preview__media"
                />
              ) : null}
            </div>
          ) : isReadOnlyBinaryFile ? (
            <div className="dock-files-viewer__status" data-testid="right-dock-files-binary-read-only">
              {t("fileBrowser.binaryReadOnly", "Binary file — read only")}
            </div>
          ) : contentLoading ? (
            <div className="dock-files-viewer__status">{t("common.loading", "Loading...")}</div>
          ) : contentError ? (
            <div className="dock-files-viewer__status dock-files-viewer__status--error">{contentError}</div>
          ) : (
            <FileEditor
              content={content}
              onChange={setContent}
              filePath={selectedFile}
              showLineNumbers={showLineNumbers}
              onToggleLineNumbers={handleToggleLineNumbers}
              autoSaveEnabled={autoSaveEnabled}
              onToggleAutoSave={toggleAutoSave}
              toolbarExpanded
              forceToolbarActionsVisible
            />
          )}
        </div>
      </div>
    </div>
  );
}
