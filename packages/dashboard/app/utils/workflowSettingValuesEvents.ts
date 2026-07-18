export const WORKFLOW_SETTING_VALUES_UPDATED_EVENT = "fusion:workflow-setting-values-updated";

export interface WorkflowSettingValuesUpdatedDetail {
  workflowId: string;
  projectId?: string;
}

const revisions = new Map<string, number>();
const handledServerMutationIds = new Set<string>();
const MAX_HANDLED_SERVER_MUTATIONS = 100;

export function getWorkflowSettingValuesKey(workflowId: string, projectId?: string): string {
  return `${projectId ?? "default"}::${workflowId}`;
}

export function getWorkflowSettingValuesRevision(workflowId: string, projectId?: string): number {
  return revisions.get(getWorkflowSettingValuesKey(workflowId, projectId)) ?? 0;
}

export function notifyWorkflowSettingValuesUpdated(workflowId: string, projectId?: string): void {
  const key = getWorkflowSettingValuesKey(workflowId, projectId);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<WorkflowSettingValuesUpdatedDetail>(WORKFLOW_SETTING_VALUES_UPDATED_EVENT, {
      detail: { workflowId, projectId },
    }));
  }
}

export interface WorkflowSettingValuesSsePayload {
  workflowId?: unknown;
  projectId?: unknown;
  settingIds?: unknown;
  mutationId?: unknown;
}

/** FNXC:PlannerOversight 2026-07-18-13:35: Bridge an authoritative store/SSE mutation into the card-local revision event.
 * Duplicate dashboard consumers may receive the same multiplexed SSE message, so
 * mutation IDs are bounded and de-duplicated before advancing the revision. */
export function notifyWorkflowSettingValuesUpdatedFromSse(payload: WorkflowSettingValuesSsePayload): void {
  if (typeof payload.workflowId !== "string" || typeof payload.mutationId !== "string") return;
  if (!Array.isArray(payload.settingIds) || !payload.settingIds.includes("plannerOversightLevel")) return;
  if (handledServerMutationIds.has(payload.mutationId)) return;
  handledServerMutationIds.add(payload.mutationId);
  if (handledServerMutationIds.size > MAX_HANDLED_SERVER_MUTATIONS) {
    const oldest = handledServerMutationIds.values().next().value;
    if (typeof oldest === "string") handledServerMutationIds.delete(oldest);
  }
  notifyWorkflowSettingValuesUpdated(
    payload.workflowId,
    typeof payload.projectId === "string" ? payload.projectId : undefined,
  );
}

/** @internal Test helper */
export function __test_clearWorkflowSettingValuesRevisions(): void {
  revisions.clear();
  handledServerMutationIds.clear();
}
