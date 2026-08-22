import { FileText, Package } from "lucide-react";
import type { TFunction } from "i18next";
import type { ArtifactType, ArtifactWithTask } from "@fusion/core";
import { ArtifactImage } from "./ArtifactImageViewer";

export function getArtifactTypeLabel(t: TFunction<"app">, type: ArtifactType): string {
  switch (type) {
    case "image":
      return t("documents.artifactTypeImage", "Image");
    case "video":
      return t("documents.artifactTypeVideo", "Video");
    case "audio":
      return t("documents.artifactTypeAudio", "Audio");
    case "document":
      return t("documents.artifactTypeDocument", "Document");
    case "other":
      return t("documents.artifactTypeOther", "Other");
  }
}

interface ArtifactMediaProps {
  artifact: Pick<ArtifactWithTask, "id" | "type">;
  mediaUrl: string;
  projectId?: string;
  title: string;
  preview?: string;
  t: TFunction<"app">;
}

/**
 * FNXC:ArtifactRegistry 2026-06-21-21:31:
 * The global Documents gallery and the per-task Artifacts tab must share one media renderer so image, video, audio, document, and generic artifact previews cannot drift across dashboard surfaces.
 */
export function ArtifactMedia({ artifact, mediaUrl, projectId, title, preview, t }: ArtifactMediaProps) {
  switch (artifact.type) {
    case "image":
      return <ArtifactImage className="documents-artifact-media" artifactId={artifact.id} projectId={projectId} title={title} />;
    case "video":
      return <video className="documents-artifact-media" controls src={mediaUrl} aria-label={t("documents.artifactVideoLabel", "Video artifact: {{title}}", { title })} />;
    case "audio":
      return <audio className="documents-artifact-audio" controls src={mediaUrl} aria-label={t("documents.artifactAudioLabel", "Audio artifact: {{title}}", { title })} />;
    case "document":
      return (
        <div className="documents-artifact-document" data-testid="artifact-document-preview">
          <FileText size={16} />
          <p>{preview || t("documents.noArtifactPreview", "No preview available.")}</p>
        </div>
      );
    case "other":
      return (
        <a className="documents-artifact-generic" href={mediaUrl} target="_blank" rel="noreferrer" data-testid="artifact-other-link">
          <Package size={16} />
          {t("documents.openArtifactMedia", "Open artifact media")}
        </a>
      );
  }
}
