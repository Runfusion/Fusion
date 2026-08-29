/**
 * FNXC:MissionTaskPrefix 2026-07-26-12:00:
 * Shared minting-prefix resolution for createTask paths. Prefer the per-mission
 * TaskCreateInput.taskPrefix hint (mission triage), then project settings.taskPrefix,
 * then the path-specific fallback. Extracted so FN default (workflow-task-create-ops)
 * and KB default (task-creation) cannot drift (CodeRabbit #2347 / PR #1930).
 */
export function resolveTaskPrefix(
  taskPrefixHint: string | undefined,
  settingsTaskPrefix: string | undefined,
  fallback: string,
): string {
  return (taskPrefixHint?.trim() || settingsTaskPrefix?.trim() || fallback).trim().toUpperCase();
}
