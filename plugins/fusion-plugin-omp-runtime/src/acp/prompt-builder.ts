/* Vendored ACP client from fusion-plugin-acp-runtime — see ./VENDORED.md (FNXC:GrokAcp 2026-07-11-16:00). */
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
