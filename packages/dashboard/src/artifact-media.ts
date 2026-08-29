import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { TaskStore } from "@fusion/core";
import { badRequest } from "./api-error.js";

export type MediaArtifact = { taskId?: string; uri?: string };

/**
 * FNXC:ArtifactMedia 2026-07-19-17:25:
 * Artifact URIs are storage metadata, not trusted filesystem paths. Media reads
 * must stay confined to the owning task's artifacts/attachments directories (or
 * task-less .fusion/artifacts) before a report can upload user-reviewed pixels.
 */
export function resolveArtifactMediaPath(scopedStore: TaskStore, artifact: MediaArtifact): string | null {
  if (!artifact.uri) return null;

  const anchorDir = artifact.taskId ? scopedStore.getTaskDir(artifact.taskId) : scopedStore.getFusionDir();
  const expectedArtifactsDir = resolve(anchorDir, "artifacts");
  const expectedAttachmentsDir = artifact.taskId ? resolve(anchorDir, "attachments") : null;
  const mediaPath = resolve(anchorDir, artifact.uri);
  const underArtifacts = mediaPath === expectedArtifactsDir || mediaPath.startsWith(`${expectedArtifactsDir}${sep}`);
  const underAttachments = expectedAttachmentsDir !== null && (mediaPath === expectedAttachmentsDir || mediaPath.startsWith(`${expectedAttachmentsDir}${sep}`));
  if (!underArtifacts && !underAttachments) throw badRequest("Invalid artifact media path");
  return mediaPath;
}

/** Reads bytes only after the shared task-directory confinement check succeeds. */
export async function readArtifactMediaBytes(scopedStore: TaskStore, artifact: MediaArtifact): Promise<Buffer> {
  const mediaPath = resolveArtifactMediaPath(scopedStore, artifact);
  if (!mediaPath) throw badRequest("Artifact has no stored media");
  return readFile(mediaPath);
}
