/*
 * FNXC:BundledPlugins 2026-07-15-13:11:
 * Clean CI typechecks the CLI before @fusion/core emits dist, but published bundled plugins still need postgresSchema runtime values. Keep this alias implementation in an untyped .mjs module so CLI tsc does not cross the package rootDir boundary; esbuild follows the core source import and inlines the schema into each bundled.js artifact, leaving no private @fusion/core runtime dependency.
 */
import * as postgresSchema from "../../core/src/postgres/schema/index.js";

export { postgresSchema };

export const WORKFLOW_EXTENSION_SCHEMA_VERSION = 1;

export function workflowExtensionRegistryId(pluginId, extensionId) {
  return `plugin:${pluginId}:${extensionId}`;
}

export function createBoardActionServices(store) {
  return {
    moveTask(input) {
      return store.moveTask(input.taskId, input.column, {
        preserveProgress: input.preserveProgress,
        moveSource: input.source ?? "user",
      });
    },
    updateTask(input) {
      return store.updateTask(input.taskId, input.updates);
    },
  };
}
