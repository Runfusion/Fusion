import { useTranslation } from "react-i18next";
import type { MessageMetadata } from "@fusion/core";

export interface MailboxRelatedWorkLinkProps {
  metadata?: MessageMetadata;
  onOpenTask?: (taskId: string) => void;
  onOpenPlanningSession?: (sessionId: string) => void;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function hasRelatedTaskLink(metadata: MessageMetadata | undefined, onOpenTask: MailboxRelatedWorkLinkProps["onOpenTask"]): boolean {
  return Boolean(readNonEmptyString(metadata?.taskId) && onOpenTask);
}

/**
 * FNXC:MailboxRelatedWork 2026-07-20-09:30:
 * FN-8428 requires every response-needed mailbox message to provide a first-class route back to
 * its task or planning session. Task metadata wins when both targets are present, and missing
 * metadata or navigation handlers deliberately render no button so the detail never contains a
 * dead affordance.
 */
export function MailboxRelatedWorkLink({
  metadata,
  onOpenTask,
  onOpenPlanningSession,
}: MailboxRelatedWorkLinkProps) {
  const { t } = useTranslation("app");
  const taskId = readNonEmptyString(metadata?.taskId);
  const sessionId = readNonEmptyString(metadata?.sessionId);

  if (taskId && onOpenTask) {
    return (
      <button
        type="button"
        className="btn mailbox-related-work-link"
        aria-label={t("mailbox.viewTaskAria", "View task: {{taskId}}", { taskId })}
        data-testid="mailbox-view-task"
        onClick={() => onOpenTask(taskId)}
      >
        {t("mailbox.viewTask", "View task")}
      </button>
    );
  }

  if (metadata?.kind === "planning-clarification" && sessionId && onOpenPlanningSession) {
    return (
      <button
        type="button"
        className="btn mailbox-related-work-link"
        aria-label={t("mailbox.openPlanningSessionAria", "Open planning session: {{sessionId}}", { sessionId })}
        data-testid="mailbox-open-planning-session"
        onClick={() => onOpenPlanningSession(sessionId)}
      >
        {t("mailbox.openPlanningSession", "Open planning session")}
      </button>
    );
  }

  return null;
}
