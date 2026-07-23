/*
FNXC:ChatAttachments 2026-08-03-00:00:
Chat upload validation must match task attachments: the composer now allows the full task-store MIME
set, so direct and room routes must persist videos, Markdown, and TOML instead of rejecting them.
*/
export const CHAT_ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/yaml",
  "text/x-toml",
  "text/csv",
  "application/xml",
]);

export const CHAT_MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
export const CHAT_MAX_VIDEO_ATTACHMENT_SIZE = 100 * 1024 * 1024;

export function getChatAttachmentMaxSize(mimeType: string): number {
  return mimeType.startsWith("video/")
    ? CHAT_MAX_VIDEO_ATTACHMENT_SIZE
    : CHAT_MAX_ATTACHMENT_SIZE;
}
