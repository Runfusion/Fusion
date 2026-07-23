import type {
  WorkflowExtensionContribution,
  WorkflowExtensionKind,
} from "./workflow-extension-types.js";
import { workflowExtensionRegistryId } from "./workflow-extension-types.js";

export type WorkflowExtensionRegistrationReason =
  | "duplicate-id"
  | "invalid-plugin-id"
  | "invalid-extension-id";

export class WorkflowExtensionRegistrationError extends Error {
  constructor(
    public readonly reason: WorkflowExtensionRegistrationReason,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowExtensionRegistrationError";
  }
}

export interface WorkflowExtensionDefinition {
  id: string;
  pluginId: string;
  extension: WorkflowExtensionContribution;
  degraded?: {
    reason: "force-disabled" | "plugin-unloaded" | "runtime-fault";
    message: string;
  };
}

type WorkflowExtensionDegradeReason = NonNullable<WorkflowExtensionDefinition["degraded"]>["reason"];

const PLUGIN_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export class WorkflowExtensionRegistry {
  private definitions = new Map<string, WorkflowExtensionDefinition>();

  register(pluginId: string, extension: WorkflowExtensionContribution): WorkflowExtensionDefinition {
    if (!PLUGIN_ID_PATTERN.test(pluginId)) {
      throw new WorkflowExtensionRegistrationError(
        "invalid-plugin-id",
        `Plugin id '${pluginId}' is not a valid workflow extension namespace`,
      );
    }
    if (!PLUGIN_ID_PATTERN.test(extension.extensionId)) {
      throw new WorkflowExtensionRegistrationError(
        "invalid-extension-id",
        `Workflow extension id '${extension.extensionId}' is not a valid slug`,
      );
    }
    const id = workflowExtensionRegistryId(pluginId, extension.extensionId);
    if (this.definitions.has(id)) {
      throw new WorkflowExtensionRegistrationError(
        "duplicate-id",
        `Workflow extension '${id}' is already registered`,
      );
    }
    const definition = { id, pluginId, extension };
    this.definitions.set(id, definition);
    return definition;
  }

  upsert(pluginId: string, extension: WorkflowExtensionContribution): WorkflowExtensionDefinition {
    const id = workflowExtensionRegistryId(pluginId, extension.extensionId);
    const existing = this.definitions.get(id);
    if (existing) {
      existing.extension = extension;
      return existing;
    }
    return this.register(pluginId, extension);
  }

  unregister(id: string): boolean {
    return this.definitions.delete(id);
  }

  unregisterPlugin(pluginId: string): string[] {
    const removed: string[] = [];
    for (const [id, definition] of this.definitions) {
      if (definition.pluginId !== pluginId) continue;
      this.definitions.delete(id);
      removed.push(id);
    }
    return removed;
  }

  degrade(ids: readonly string[], reason: WorkflowExtensionDegradeReason, message: string): string[] {
    const degraded: string[] = [];
    for (const id of ids) {
      const definition = this.definitions.get(id);
      if (!definition) continue;
      definition.degraded = { reason, message };
      degraded.push(id);
    }
    return degraded;
  }

  get(id: string): WorkflowExtensionDefinition | undefined {
    return this.definitions.get(id);
  }

  list(kind?: WorkflowExtensionKind): WorkflowExtensionDefinition[] {
    const definitions = [...this.definitions.values()];
    return kind ? definitions.filter((definition) => definition.extension.kind === kind) : definitions;
  }

  clear(): void {
    this.definitions.clear();
  }
}

const defaultWorkflowExtensionRegistry = new WorkflowExtensionRegistry();

export function getWorkflowExtensionRegistry(): WorkflowExtensionRegistry {
  return defaultWorkflowExtensionRegistry;
}

export function __resetWorkflowExtensionRegistryForTests(): void {
  defaultWorkflowExtensionRegistry.clear();
}
