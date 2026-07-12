// Builds ACP `ContentBlock[]` from a Fusion prompt.
//
// U3 core path: a plain string prompt becomes a single `{ type: "text", text }`
// block. The runtime may later pass structured content (e.g. an attached image);
// when present we emit the matching block. Keep this small and pure.

import type { ContentBlock } from "@agentclientprotocol/sdk";

/** Optional structured content the runtime may attach alongside the text prompt. */
export interface PromptImage {
  /** Base64-encoded image data (no data: prefix). */
  data: string;
  /** MIME type, e.g. "image/png". */
  mimeType: string;
  /** Optional source URI for the image. */
  uri?: string;
}

export interface BuildPromptOptions {
  /** Image content to append as image block(s) after the text. */
  images?: PromptImage[];
}

/*
FNXC:GrokAcp 2026-07-12-07:15:
Dashboard chat forwards attachments as promptWithFallback options
`{ images: ChatImageContent[] }` where each item is
`{ type: "image", data: base64, mimeType }`. ACP session/prompt needs
ContentBlock image variants. Extract defensively so pi-style ImageContent
and PromptImage shapes both work; ignore malformed entries.
*/
/**
 * Pull image attachments from Fusion `promptWithFallback` options.
 * Accepts `{ images: Array<{ data, mimeType, uri? }> }` (chat / pi ImageContent).
 */
export function extractPromptImagesFromOptions(options: unknown): PromptImage[] | undefined {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return undefined;
  }
  const raw = (options as { images?: unknown }).images;
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const images: PromptImage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const data = typeof rec.data === "string" ? rec.data : undefined;
    const mimeType = typeof rec.mimeType === "string" ? rec.mimeType : undefined;
    if (!data || !mimeType || data.length === 0 || mimeType.length === 0) continue;
    // Prefer explicit uri; else map absolute filesystem `path` to file:// for agents.
    let uri = typeof rec.uri === "string" && rec.uri.length > 0 ? rec.uri : undefined;
    if (!uri && typeof rec.path === "string" && rec.path.length > 0) {
      uri = rec.path.startsWith("file:") ? rec.path : `file://${rec.path}`;
    }
    images.push({ data, mimeType, ...(uri ? { uri } : {}) });
  }
  return images.length > 0 ? images : undefined;
}

/**
 * Build the ACP prompt content blocks for a turn.
 *
 * A non-empty string yields one text block. An empty/whitespace-only string
 * yields no text block (but any attached images are still included), so we never
 * send a meaningless empty text block. Images, when supplied, are appended as
 * `image` blocks (passthrough — KTD ContentBlock image variant).
 */
export function buildPromptBlocks(prompt: string, opts?: BuildPromptOptions): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (typeof prompt === "string" && prompt.trim().length > 0) {
    blocks.push({ type: "text", text: prompt });
  }

  for (const image of opts?.images ?? []) {
    blocks.push({
      type: "image",
      data: image.data,
      mimeType: image.mimeType,
      ...(image.uri ? { uri: image.uri } : {}),
    });
  }

  return blocks;
}
