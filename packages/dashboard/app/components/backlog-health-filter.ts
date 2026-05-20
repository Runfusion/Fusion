export const BACKLOG_HEALTH_TITLE_PREFIXES: readonly string[] = [
  "Backlog health:",
  "Backlog pressure detected",
  "Stale paused todo",
  "Backlog health: dependency-blocked todos",
];

export function isBacklogHealthInsight(insight: { title: string }): boolean {
  return BACKLOG_HEALTH_TITLE_PREFIXES.some((prefix) => insight.title.startsWith(prefix));
}
