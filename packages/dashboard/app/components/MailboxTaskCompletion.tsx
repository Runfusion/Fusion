import { useTranslation } from "react-i18next";
import type { MessageMetadata } from "@fusion/core";
import { MailboxArtifactAttachment } from "./MailboxArtifactAttachment";
import { MailboxRelatedWorkLink } from "./MailboxRelatedWorkLink";
import { MailboxTaskRecommendations } from "./MailboxTaskRecommendations";
import "./MailboxTaskCompletion.css";

type CompletionMetadata = MessageMetadata & {
  kind: "task-completion-notice";
  taskId?: unknown;
  imageArtifactIds?: unknown;
};

export function isTaskCompletionNotice(metadata?: MessageMetadata): metadata is CompletionMetadata {
  return metadata?.kind === "task-completion-notice";
}

function imageIds(metadata: CompletionMetadata): string[] {
  if (!Array.isArray(metadata.imageArtifactIds)) return [];
  return [...new Set(metadata.imageArtifactIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
}

/**
 * FNXC:MailboxTaskCompletion 2026-09-09-19:59:
 * Completion mail embeds only image artifact identifiers; plans, documents, audio, video, and other
 * task outputs remain in Task Detail. Shared artifact, recommendation, and related-work controls keep
 * authenticated media and task actions identical in selected-message and conversation hosts.
 */
export function MailboxTaskCompletion({
  metadata,
  projectId,
  onOpenTask,
}: {
  metadata?: MessageMetadata;
  projectId?: string;
  onOpenTask?: (taskId: string) => void;
}) {
  const { t } = useTranslation("app");
  if (!isTaskCompletionNotice(metadata)) return null;
  const ids = imageIds(metadata);

  return (
    <section className="mailbox-task-completion" data-testid="mailbox-task-completion" aria-label={t("mailbox.taskCompletion", "Task completion")}>
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
      <MailboxTaskRecommendations metadata={metadata} projectId={projectId} onOpenTask={onOpenTask} />
      <MailboxRelatedWorkLink metadata={metadata} onOpenTask={onOpenTask} />
    </section>
  );
}
