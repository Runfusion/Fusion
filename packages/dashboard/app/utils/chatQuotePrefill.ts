/*
FNXC:ChatQuoteReply 2026-08-23-02:31:
Quoting an agent-authored message must re-emit its mention token so the next direct-chat turn is routed back to that agent.
*/
export function buildChatQuotePrefill({
  quotedText,
  agentName,
  existingDraft,
}: {
  quotedText: string;
  agentName?: string | null;
  existingDraft: string;
}): string {
  const normalized = quotedText.replace(/"/g, "'").replace(/\s+/g, " ").trim();
  if (!normalized) return existingDraft;
  const excerpt = normalized.length > 200 ? `${normalized.slice(0, 200)}…` : normalized;
  const mention = agentName?.trim() ? `@${agentName.trim().replace(/\s+/g, "_")} , ` : "";
  const prefix = `"${excerpt}" - ${mention}`;
  return `${prefix}${existingDraft.replace(/^"[^"]*" - (@[\w-]+ , )?/, "")}`;
}
