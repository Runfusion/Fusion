import { memo, useMemo, useState, type ReactNode } from "react";
import type { ArtifactType } from "@fusion/core";
import { artifactMediaUrl } from "../api";

export interface MailboxArtifactAttachmentProps {
  artifactId?: unknown;
  artifactType?: unknown;
  title?: unknown;
  mimeType?: unknown;
  projectId?: string;
  taskId?: unknown;
  onOpenTask?: (taskId: string) => void;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readArtifactType(value: unknown): ArtifactType | "unknown" {
  return value === "image" || value === "video" || value === "audio" || value === "document" || value === "other"
    ? value
    : "unknown";
}

/**
 * FNXC:ArtifactRegistry 2026-07-12-00:00:
 * Artifact-registration mail messages must expose the artifact announced by message.metadata. Render image artifacts inline, keep every type reachable through artifactMediaUrl(projectId-aware), and render nothing when metadata has no artifactId so ordinary messages keep their exact layout.
 *
 * FNXC:ArtifactRegistry 2026-07-12-00:00:
 * Artifact-registration mail messages must also expose the producing task when message.metadata.taskId is paired with an onOpenTask handler. Render no task affordance when either side is absent so artifact-only and ordinary messages do not gain empty shells.
 */
export const MailboxArtifactAttachment = memo(function MailboxArtifactAttachment({
  artifactId,
  artifactType,
  title,
  mimeType,
  projectId,
  taskId,
  onOpenTask,
}: MailboxArtifactAttachmentProps) {
  const id = readString(artifactId);
  const type = readArtifactType(artifactType);
  const label = readString(title) ?? "artifact";
  const mediaMimeType = readString(mimeType);
  const task = readString(taskId);
  const [imageFailed, setImageFailed] = useState(false);
  const mediaUrl = useMemo(() => id ? artifactMediaUrl(id, projectId) : "", [id, projectId]);

  if (!id) return null;

  const openLink = (
    <a
      className="mailbox-artifact-attachment__link btn"
      href={mediaUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open artifact: ${label}`}
    >
      Open artifact
    </a>
  );
  const taskLink = task && onOpenTask ? (
    <button
      type="button"
      className="mailbox-artifact-attachment__link btn"
      aria-label={`View task: ${task}`}
      data-testid="mailbox-artifact-view-task"
      onClick={() => onOpenTask(task)}
    >
      View task
    </button>
  ) : null;

  let preview: ReactNode = null;
  if (type === "image" && !imageFailed) {
    preview = (
      <img
        className="mailbox-artifact-attachment__media mailbox-artifact-attachment__image"
        src={mediaUrl}
        alt={label}
        loading="lazy"
        onError={() => setImageFailed(true)}
      />
    );
  } else if (type === "video") {
    preview = (
      <video
        className="mailbox-artifact-attachment__media"
        src={mediaUrl}
        controls
        aria-label={`Video artifact: ${label}`}
      />
    );
  } else if (type === "audio") {
    preview = (
      <audio
        className="mailbox-artifact-attachment__audio"
        src={mediaUrl}
        controls
        aria-label={`Audio artifact: ${label}`}
      />
    );
  }

  return (
    <div
      className="mailbox-artifact-attachment"
      data-testid="mailbox-artifact-attachment"
      data-artifact-type={type}
      data-artifact-mime-type={mediaMimeType}
    >
      <div className="mailbox-artifact-attachment__header">
        <span className="mailbox-artifact-attachment__title">{label}</span>
        <span className="mailbox-artifact-attachment__type">{type === "unknown" ? "artifact" : type}</span>
      </div>
      {preview}
      <div className="mailbox-artifact-attachment__actions">
        {openLink}
        {taskLink}
      </div>
    </div>
  );
});
