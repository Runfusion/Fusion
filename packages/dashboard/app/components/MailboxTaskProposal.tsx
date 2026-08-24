import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MessageMetadata } from "@fusion/core";
import { createProposedTask } from "../api";
import "./MailboxTaskProposal.css";

export function MailboxTaskProposal({ messageId, metadata, projectId, onOpenTask, onCreated }: { messageId: string; metadata?: MessageMetadata; projectId?: string; onOpenTask?: (id: string) => void; onCreated?: () => void }) {
  const { t } = useTranslation("app");
  const [creating, setCreating] = useState(false);
  const [currentMetadata, setCurrentMetadata] = useState(metadata);
  useEffect(() => setCurrentMetadata(metadata), [metadata]);
  if (currentMetadata?.kind !== "task-proposal" || !currentMetadata.proposedTask) return null;
  const proposal = currentMetadata.proposedTask;
  const status = currentMetadata.proposalStatus ?? "pending";

  const create = async () => {
    setCreating(true);
    try {
      const response = await createProposedTask(messageId, projectId);
      // FNXC:EphemeralAgentTaskCreation 2026-07-30-13:00: apply the finalized response immediately so a stale mailbox list cannot offer a duplicate create click before SSE refreshes it.
      setCurrentMetadata(response.proposal.metadata);
      onCreated?.();
    } finally {
      setCreating(false);
    }
  };

  return <section className="mailbox-task-proposal" data-testid="mailbox-task-proposal">
    <strong>{proposal.title}</strong><p>{proposal.description}</p>
    {status === "pending" && <button type="button" className="btn" disabled={creating} onClick={() => void create()}>{creating ? t("mailbox.creatingTask", "Creating task…") : t("mailbox.createTask", "Create task")}</button>}
    {status === "creating" && <button type="button" className="btn" disabled>{t("mailbox.creatingTask", "Creating task…")}</button>}
    {status === "created" && currentMetadata.createdTaskId && <button type="button" className="btn" onClick={() => onOpenTask?.(currentMetadata.createdTaskId!)}>{t("mailbox.taskCreatedView", "Task {{id}} created — View task", { id: currentMetadata.createdTaskId })}</button>}
    {status === "dismissed" && <span>{t("mailbox.taskProposalDismissed", "Task proposal dismissed")}</span>}
  </section>;
}
