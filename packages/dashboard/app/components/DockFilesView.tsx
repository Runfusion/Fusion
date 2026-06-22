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
}

/*
FNXC:RightDockFiles 2026-06-22-00:00:
The right-dock Files tool opens a clicked file INLINE inside the dock as a read-only viewer instead of immediately launching the resizable/movable FileBrowserModal.
Clicking a file in the tree sets local `selectedFile` (it does NOT call `openFile`); the inline viewer reuses the read-only `FileEditor` so markdown previews and syntax highlighting match the rest of the app.
The viewer header carries a BACK button (clears `selectedFile`, returning to the tree) and a POP-OUT button that calls `openFile(path, { workspace: "project" })` to escalate to the existing resizable/movable modal. This preserves the modal path; it is now opt-in via pop-out rather than the default click behavior.
*/
export function DockFilesView({ projectId, openFile }: DockFilesViewProps) {
  const { t } = useTranslation("app");
  const { entries, currentPath, setPath, loading, error, refresh } = useWorkspaceFileBrowser("project", true, projectId);

  // FNXC:RightDockFiles — selected file drives the inline read-only viewer; null returns to the tree.
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

  if (selectedFile) {
    const fileName = selectedFile.split("/").pop() || selectedFile;
    return (
      <div className="dock-files-view dock-files-view--viewer" data-testid="right-dock-files-view">
        <div className="dock-files-viewer__header">
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
          <span className="dock-files-viewer__title" title={selectedFile}>{fileName}</span>
          <button
            type="button"
            className="btn btn-sm btn-icon dock-files-viewer__popout"
            onClick={handlePopOut}
            aria-label={t("fileViewer.popOut", "Open in resizable window")}
            title={t("fileViewer.popOut", "Open in resizable window")}
            data-testid="right-dock-files-popout"
          >
            <Maximize2 size={14} />
          </button>
        </div>
        <div className="dock-files-viewer__body">
          {contentLoading ? (
            <div className="dock-files-viewer__status">{t("common.loading", "Loading...")}</div>
          ) : contentError ? (
            <div className="dock-files-viewer__status dock-files-viewer__status--error">{contentError}</div>
          ) : (
            <FileEditor content={content} onChange={() => {}} readOnly filePath={selectedFile} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="dock-files-view" data-testid="right-dock-files-view">
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
  );
}
