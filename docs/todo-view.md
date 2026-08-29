# Todo Lists plugin

Todo Lists is an optional per-project first-party plugin. Enable `fusion-plugin-todos` in the project Plugins settings to expose the Todo Lists dashboard surface and its project-scoped API.

The plugin owns list/item UI, responsive narrow and wide layouts, completed-item filtering, planning handoff, and task creation. Its only API namespace is `/api/plugins/fusion-plugin-todos/todos/*`; `/api/todos` is not available. Disabled or uninstalled projects expose neither the API nor a navigation entry.

See [`plugins/fusion-plugin-todos/README.md`](../plugins/fusion-plugin-todos/README.md) for architecture, use, and extraction rationale.
