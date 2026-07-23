import {
  type WorkflowExtensionContribution,
  type WorkflowExtensionRegistry,
  workflowExtensionRegistryId,
} from "@fusion/core";

export function registerPluginWorkflowExtensions(params: {
  registry: WorkflowExtensionRegistry;
  pluginId: string;
  contributions: WorkflowExtensionContribution[];
}): string[] {
  const registered: string[] = [];
  for (const contribution of params.contributions) {
    const id = workflowExtensionRegistryId(params.pluginId, contribution.extensionId);
    params.registry.upsert(params.pluginId, contribution);
    registered.push(id);
  }
  return registered;
}

export function unregisterPluginWorkflowExtensions(
  registry: WorkflowExtensionRegistry,
  ids: readonly string[],
): string[] {
  const removed: string[] = [];
  for (const id of ids) {
    if (registry.unregister(id)) removed.push(id);
  }
  return removed;
}

export function degradePluginWorkflowExtensions(
  registry: WorkflowExtensionRegistry,
  ids: readonly string[],
  message = "workflow extension plugin force-disabled",
): string[] {
  return registry.degrade(ids, "force-disabled", message);
}
