import type { TaskStore } from "../store.js";
import { resolveColumnFlags } from "../workflows/trait-registry.js";
import { resolveWorkflowIrForTask } from "../workflows/workflow-ir-resolver.js";

/** Resolve a canonical task's own terminal-role flags, failing soft to legacy column ids. */
export async function resolveNearDuplicateCanonicalFlags(
  store: TaskStore,
  canonical: { id: string; column?: string | null } | null | undefined,
): Promise<ReturnType<typeof resolveColumnFlags> | undefined> {
  if (!canonical?.column) return undefined;
  const workflow = await resolveWorkflowIrForTask(store, canonical.id).catch(() => undefined);
  if (!workflow || workflow.version !== "v2") return undefined;
  const column = workflow.columns.find((candidate) => candidate.id === canonical.column);
  return column ? resolveColumnFlags(column) : undefined;
}
