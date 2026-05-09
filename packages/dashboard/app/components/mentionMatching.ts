export function normalizeMentionToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_");
}

export function matchesAgentMentionFilter(agentName: string, filter: string): boolean {
  const trimmedFilter = filter.trim();
  if (!trimmedFilter) {
    return true;
  }

  const normalizedFilter = normalizeMentionToken(trimmedFilter);
  const normalizedAgentName = normalizeMentionToken(agentName);
  return normalizedAgentName.includes(normalizedFilter) || agentName.toLowerCase().includes(trimmedFilter.toLowerCase());
}
