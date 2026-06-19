import type { ChatAttachment } from "@fusion/core";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { CHAT_ALLOWED_MIME_TYPES } from "./routes/chat-attachment-config.js";

export interface ChatImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ChatAttachmentContent {
  originalName: string;
  mimeType: string;
  text: string | null;
}

export type ChatAttachmentScope =
  | { kind: "session"; sessionId: string }
  | { kind: "room"; roomId: string };

export interface ChatAttachmentDiagnostics {
  warn(message: string, ...args: unknown[]): void;
}

export interface ReadChatAttachmentContentsResult {
  attachmentContents: ChatAttachmentContent[];
  imageContents: ChatImageContent[];
}

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const TEXT_MIME_TYPES = new Set(
  [...CHAT_ALLOWED_MIME_TYPES].filter((mimeType) => !IMAGE_MIME_TYPES.has(mimeType)),
);

export const CHAT_TEXT_INLINE_LIMIT = 50 * 1024;
const TRUNCATION_SUFFIX = "\n... (truncated at 50KB)";

function getAttachmentDirectory(rootDir: string, scope: ChatAttachmentScope): string {
  if (scope.kind === "session") {
    return resolve(rootDir, ".fusion", "chat-attachments", scope.sessionId);
  }

  return resolve(rootDir, ".fusion", "chat-room-attachments", scope.roomId);
}

function getScopeLabel(scope: ChatAttachmentScope): string {
  return scope.kind === "session" ? `session ${scope.sessionId}` : `room ${scope.roomId}`;
}

function fenceLanguageForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "application/json":
      return "json";
    case "text/yaml":
      return "yaml";
    case "text/x-toml":
      return "toml";
    case "text/csv":
      return "csv";
    case "application/xml":
      return "xml";
    default:
      return "text";
  }
}

function escapeFence(text: string): string {
  return text.replaceAll("```", "``\\`");
}

/**
 * FNXC:ChatAttachments 2026-06-16-19:55:
 * Dashboard chat agents must receive real user-attached bytes, not only attachment names. Session chat reads from .fusion/chat-attachments/{sessionId}; room chat reads from .fusion/chat-room-attachments/{roomId}; basename resolution prevents uploaded filenames from escaping those per-surface roots.
 *
 * FNXC:ChatAttachments 2026-06-16-19:55:
 * Text attachments are prompt-inlined with the triage-compatible 50KB ceiling while image attachments are forwarded as pi image content blocks through promptWithFallback options.
 */
export async function readChatAttachmentContents(
  rootDir: string,
  scope: ChatAttachmentScope,
  attachments?: ChatAttachment[],
  diagnostics?: ChatAttachmentDiagnostics,
): Promise<ReadChatAttachmentContentsResult> {
  const attachmentContents: ChatAttachmentContent[] = [];
  const imageContents: ChatImageContent[] = [];

  if (!attachments || attachments.length === 0) {
    return { attachmentContents, imageContents };
  }

  const attachmentDir = getAttachmentDirectory(rootDir, scope);

  for (const attachment of attachments) {
    if (!CHAT_ALLOWED_MIME_TYPES.has(attachment.mimeType)) {
      diagnostics?.warn(`Skipping unsupported chat attachment '${attachment.filename}' (${attachment.mimeType}) for ${getScopeLabel(scope)}`);
      continue;
    }

    const safeName = basename(attachment.filename);
    const filePath = resolve(attachmentDir, safeName);

    try {
      if (IMAGE_MIME_TYPES.has(attachment.mimeType)) {
        const data = await readFile(filePath);
        imageContents.push({
          type: "image",
          data: data.toString("base64"),
          mimeType: attachment.mimeType,
        });
        attachmentContents.push({
          originalName: attachment.originalName,
          mimeType: attachment.mimeType,
          text: null,
        });
        continue;
      }

      if (!TEXT_MIME_TYPES.has(attachment.mimeType)) {
        diagnostics?.warn(`Skipping non-inlineable chat attachment '${attachment.filename}' (${attachment.mimeType}) for ${getScopeLabel(scope)}`);
        continue;
      }

      const data = await readFile(filePath, "utf-8");
      const text = data.length > CHAT_TEXT_INLINE_LIMIT
        ? `${data.slice(0, CHAT_TEXT_INLINE_LIMIT)}${TRUNCATION_SUFFIX}`
        : data;
      attachmentContents.push({
        originalName: attachment.originalName,
        mimeType: attachment.mimeType,
        text,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics?.warn(`Failed to read chat attachment '${attachment.filename}' for ${getScopeLabel(scope)}, skipping: ${message}`);
    }
  }

  return { attachmentContents, imageContents };
}

export function formatChatAttachmentContents(attachmentContents: ChatAttachmentContent[]): string {
  const inlineAttachments = attachmentContents.filter((attachment) => attachment.text !== null);
  if (inlineAttachments.length === 0) {
    return "";
  }

  return [
    "## Attachments",
    ...inlineAttachments.map((attachment) => [
      `### ${attachment.originalName} (${attachment.mimeType})`,
      `\`\`\`${fenceLanguageForMimeType(attachment.mimeType)}`,
      escapeFence(attachment.text ?? ""),
      "```",
    ].join("\n")),
  ].join("\n\n");
}
