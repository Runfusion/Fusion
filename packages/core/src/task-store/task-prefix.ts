/**
 * FNXC:MissionTaskPrefix 2026-07-19-13:15:
 * Shared minting-prefix resolution for createTask paths. Prefer the per-mission
 * TaskCreateInput.taskPrefix hint (mission triage), then project settings.taskPrefix,
 * then the path-specific fallback. Extracted so remaining-ops-4 (FN default) and
 * task-creation (KB default) cannot drift (CodeRabbit #2347).
 */
export function resolveTaskPrefix(
  taskPrefixHint: string | undefined,
  settingsTaskPrefix: string | undefined,
  fallback: string,
): string {
  return (taskPrefixHint?.trim() || settingsTaskPrefix || fallback).trim().toUpperCase();
}
