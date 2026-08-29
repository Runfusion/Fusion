import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { isReviewArtifact } from "@fusion/core";
import { ArtifactsGallery } from "../../ArtifactsGallery";
import { useArtifacts } from "../../../hooks/useArtifacts";
import type { ToastType } from "../../../hooks/useToast";
import { AreaShell } from "./AreaShell";

/*
FNXC:ReviewArtifacts 2026-07-17-12:00:
The Command Center Review artifacts panel is the cross-task deliverable surface.
It reuses the registry gallery for videos and MIME-marked live-demo descriptors;
ordinary documents remain hidden, and the descriptor stays a gallery document
rather than becoming a raw external-session link before FN-8290's renderer.
*/
export function ReviewArtifactsArea({ projectId, addToast = () => {} }: { projectId?: string; addToast?: (message: string, type?: ToastType) => void }) {
  const { t } = useTranslation("app");
  const { artifacts, loading, error } = useArtifacts({ projectId });
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(max-width: 768px)").matches === true);
  const reviewArtifacts = useMemo(() => artifacts.filter((artifact) => Boolean(artifact.taskId) && isReviewArtifact(artifact)), [artifacts]);
  /*
  FNXC:ReviewArtifacts 2026-07-18-19:25:
  The cross-task Command Center cannot open a task through this area, so omit
  ArtifactsGallery's task-link affordance rather than render an interactive
  control with a no-op callback. The task ID is retained above solely to limit
  this panel to deliverables registered for a task.
  */
  const galleryArtifacts = useMemo(() => reviewArtifacts.map(({ taskId: _taskId, taskTitle: _taskTitle, ...artifact }) => artifact), [reviewArtifacts]);

  useEffect(() => {
    const query = typeof window === "undefined" ? undefined : window.matchMedia?.("(max-width: 768px)");
    if (!query) return;
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return (
    <AreaShell
      testId="review-artifacts"
      isLoading={loading}
      error={error}
      isEmpty={reviewArtifacts.length === 0}
      emptyMessage={t("commandCenter.reviewArtifacts.empty", "No review artifacts are available yet.")}
    >
      <section aria-label={t("commandCenter.reviewArtifacts.title", "Review artifacts")}>
        <h3 className="cc-area-section-title">{t("commandCenter.reviewArtifacts.title", "Review artifacts")}</h3>
        <ArtifactsGallery
          artifacts={galleryArtifacts}
          projectId={projectId}
          isMobile={isMobile}
          addToast={addToast}
          onOpenTask={() => undefined}
        />
      </section>
    </AreaShell>
  );
}
