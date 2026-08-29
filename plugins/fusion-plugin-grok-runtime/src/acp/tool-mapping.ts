/* Vendored ACP client from fusion-plugin-acp-runtime — see ./VENDORED.md (FNXC:GrokAcp 2026-07-11-16:00). */
// Pure helpers mapping ACP `ToolCall` metadata into the display name + args
// shape Fusion's `onToolStart`/`onToolEnd` callbacks expect.
//
// ACP's `kind` is agent-defined, optional, and partial (U4). These helpers must
// never throw on missing/odd input — a missing title falls back to a label
// derived from `kind`, and a missing/non-object `rawInput` normalizes to `{}`.

import type { ToolKind } from "@agentclientprotocol/sdk";

/** Human-readable labels for each ACP `ToolKind`. */
const KIND_LABELS: Record<ToolKind, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Execute",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Switch Mode",
  other: "Tool",
};

/**
 * Resolve a display name for a tool call. Prefers the agent-supplied `title`;
 * falls back to a label derived from `kind`; final fallback is `"tool"`.
 */
export function toolDisplayName(toolCall: { title?: string | null; kind?: ToolKind | null }): string {
  const title = typeof toolCall.title === "string" ? toolCall.title.trim() : "";
  if (title) return title;
  const kind = toolCall.kind;
  if (kind && kind in KIND_LABELS) return KIND_LABELS[kind];
  return "tool";
}

/**
 * Normalize a tool call's `rawInput` to a plain object. Returns `{}` when the
 * input is undefined, null, or any non-object (arrays included) so downstream
 * code can always treat args as a record.
 */
export function normalizeToolArgs(rawInput: unknown): Record<string, unknown> {
  if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return {};
  }
  return rawInput as Record<string, unknown>;
}
