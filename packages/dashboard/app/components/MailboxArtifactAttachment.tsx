import { memo, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ArtifactType } from "@fusion/core";
import { artifactMediaUrlWithToken } from "../api";
import { ArtifactImage, ArtifactImageViewer } from "./ArtifactImageViewer";

export interface MailboxArtifactAttachmentProps {
  artifactId?: unknown;
  artifactType?: unknown;
  title?: unknown;
  mimeType?: unknown;
  projectId?: string;
  taskId?: unknown;
  onOpenTask?: (taskId: string) => void;
  /** The shared related-work control already renders this message's task link. */
  hideTaskLink?: boolean;
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
 * Artifact-registration mail messages must expose the artifact announced by message.metadata. Render image artifacts inline, keep every type reachable through the authenticated project-aware media URL, and render nothing when metadata has no artifactId so ordinary messages keep their exact layout.
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
  hideTaskLink = false,
}: MailboxArtifactAttachmentProps) {
  const { t } = useTranslation("app");
  const id = readString(artifactId);
  const type = readArtifactType(artifactType);
  const label = readString(title) ?? t("mailbox.artifact", "artifact");
  const mediaMimeType = readString(mimeType);
  const task = readString(taskId);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageViewerOpen, setImageViewerOpen] = useState(false);
  const mediaUrl = useMemo(() => id && type !== "image" ? artifactMediaUrlWithToken(id, projectId) : "", [id, projectId, type]);

  if (!id) return null;

  const openLink = type === "image" ? (
    <button type="button" className="mailbox-artifact-attachment__link btn" onClick={() => setImageViewerOpen(true)} aria-label={t("mailbox.openArtifactAria", "Open artifact: {{label}}", { label })}>
      {t("mailbox.openArtifact", "Open artifact")}
    </button>
  ) : (
    <a className="mailbox-artifact-attachment__link btn" href={mediaUrl} target="_blank" rel="noreferrer" aria-label={t("mailbox.openArtifactAria", "Open artifact: {{label}}", { label })}>
      {t("mailbox.openArtifact", "Open artifact")}
    </a>
  );
  const taskLink = task && onOpenTask && !hideTaskLink ? (
    <button
      type="button"
      className="mailbox-artifact-attachment__link btn"
      aria-label={t("mailbox.viewTaskAria", "View task: {{id}}", { id: task })}
      data-testid="mailbox-artifact-view-task"
      onClick={() => onOpenTask(task)}
    >
      {t("mailbox.viewTaskLabel", "View task")}
    </button>
  ) : null;

  let preview: ReactNode = null;
  if (type === "image" && !imageFailed) {
    preview = (
      <button type="button" className="mailbox-artifact-attachment__image-button" onClick={() => setImageViewerOpen(true)} aria-label={t("mailbox.openArtifactAria", "Open artifact: {{label}}", { label })}>
        <ArtifactImage className="mailbox-artifact-attachment__media mailbox-artifact-attachment__image" artifactId={id} projectId={projectId} title={label} onError={() => setImageFailed(true)} />
      </button>
    );
  } else if (type === "video") {
    preview = (
      <video
        className="mailbox-artifact-attachment__media"
        src={mediaUrl}
        controls
        aria-label={t("mailbox.videoArtifactAria", "Video artifact: {{label}}", { label })}
      />
    );
  } else if (type === "audio") {
    preview = (
      <audio
        className="mailbox-artifact-attachment__audio"
        src={mediaUrl}
        controls
        aria-label={t("mailbox.audioArtifactAria", "Audio artifact: {{label}}", { label })}
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
      {imageViewerOpen && type === "image" && <ArtifactImageViewer artifactId={id} projectId={projectId} title={label} onClose={() => setImageViewerOpen(false)} />}
    </div>
  );
});
