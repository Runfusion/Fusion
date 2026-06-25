export type FilePreviewKind = "image" | "video" | "audio" | "pdf";

export const IMAGE_PREVIEW_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".svg",
  ".svgz",
  ".avif",
]);

export const VIDEO_PREVIEW_EXTENSIONS = new Set([
  ".mp4",
  ".webm",
  ".ogg",
  ".ogv",
  ".mov",
  ".m4v",
]);

export const AUDIO_PREVIEW_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".oga",
  ".m4a",
  ".aac",
  ".flac",
  ".opus",
]);

export const PDF_PREVIEW_EXTENSIONS = new Set([".pdf"]);

/**
 * FNXC:FileBrowser 2026-06-25-00:00:
 * Files browsing needs extension-only preview classification to be shared by editor loading and rendering. Keep `.ogg` classified as video because browsers can render Ogg video natively and audio-only Ogg files can still be opened by the same media element path without fetching binary text.
 */
export function getFilePreviewKind(filePath?: string | null): FilePreviewKind | null {
  if (!filePath) {
    return null;
  }

  const normalizedPath = filePath.trim().toLowerCase();
  const lastSlash = Math.max(normalizedPath.lastIndexOf("/"), normalizedPath.lastIndexOf("\\"));
  const filename = normalizedPath.slice(lastSlash + 1);
  const dotIndex = filename.lastIndexOf(".");

  if (dotIndex <= 0) {
    return null;
  }

  const extension = filename.slice(dotIndex);
  if (IMAGE_PREVIEW_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (VIDEO_PREVIEW_EXTENSIONS.has(extension)) {
    return "video";
  }
  if (AUDIO_PREVIEW_EXTENSIONS.has(extension)) {
    return "audio";
  }
  if (PDF_PREVIEW_EXTENSIONS.has(extension)) {
    return "pdf";
  }

  return null;
}
