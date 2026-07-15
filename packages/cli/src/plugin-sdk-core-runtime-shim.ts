import type { BoardActionTaskStore, ColumnId, Task } from "@fusion/core";

/**
 * FNXC:BundledPlugins 2026-07-15-00:00:
 * Reports and CLI Printing Press import the `postgresSchema` runtime namespace while the CLI bundler aliases `@fusion/core` to this shim for published plugin bundles. Re-export the concrete core schema build artifact here so npm-installed `bundled.js` files resolve `postgresSchema.plugin` without keeping a bare private `@fusion/core` runtime specifier or crashing with `Cannot find package '@fusion/core'`; using dist keeps @runfusion/fusion typecheck inside its package root while esbuild still bundles the schema runtime values.
 */
export * as postgresSchema from "../../core/dist/postgres/schema/index.js";

export const WORKFLOW_EXTENSION_SCHEMA_VERSION = 1 as const;

export function workflowExtensionRegistryId(pluginId: string, extensionId: string): string {
  return `plugin:${pluginId}:${extensionId}`;
}

export interface MoveBoardTaskInput {
  taskId: string;
  column: ColumnId;
  preserveProgress?: boolean;
  source?: "user" | "engine" | "scheduler";
}

export interface UpdateBoardTaskInput {
  taskId: string;
  updates: Record<string, unknown>;
}

export function createBoardActionServices(store: BoardActionTaskStore) {
  return {
    moveTask(input: MoveBoardTaskInput): Promise<Task> {
      return store.moveTask(input.taskId, input.column, {
        preserveProgress: input.preserveProgress,
        moveSource: input.source ?? "user",
      });
    },
    updateTask(input: UpdateBoardTaskInput): Promise<Task> {
      return store.updateTask(input.taskId, input.updates);
    },
  };
}
