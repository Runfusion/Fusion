/*
FNXC:MergeQueue 2026-07-15-10:40:
AI merge spends most of its wall-clock time in status="reviewing" (clean-room review) and status="landing" (advance main / cleanup), not only status="merging". Board badges, workflow switcher flash counts, sort priority, and stall suppression must treat the full merge pipeline as active merge so operators see the Merging badge while the single-flight pump owns the task.
*/

/** Transient statuses set while the AI/PR merge pipeline owns a task. */
export const ACTIVE_MERGE_PIPELINE_STATUSES = new Set([
  "merging",
  "merging-pr",
  "merging-fix",
  "reviewing",
  "landing",
]);

export function isActiveMergeStatus(status: string | null | undefined): boolean {
  return status != null && ACTIVE_MERGE_PIPELINE_STATUSES.has(status);
}
