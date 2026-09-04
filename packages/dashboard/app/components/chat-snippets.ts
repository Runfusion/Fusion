import {
  CHAT_SNIPPET_RESERVED_NAMES,
  normalizeChatSnippetName,
  type ChatSnippet,
} from "@fusion/core";
import { getSlashTriggerMatch } from "./chat-commands";

export interface AppliedChatSnippetDraft {
  value: string;
  cursorPosition: number;
}

export function filterChatSnippets(filter: string, snippets: readonly ChatSnippet[]): ChatSnippet[] {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) return snippets.map(({ name, prompt }) => ({ name, prompt }));
  return snippets
    .filter((snippet) => snippet.name.toLowerCase().includes(normalized))
    .map(({ name, prompt }) => ({ name, prompt }));
}

export function applySnippetToDraft(
  value: string,
  snippet: ChatSnippet,
  cursorPosition = value.length,
): AppliedChatSnippetDraft | null {
  const boundedCursor = Math.max(0, Math.min(cursorPosition, value.length));
  const triggerMatch = getSlashTriggerMatch(value.slice(0, boundedCursor));
  if (!triggerMatch) return null;

  const prefix = value.slice(0, triggerMatch.start);
  const suffix = value.slice(boundedCursor);
  return {
    value: `${prefix}${snippet.prompt}${suffix}`,
    cursorPosition: prefix.length + snippet.prompt.length,
  };
}

export function matchStandaloneSnippetInvocation(
  text: string,
  snippets: readonly ChatSnippet[],
): ChatSnippet | null {
  const invocation = text.trim();
  if (!invocation.startsWith("/") || invocation.length < 2) return null;
  const rawName = invocation.slice(1);
  if (/\s/u.test(rawName) || rawName.includes(":")) return null;
  const normalizedName = normalizeChatSnippetName(rawName);
  if (!normalizedName || (CHAT_SNIPPET_RESERVED_NAMES as readonly string[]).includes(normalizedName)) return null;
  const snippet = snippets.find((candidate) => candidate.name === normalizedName);
  return snippet ? { name: snippet.name, prompt: snippet.prompt } : null;
}
