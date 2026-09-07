import "./RecommendationsView.css";
import { useEffect, useRef } from "react";
import { AlertCircle, ExternalLink, Lightbulb } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTaskRecommendations } from "../hooks/useTaskRecommendations";
import type { ToastType } from "../hooks/useToast";
import { LoadingSpinner } from "./LoadingSpinner";
import { ViewHeader } from "./ViewHeader";
import { useAutoPaginationSentinel } from "../hooks/useAutoPaginationSentinel";

export interface RecommendationsViewProps {
  projectId?: string;
  addToast?: (message: string, type?: ToastType) => void;
  onOpenTask?: (taskId: string) => void;
  unreadCount?: number;
  onSeen?: () => void;
}

/*
FNXC:RecommendationsView 2026-09-06-03:16:
Task recommendations have a dedicated navigation destination instead of appearing in the ordinary inbox. The screen keeps source-task identity, creation recovery, pagination, truncation, and linked-task access together so moving notices never makes their actions inaccessible.

FNXC:RecommendationsView 2026-09-06-03:16:
MainContent does not remount this view when projectId changes. Store the signalled project inside a nullable latch so undefined is a legitimate project value, repeated renders stay idempotent, and each newly selected project can clear its own unread badge once.
*/
export function RecommendationsView({
  projectId,
  onOpenTask,
  unreadCount = 0,
  onSeen,
}: RecommendationsViewProps) {
  const { t } = useTranslation("app");
  const recommendations = useTaskRecommendations(projectId);
  const seenProjectRef = useRef<{ projectId: string | undefined } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pagination = useAutoPaginationSentinel({ rootRef: bodyRef, hasMore: recommendations.hasMore && !recommendations.truncated, loading: recommendations.loadingMore, onLoadMore: recommendations.loadMore, direction: "end" });

  useEffect(() => {
    if (
      unreadCount > 0
      && (seenProjectRef.current === null || seenProjectRef.current.projectId !== projectId)
    ) {
      seenProjectRef.current = { projectId };
      onSeen?.();
    }
  }, [onSeen, projectId, unreadCount]);

  return (
    <section className="recommendations-view" data-testid="recommendations-view" aria-labelledby="recommendations-view-title">
      <ViewHeader
        icon={Lightbulb}
        title={t("recommendations.title", "Recommendations")}
        titleId="recommendations-view-title"
        actions={(
          <span className="recommendations-view__count" data-testid="recommendations-count">
            {t("recommendations.count", "Showing {{shown}} of {{total}} source tasks", {
              shown: recommendations.items.length,
              total: recommendations.totalRowCount,
            })}
          </span>
        )}
      />

      <div className="recommendations-view__body" ref={bodyRef}>
        {recommendations.loading && recommendations.items.length === 0 ? (
          <div className="recommendations-view__state" data-testid="recommendations-loading">
            <LoadingSpinner label={t("recommendations.loading", "Loading recommendations…")} />
          </div>
        ) : null}

        {!recommendations.loading && !recommendations.error && recommendations.items.length === 0 ? (
          <div className="recommendations-view__state" data-testid="recommendations-empty">
            <Lightbulb aria-hidden="true" />
            <h3>{t("recommendations.emptyTitle", "No recommendations yet")}</h3>
            <p>{t("recommendations.emptyDescription", "Recommendations from completed tasks will appear here.")}</p>
          </div>
        ) : null}

        {recommendations.items.length > 0 ? (
          <ul className="recommendations-view__list">
            {recommendations.items.map((item) => {
              const key = `${item.taskId}:${item.recommendation.id}`;
              const action = recommendations.createStates.get(key);
              const createdTaskId = item.recommendation.createdTaskId;
              return (
                <li className="card recommendations-view__item" key={key} data-testid={`task-recommendation-${key}`}>
                  <div className="recommendations-view__item-header">
                    <h3>{item.recommendation.title}</h3>
                    <span className="recommendations-view__category">{item.recommendation.category}</span>
                  </div>
                  <p className="recommendations-view__description">{item.recommendation.description}</p>
                  <p className="recommendations-view__source">
                    {t("recommendations.source", "Source: {{task}}", {
                      task: item.taskTitle ? `${item.taskId} — ${item.taskTitle}` : item.taskId,
                    })}
                  </p>
                  <div className="recommendations-view__actions">
                    {createdTaskId ? (
                      <>
                        <span role="status">
                          {t("recommendations.created", "Created {{taskId}}", { taskId: createdTaskId })}
                        </span>
                        {onOpenTask ? (
                          <button className="btn" type="button" onClick={() => onOpenTask(createdTaskId)}>
                            <ExternalLink aria-hidden="true" />
                            {t("recommendations.viewTask", "View task")}
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <button
                          className="btn btn-primary"
                          type="button"
                          disabled={action?.running}
                          onClick={() => void recommendations.createTask(item.taskId, item.recommendation.id)}
                        >
                          {action?.running
                            ? t("recommendations.creating", "Creating…")
                            : action?.error
                              ? t("recommendations.retryCreate", "Retry creating task")
                              : t("recommendations.createTask", "Create task")}
                        </button>
                        {action?.error ? (
                          <span className="recommendations-view__error" role="status">
                            <AlertCircle aria-hidden="true" />
                            {t("recommendations.createError", "Could not create task. Try again.")}
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}

        {recommendations.truncated ? (
          <p className="recommendations-view__notice" role="status">
            {t("recommendations.truncated", "Showing the first 20 pages. Refresh to see the latest recommendations.")}
          </p>
        ) : recommendations.hasMore ? (
          <div ref={pagination.sentinelRef} className="recommendations-view__load-more" role="status" aria-live="polite" data-testid="recommendations-auto-pagination-sentinel">
            {recommendations.loadingMore ? t("recommendations.loadingMore", "Loading more…") : null}
          </div>
        ) : null}

        {recommendations.error && !recommendations.loading ? (
          <div className="recommendations-view__error-panel" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>{t("recommendations.loadError", "Could not load recommendations.")}</span>
            <button
              className="btn"
              type="button"
              onClick={() => void (recommendations.hasMore ? recommendations.loadMore() : recommendations.refresh())}
            >
              {t("actions.retry", "Retry")}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
