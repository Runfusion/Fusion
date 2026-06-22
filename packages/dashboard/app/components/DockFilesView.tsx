import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Maximize2 } from "lucide-react";
import { getErrorMessage } from "@fusion/core";
import type { PluginDashboardViewContext } from "../plugins/types";
import { fetchWorkspaceFileContent } from "../api";
import { useWorkspaceFileBrowser } from "../hooks/useWorkspaceFileBrowser";
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
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  // Load the selected file's content read-only from the project workspace.
  useEffect(() => {
    if (!selectedFile) {
      setContent("");
      setContentError(null);
      return;
    }

    let cancelled = false;
    setContentLoading(true);
    setContentError(null);

    fetchWorkspaceFileContent("project", selectedFile, projectId)
      .then((response) => {
        if (cancelled) return;
        setContent(response.content);
      })
      .catch((err) => {
        if (cancelled) return;
        setContentError(getErrorMessage(err) || t("editor.failedToLoadFile", "Failed to load file"));
        setContent("");
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFile, projectId, t]);

  const handleBack = useCallback(() => setSelectedFile(null), []);
  const handlePopOut = useCallback(() => {
    if (selectedFile) openFile?.(selectedFile, { workspace: "project" });
  }, [openFile, selectedFile]);

  const fileName = selectedFile ? selectedFile.split("/").pop() || selectedFile : "";

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
          onSelectFile={(path) => setSelectedFile(path)}
          onNavigate={setPath}
          loading={loading}
          error={error}
          onRetry={refresh}
          workspace="project"
          onRefresh={refresh}
          projectId={projectId}
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
        </div>
        <div className="dock-files-viewer__body">
          {!selectedFile ? (
            <div className="dock-files-viewer__status dock-files-viewer__empty" data-testid="right-dock-files-empty">
              {t("fileViewer.selectAFile", "Select a file")}
            </div>
          ) : contentLoading ? (
            <div className="dock-files-viewer__status">{t("common.loading", "Loading...")}</div>
          ) : contentError ? (
            <div className="dock-files-viewer__status dock-files-viewer__status--error">{contentError}</div>
          ) : (
            <FileEditor content={content} onChange={() => {}} readOnly filePath={selectedFile} />
          )}
        </div>
      </div>
    </div>
  );
}
