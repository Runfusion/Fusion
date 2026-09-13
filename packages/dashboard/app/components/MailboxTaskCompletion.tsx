import { useTranslation } from "react-i18next";
import type { MessageMetadata } from "@fusion/core";
import { MailboxArtifactAttachment } from "./MailboxArtifactAttachment";
import { MailboxMessageContent } from "./MailboxMessageContent";
import { MailboxRelatedWorkLink } from "./MailboxRelatedWorkLink";
import { MailboxTaskRecommendations } from "./MailboxTaskRecommendations";
import "./MailboxTaskCompletion.css";

type CompletionMetadata = MessageMetadata & {
  kind: "task-completion-notice";
  taskId?: unknown;
  imageArtifactIds?: unknown;
  recommendationIds?: unknown;
};

export function isTaskCompletionNotice(metadata?: MessageMetadata): metadata is CompletionMetadata {
  return metadata?.kind === "task-completion-notice";
}

function imageIds(metadata: CompletionMetadata): string[] {
  if (!Array.isArray(metadata.imageArtifactIds)) return [];
  return [...new Set(metadata.imageArtifactIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
}

function hasRecommendationIds(metadata: CompletionMetadata): boolean {
  return Array.isArray(metadata.recommendationIds)
    && metadata.recommendationIds.some((id) => typeof id === "string" && id.trim().length > 0);
}

/**
 * FNXC:MailboxTaskCompletion 2026-09-13-03:42:
 * A completion notice is one visual mail: its persisted heading and summary, suggested recommendations
 * (or an explicit empty state), optional images, and one source-task action share this component in
 * every host. Only image identifiers are embedded; other task outputs remain in Task Detail.
 */
export function MailboxTaskCompletion({
  content,
  metadata,
  projectId,
  onOpenTask,
}: {
  content: string;
  metadata?: MessageMetadata;
  projectId?: string;
  onOpenTask?: (taskId: string) => void;
}) {
  const { t } = useTranslation("app");
  if (!isTaskCompletionNotice(metadata)) return null;
  const ids = imageIds(metadata);

  return (
    <section className="mailbox-task-completion" data-testid="mailbox-task-completion" aria-label={t("mailbox.taskCompletion", "Task completion")}>
      <MailboxMessageContent content={content} className="mailbox-task-completion__summary" onOpenTask={onOpenTask} />
      <section className="mailbox-task-completion__recommendations" aria-label={t("mailbox.suggestedRecommendations", "Suggested recommendations")}>
        <h3>{t("mailbox.suggestedRecommendations", "Suggested recommendations")}</h3>
        {hasRecommendationIds(metadata)
          ? <MailboxTaskRecommendations metadata={metadata} projectId={projectId} onOpenTask={onOpenTask} />
          : <p className="mailbox-task-completion__empty" data-testid="mailbox-task-completion-no-recommendations">{t("mailbox.noSuggestedRecommendations", "No follow-up recommendations were suggested.")}</p>}
      </section>
      {ids.length > 0 && (
        <div className="mailbox-task-completion__images" aria-label={t("mailbox.completionImages", "Completion images")}>
          {ids.map((artifactId) => (
            <MailboxArtifactAttachment
              key={artifactId}
              artifactId={artifactId}
              artifactType="image"
              projectId={projectId}
              title={t("mailbox.completionImage", "Completion image")}
              hideTaskLink
            />
          ))}
        </div>
      )}
      <MailboxRelatedWorkLink metadata={metadata} onOpenTask={onOpenTask} />
    </section>
  );
}
