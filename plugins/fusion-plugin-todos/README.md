# Todo Lists plugin

`@fusion-plugin-examples/todos` is the bundled `fusion-plugin-todos` first-party plugin. Enable it for a project in **Settings → Plugins** to expose its Todo Lists navigation surface and API.

## Why Todo Lists

Todo Lists is Fusion's second feature extraction after Roadmaps. Its bounded project-scoped TodoStore, cohesive list/item route contract, and dashboard handoff into planning provide a focused proof that a feature can move vertically into a plugin without duplicate host ownership.

Rejected alternatives: **Insights** couples AI generation, memory, research, and native previews; **Artifacts/Documents** are cross-cutting execution infrastructure; **Goals** is explicitly outside this extraction's scope.

## Architecture

- `src/index.ts` declares the `fusion-plugin-todos` manifest, dashboard contribution, and routes.
- `src/todo-routes.ts` owns `/api/plugins/fusion-plugin-todos/todos/*`; routes resolve the request project through `PluginContext.resolveProjectTaskStore`.
- `src/dashboard/` owns the Todo view, list/item API client, state hook, responsive layout, and planning/task-created host callbacks.
- The dashboard host discovers the view only when the plugin is installed and enabled. There is no `/api/todos` compatibility route or hardcoded Todo nav/view.

## Use

Enable the plugin for the intended project, then select **Todos** from the plugin-discovered overflow, mobile More, or right-dock destination. Create lists and items, hide completed items, hand an item into Planning, or create a task from it. Requests use the plugin namespace and `projectId`, so lists remain isolated by project.
