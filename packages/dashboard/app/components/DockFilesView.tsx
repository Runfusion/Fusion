import { useCallback } from "react";
import type { PluginDashboardViewContext } from "../plugins/types";
import { useWorkspaceFileBrowser } from "../hooks/useWorkspaceFileBrowser";
import { FileBrowser } from "./FileBrowser";
import "./DockFilesView.css";

interface DockFilesViewProps {
  projectId?: string;
  openFile?: PluginDashboardViewContext["openFile"];
}

/*
FNXC:RightDockFiles 2026-09-12-04:06:
Le dock Files reste une liste et délègue chaque fichier, texte ou binaire, au FileBrowserModal partagé via openFile. Il ne possède plus de sélection, contenu, sauvegarde, preview, navigation Back ni synchronisation storage; la même frontière s’applique au dock compact et à son hôte étendu.
*/
export function DockFilesView({ projectId, openFile }: DockFilesViewProps) {
  const { entries, currentPath, setPath, loading, error, refresh } = useWorkspaceFileBrowser("project", true, projectId);
  const handleSelectFile = useCallback((path: string) => {
    openFile?.(path, { workspace: "project" });
  }, [openFile]);

  return (
    <div className="dock-files-view" data-testid="right-dock-files-view">
      <FileBrowser
        entries={entries}
        currentPath={currentPath}
        onSelectFile={handleSelectFile}
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
  );
}
