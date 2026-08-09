/**
 * FNXC:CodeOrganization 2026-08-03-19:00:
 * resolveTaskCustomFieldDefs peeled from TaskExecutor (U4).
 *
 * Resolve custom field definitions from the task's selected workflow (KTD-13).
 * Pure read; degrades to undefined on any resolution failure so prompt-building never throws.
 */
import type { TaskStore, WorkflowFieldDefinition } from "@fusion/core";
import { resolveWorkflowIrForTask } from "@fusion/core";

export type ResolveTaskCustomFieldDefsDeps = {
  store: TaskStore;
};

export async function resolveTaskCustomFieldDefs(
  deps: ResolveTaskCustomFieldDefsDeps,
  taskId: string,
): Promise<WorkflowFieldDefinition[] | undefined> {
  try {
    const ir = await resolveWorkflowIrForTask(deps.store, taskId);
    const fields = ir.version === "v2" ? ir.fields : undefined;
    return fields && fields.length > 0 ? fields : undefined;
  } catch {
    return undefined;
  }
}
