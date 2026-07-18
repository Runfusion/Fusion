import { useEffect, useState } from "react";
import type { MessageMetadata } from "@fusion/core";
import { createProposedTask } from "../api";
import "./MailboxTaskProposal.css";

export function MailboxTaskProposal({ messageId, metadata, projectId, onOpenTask, onCreated }: { messageId: string; metadata?: MessageMetadata; projectId?: string; onOpenTask?: (id: string) => void; onCreated?: () => void }) {
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
    {status === "pending" && <button type="button" className="btn" disabled={creating} onClick={() => void create()}>{creating ? "Creating task…" : "Create task"}</button>}
    {status === "creating" && <button type="button" className="btn" disabled>Creating task…</button>}
    {status === "created" && currentMetadata.createdTaskId && <button type="button" className="btn" onClick={() => onOpenTask?.(currentMetadata.createdTaskId!)}>Task {currentMetadata.createdTaskId} created — View task</button>}
    {status === "dismissed" && <span>Task proposal dismissed</span>}
  </section>;
}
