import { useTranslation } from "react-i18next";
import { Folder } from "lucide-react";
import type { PluginDashboardViewContext } from "../plugins/types";
import { ViewHeader } from "./ViewHeader";
import { ViewLayout } from "./ViewLayout";
import { DockFilesView } from "./DockFilesView";
import "./FilesView.css";

export interface FilesViewProps {
  projectId?: string;
  openFile?: PluginDashboardViewContext["openFile"];
}

/*
FNXC:ToolSurfaces 2026-09-15-16:04:
FN-426 gives the workspace file browser a real page so it no longer depends on the right dock. The browsing, path
state, refresh, and error/retry handling all remain in the single existing `DockFilesView` + `useWorkspaceFileBrowser`
pair; this host adds page chrome only.

The file-open contract is deliberately unchanged: both text and binary selections delegate to the shared `openFile`
seam and its FileBrowserModal, so the page never becomes a second editor owner.
*/
export function FilesView({ projectId, openFile }: FilesViewProps) {
  const { t } = useTranslation("app");
  return (
    <ViewLayout
      className="files-view"
      data-testid="files-view"
      contentOwnsScroll
      header={<ViewHeader icon={Folder} title={t("nav.files", "Files")} titleTestId="files-view-title" />}
    >
      <DockFilesView projectId={projectId} openFile={openFile} />
    </ViewLayout>
  );
}

export default FilesView;
