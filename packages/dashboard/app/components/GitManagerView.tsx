import { useTranslation } from "react-i18next";
import { FolderGit2 } from "lucide-react";
import type { Task } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { ViewHeader } from "./ViewHeader";
import { ViewLayout } from "./ViewLayout";
import { GitManagerModal, type SectionId } from "./GitManagerModal";
import "./GitManagerView.css";

export interface GitManagerViewProps {
  projectId?: string;
  tasks?: Task[];
  addToast: (message: string, type?: ToastType) => void;
  /** Landing section; `pull-requests` is how an old Pull Requests link or entry point arrives. */
  initialSection?: SectionId;
  /** Linked pull-request entity id, forwarded to the reused PullRequestView. */
  selectedPullRequestId?: string;
}

/*
FNXC:ToolSurfaces 2026-09-15-16:04:
FN-426 gives Git Manager a real page so it no longer depends on the right dock. This host owns ONLY the page chrome:
the Git operations, sections, repository selector, and Pull Requests section all come from the single existing
`GitManagerModal` body rendered in its `presentation="embedded"` mode. Nothing is duplicated, and because the embedded
body renders no overlay, no floating window, and no close control, the page frames exactly one header with no fake
"close" affordance — a page is left by navigating, not by dismissing it.
*/
export function GitManagerView({ projectId, tasks, addToast, initialSection, selectedPullRequestId }: GitManagerViewProps) {
  const { t } = useTranslation("app");
  return (
    <ViewLayout
      className="git-manager-view"
      data-testid="git-manager-view"
      contentOwnsScroll
      header={<ViewHeader icon={FolderGit2} title={t("git.modalTitle", "Git Manager")} titleTestId="git-manager-view-title" />}
    >
      <GitManagerModal
        isOpen
        onClose={() => undefined}
        tasks={tasks ?? []}
        addToast={addToast}
        projectId={projectId}
        presentation="embedded"
        initialSection={initialSection}
        selectedPullRequestId={selectedPullRequestId}
      />
    </ViewLayout>
  );
}

export default GitManagerView;
