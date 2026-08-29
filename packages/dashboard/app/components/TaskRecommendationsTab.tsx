import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskRecommendation } from "@fusion/core";
import { createTaskFromRecommendation } from "../api";
import "./TaskRecommendationsTab.css";

export function TaskRecommendationsTab({
  task,
  projectId,
  onTaskReconciled,
}: {
  task: Task;
  projectId?: string;
  /** The route's parent snapshot is authoritative after a durable link mutation. */
  onTaskReconciled?: (task: Task) => void;
}) {
  const { t } = useTranslation("app");
  const [createdIds, setCreatedIds] = useState<Record<string, string>>({});
  const creatingIdsRef = useRef(new Set<string>());
  const taskIdRef = useRef(task.id);
  const [creatingActions, setCreatingActions] = useState<Record<string, true>>({});
  const [errorActions, setErrorActions] = useState<Record<string, true>>({});
  const recommendations = task.recommendations ?? [];

  useEffect(() => {
    /*
    FNXC:TaskRecommendations 2026-08-08-06:11:
    TaskDetailContent is retained while operators switch cards. Creation state belongs to the
    recommendation's parent, so clear it before rendering a new task and fence late responses from
    the former task; otherwise a matching recommendation ID can falsely show Created on the new card.
    */
    taskIdRef.current = task.id;
    creatingIdsRef.current.clear();
    setCreatedIds({});
    setCreatingActions({});
    setErrorActions({});
  }, [task.id]);

  const createRecommendation = async (recommendation: TaskRecommendation) => {
    const actionKey = `${task.id}:${recommendation.id}`;
    if (creatingIdsRef.current.has(actionKey) || recommendation.createdTaskId || createdIds[actionKey]) return;
    /*
    FNXC:TaskRecommendations 2026-08-08-06:34:
    Creation is independently idempotent per recommendation. Key pending and retry state by both
    parent and recommendation so rapid duplicate clicks emit one request without hiding another
    recommendation's concurrent action state.
    */
    creatingIdsRef.current.add(actionKey);
    setCreatingActions((current) => ({ ...current, [actionKey]: true }));
    setErrorActions((current) => {
      const { [actionKey]: _cleared, ...remaining } = current;
      return remaining;
    });
    try {
      const response = await createTaskFromRecommendation(task.id, recommendation.id, projectId);
      /*
      FNXC:TaskRecommendations 2026-08-08-05:27:
      Creation changes the parent recommendation link, not merely this button. Reconcile the
      route's authoritative parent snapshot so every TaskDetailContent host and its board owner
      converge instead of leaving a stale second Create action after a refresh or remount.
      */
      onTaskReconciled?.(response.parent);
      if (taskIdRef.current === task.id) {
        setCreatedIds((current) => ({ ...current, [actionKey]: response.task.id }));
      }
    } catch {
      if (taskIdRef.current === task.id) setErrorActions((current) => ({ ...current, [actionKey]: true }));
    } finally {
      creatingIdsRef.current.delete(actionKey);
      if (taskIdRef.current === task.id) {
        setCreatingActions((current) => {
          const { [actionKey]: _cleared, ...remaining } = current;
          return remaining;
        });
      }
    }
  };

  return (
    <section className="task-recommendations" aria-label={t("taskDetail.recommendations.title", "Recommendations")}>
      {recommendations.length === 0 ? (
        /* FNXC:TaskRecommendations 2026-08-12-23:01: TaskDetailModal content-gates this tab, so this empty branch is unreachable by default and only defends an already-open tab whose resolved snapshot empties. */
        <p className="task-recommendations__empty">{t("taskDetail.recommendations.empty", "No recommendations were produced for this task.")}</p>
      ) : recommendations.map((recommendation) => {
        /*
        FNXC:TaskRecommendations 2026-08-08-07:10:
        Effects reset retained-detail state only after React commits. Namespace transient action state by
        parent task so a synchronous card switch cannot briefly render a matching recommendation ID
        as Created, disabled, or failed before that cleanup runs.
        */
        const actionKey = `${task.id}:${recommendation.id}`;
        const createdTaskId = recommendation.createdTaskId ?? createdIds[actionKey];
        const creating = creatingActions[actionKey] === true;
        const failed = errorActions[actionKey] === true;
        return (
          <article className="task-recommendations__item card" key={recommendation.id}>
            <div className="task-recommendations__content">
              <div className="task-recommendations__heading">
                <h3>{recommendation.title}</h3>
                <span className="task-recommendations__category">{recommendation.category}</span>
              </div>
              <p>{recommendation.description}</p>
            </div>
            {createdTaskId ? (
              <span className="task-recommendations__created" role="status">
                {t("taskDetail.recommendations.created", "Created {{taskId}}", { taskId: createdTaskId })}
              </span>
            ) : (
              <div className="task-recommendations__action">
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={creating}
                  onClick={() => void createRecommendation(recommendation)}
                >
                  {creating
                    ? t("taskDetail.recommendations.creating", "Creating…")
                    : failed
                      ? t("taskDetail.recommendations.retry", "Retry creating task")
                      : t("taskDetail.recommendations.create", "Create task")}
                </button>
                {failed && <span className="task-recommendations__error" role="status">{t("taskDetail.recommendations.error", "Could not create task. Try again.")}</span>}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
