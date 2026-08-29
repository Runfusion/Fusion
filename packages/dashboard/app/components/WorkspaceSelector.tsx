import { useMemo, useState } from "react";
import { ChevronDown, FolderGit2, FolderRoot } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WorkspaceInfo } from "../hooks/useWorkspaces";
import "./WorkspaceSelector.css";

interface WorkspaceSelectorProps {
  currentWorkspace: string;
  projectName: string;
  workspaces: WorkspaceInfo[];
  onSelect: (workspace: string) => void;
}

function truncateTitle(title?: string, maxLength = 44): string | undefined {
  if (!title) return undefined;
  if (title.length <= maxLength) return title;
  return `${title.slice(0, maxLength - 1)}…`;
}

export function WorkspaceSelector({
  currentWorkspace,
  projectName,
  workspaces,
  onSelect,
}: WorkspaceSelectorProps) {
  const { t } = useTranslation("app");
  const [open, setOpen] = useState(false);
  const safeWorkspace = typeof currentWorkspace === "string" ? currentWorkspace : "project";

  const currentLabel = useMemo(() => {
    if (safeWorkspace === "project") {
      return projectName || t("workspace.projectRoot", "Project Root");
    }

    const match = workspaces.find((workspace) => workspace.id === safeWorkspace);
    return match?.label ?? safeWorkspace;
  }, [safeWorkspace, projectName, workspaces, t]);

  return (
    <div className="workspace-selector">
      <button
        type="button"
        className="workspace-selector-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {safeWorkspace === "project" ? <FolderRoot size={14} /> : <FolderGit2 size={14} />}
        <span className="workspace-selector-trigger-label">{currentLabel}</span>
        <ChevronDown size={14} className={`workspace-selector-trigger-icon${open ? " open" : ""}`} />
      </button>

      {open && (
        <div className="workspace-selector-menu" role="listbox" aria-label={t("workspace.selectWorkspace", "Select workspace")}>
          <button
            type="button"
            className={`workspace-selector-option${safeWorkspace === "project" ? " active" : ""}`}
            onClick={() => {
              onSelect("project");
              setOpen(false);
            }}
          >
            <div className="workspace-selector-option-main">
              <FolderRoot size={14} />
              <span>{t("workspace.projectRoot", "Project Root")}</span>
            </div>
            <span className="workspace-selector-option-meta">{projectName}</span>
          </button>

          {workspaces.length > 0 && (
            <div className="workspace-selector-group">
              <div className="workspace-selector-group-label">{t("workspace.taskWorktrees", "Task Worktrees")}</div>
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  className={`workspace-selector-option${safeWorkspace === workspace.id ? " active" : ""}`}
                  onClick={() => {
                    onSelect(workspace.id);
                    setOpen(false);
                  }}
                >
                  <div className="workspace-selector-option-main">
                    <FolderGit2 size={14} />
                    <span>{workspace.id}</span>
                  </div>
                  {workspace.title && (
                    <span className="workspace-selector-option-meta" title={workspace.title}>
                      {truncateTitle(workspace.title)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
