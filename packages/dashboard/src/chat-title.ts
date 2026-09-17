/*
FNXC:ChatTitleGeneration 2026-09-17-11:42:
FN-505 requires a chat conversation to carry a readable name BEFORE the assistant starts replying.
`summarizeTitle` cannot satisfy that: it builds a full pi agent session before producing a single
character, so the model-refined title structurally lands after the main response has begun (and,
on the mentions path, never landed at all).

The documented ecosystem pattern (rowboat, multica, ProbOS AD-794, AuditBuffet AB-000351) is a
two-stage name: a deterministic placeholder derived from the first user message, written
synchronously, then an asynchronous model refinement that compare-and-sets over it and never beats
a manual rename. This module owns stage one and is deliberately PURE — no store, no model, no I/O —
so the write that makes the conversation visible cannot be delayed by anything.
*/

/** Upper bound for the provisional title, matching the < 60-char convention used across chat UIs. */
export const PROVISIONAL_CHAT_TITLE_MAX_CHARS = 60;

/**
 * Build the deterministic provisional title for a conversation from its first user message.
 *
 * All whitespace (including newlines and tabs) collapses to a single space so a pasted multi-line
 * prompt still yields one readable line. Content longer than {@link PROVISIONAL_CHAT_TITLE_MAX_CHARS}
 * is cut at the nearest word boundary below the bound rather than mid-word; a first "word" longer
 * than the bound is hard-cut because there is no boundary to use.
 *
 * @returns the provisional title, or `null` when the message carries no usable text — callers must
 * then write nothing at all rather than persist an empty title.
 */
export function buildProvisionalChatTitle(content: string): string | null {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= PROVISIONAL_CHAT_TITLE_MAX_CHARS) return normalized;

  const window = normalized.slice(0, PROVISIONAL_CHAT_TITLE_MAX_CHARS);
  const lastSpace = window.lastIndexOf(" ");
  const cut = lastSpace > 0 ? window.slice(0, lastSpace) : window;
  const trimmed = cut.trim();
  return trimmed || null;
}
