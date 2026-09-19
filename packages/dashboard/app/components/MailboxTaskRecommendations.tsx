import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MessageMetadata, TaskRecommendation } from "@fusion/core";
import { createTaskFromRecommendation, fetchTaskDetail } from "../api";
import "./MailboxTaskRecommendations.css";

type TaskRecommendationNoticeMetadata = MessageMetadata & {
  taskId?: string;
  recommendationIds?: unknown;
};

type NoticeTarget = {
  taskId: string;
  recommendationIds?: string[];
};

function getNoticeTarget(metadata?: MessageMetadata): NoticeTarget | null {
  if (metadata?.kind !== "task-recommendation-notice") return null;
  const notice = metadata as TaskRecommendationNoticeMetadata;
  const taskId = notice.taskId?.trim();
  if (!taskId) return null;

  /*
  FNXC:TaskRecommendations 2026-09-19-21:21:
  Historical notices predate stable recommendation IDs, so only an absent field may resolve the
  parent's current live rows. Present IDs are an authoritative modern notice filter: empty or
  malformed values must remain inert rather than exposing recommendations the notice did not name.
  */
  if (!("recommendationIds" in notice)) return { taskId };
  if (!Array.isArray(notice.recommendationIds) || notice.recommendationIds.length === 0) return null;
  const ids = notice.recommendationIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  return ids.length > 0 ? { taskId, recommendationIds: ids } : null;
}

export function MailboxTaskRecommendations({
  metadata,
  projectId,
  onOpenTask,
}: {
  metadata?: MessageMetadata;
  projectId?: string;
  onOpenTask?: (taskId: string) => void;
}) {
  const { t } = useTranslation("app");
  const target = getNoticeTarget(metadata);
  const [recommendations, setRecommendations] = useState<TaskRecommendation[] | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<"task-unavailable" | "recommendations-missing" | null>(null);
  const [createdIds, setCreatedIds] = useState<Record<string, string>>({});
  const [creatingActions, setCreatingActions] = useState<Record<string, true>>({});
  const [errorActions, setErrorActions] = useState<Record<string, true>>({});
  const creatingIdsRef = useRef(new Set<string>());

  const taskId = target?.taskId;
  const recommendationIds = target?.recommendationIds;
  const recommendationIdsKey = recommendationIds?.join("\u0000") ?? "legacy";

  useEffect(() => {
    let active = true;
    creatingIdsRef.current.clear();
    setRecommendations(null);
    setUnavailableReason(null);
    setCreatedIds({});
    setCreatingActions({});
    setErrorActions({});
    if (!taskId) return () => { active = false; };

    /*
    FNXC:TaskRecommendations 2026-08-15-22:39:
    Mailbox metadata deliberately contains only durable identifiers, counts, and categories; resolve
    live recommendation prose and link state from the parent task so notices never copy operator text
    into metadata or offer stale creates after a task has already been linked.
    */
    void fetchTaskDetail(taskId, projectId).then((task) => {
      if (!active) return;
      const allowedIds = recommendationIds ? new Set(recommendationIds) : null;
      const matched = (task.recommendations ?? []).filter((recommendation) => !allowedIds || allowedIds.has(recommendation.id));
      setRecommendations(matched);
      /*
      FNXC:TaskRecommendations 2026-09-04-13:58:
      Operators need to know whether a stale mailbox notice lost its parent task or only lost the
      referenced recommendation ids after a completion retry rewrote the task's proposal list.
      */
      setUnavailableReason(matched.length === 0 ? "recommendations-missing" : null);
    }).catch(() => {
      if (!active) return;
      setUnavailableReason("task-unavailable");
    });
    return () => { active = false; };
  }, [projectId, recommendationIdsKey, taskId]);

  if (!target) return null;

  const createRecommendation = async (recommendation: TaskRecommendation) => {
    const actionKey = `${target.taskId}:${recommendation.id}`;
    if (creatingIdsRef.current.has(actionKey) || recommendation.createdTaskId || createdIds[actionKey]) return;
    /*
    FNXC:TaskRecommendations 2026-08-15-22:39:
    Recommendation creation stays behind the server's idempotent completed-task guard. The per-parent
    action key prevents rapid duplicate mailbox clicks while allowing different recommendations to act independently.
    */
    creatingIdsRef.current.add(actionKey);
    setCreatingActions((current) => ({ ...current, [actionKey]: true }));
    setErrorActions((current) => {
      const { [actionKey]: _cleared, ...remaining } = current;
      return remaining;
    });
    try {
      const response = await createTaskFromRecommendation(target.taskId, recommendation.id, projectId);
      setCreatedIds((current) => ({ ...current, [actionKey]: response.task.id }));
    } catch {
      setErrorActions((current) => ({ ...current, [actionKey]: true }));
    } finally {
      creatingIdsRef.current.delete(actionKey);
      setCreatingActions((current) => {
        const { [actionKey]: _cleared, ...remaining } = current;
        return remaining;
      });
    }
  };

  if (unavailableReason) {
    const reason = unavailableReason === "task-unavailable"
      ? t("mailbox.recommendationsUnavailableTaskReason", "The source task can no longer be loaded. It may have been deleted or moved out of this project.")
      : recommendationIds
        ? t("mailbox.recommendationsUnavailableIdsReason", "The source task no longer contains the recommendation IDs from this message. A later completion retry may have replaced them.")
        : t("mailbox.recommendationsUnavailableLegacyReason", "The source task has no live recommendations available from this historical message.");
    return <p className="mailbox-task-recommendations__unavailable" data-testid="mailbox-task-recommendations-unavailable">{t("mailbox.recommendationsUnavailable", "Recommendations are no longer available.")} <span>{reason}</span></p>;
  }
  if (!recommendations) return null;

  return <section className="mailbox-task-recommendations" data-testid="mailbox-task-recommendations" aria-label={t("mailbox.taskRecommendations", "Task recommendations")}>
    {recommendations.map((recommendation) => {
      const actionKey = `${target.taskId}:${recommendation.id}`;
      const createdTaskId = recommendation.createdTaskId ?? createdIds[actionKey];
      const creating = creatingActions[actionKey] === true;
      const failed = errorActions[actionKey] === true;
      /*
      FNXC:MailboxTaskCards 2026-09-01-05:06:
      The board `.card` primitive imposes raw-pixel padding, hover repaint, container sizing, and
      non-selectable text that are wrong for a mail reading surface; this card owns its tokenized treatment.
      */
      return <article className="mailbox-task-recommendations__item" key={recommendation.id}>
        <div className="mailbox-task-recommendations__content">
          <div className="mailbox-task-recommendations__heading"><h3>{recommendation.title}</h3><span>{recommendation.category}</span></div>
          <p>{recommendation.description}</p>
        </div>
        {createdTaskId ? (
          <button type="button" className="btn btn-primary" onClick={() => onOpenTask?.(createdTaskId)}>{t("mailbox.viewTask", "View task {{id}}", { id: createdTaskId })}</button>
        ) : (
          <div className="mailbox-task-recommendations__action">
            <button type="button" className="btn btn-primary" disabled={creating} onClick={() => void createRecommendation(recommendation)}>
              {creating ? t("mailbox.creatingTask", "Creating…") : failed ? t("mailbox.retryCreatingTask", "Retry creating task") : t("mailbox.createTask", "Create task")}
            </button>
            {failed && <span className="mailbox-task-recommendations__error" role="status">{t("mailbox.createTaskError", "Could not create task. Try again.")}</span>}
          </div>
        )}
      </article>;
    })}
  </section>;
}
