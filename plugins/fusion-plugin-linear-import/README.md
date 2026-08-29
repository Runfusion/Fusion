# Linear Import Plugin

`fusion-plugin-linear-import` is a bundled Fusion integration plugin that imports Linear issues into Fusion tasks. It is intentionally implemented through plugin settings, plugin routes, plugin tools, and a plugin dashboard view — not through core Linear settings or host-owned `/api/linear/*` routes.

## Setup

1. Install or enable **Linear Import** from Settings → Plugins / Plugin Manager.
2. Open the plugin settings and enter a Linear personal API key.
3. Optionally set a default team key/ID, issue state filter, and assignee ID.
4. Open the **Linear Import** plugin dashboard view to browse and import issues.

The API key is a plugin `password` setting. Fusion uses it only for HTTPS GraphQL requests to Linear and does not include it in route responses, tool results, task descriptions, task documents, or logs.

## Supported filters

The dashboard view, routes, and tools share the same filters:

- `query` — matches issue title, description, or identifier.
- `teamKey` / `teamId` — Linear team key or UUID.
- `state` — `active`, `backlog`, `started`, `unstarted`, `completed`, `canceled`, or `all`.
- `assigneeId` — Linear user UUID.
- `limit` — bounded to 1–100 issues.
- `after` — optional Linear pagination cursor for browse calls.

## Routes

All routes are plugin-scoped under `/api/plugins/fusion-plugin-linear-import/*`:

- `GET /status` — checks whether the plugin has a usable API key.
- `POST /issues` — lists/searches issues.
- `POST /issues/detail` — fetches one issue by UUID or identifier.
- `POST /issues/import` — imports one issue into `triage`.
- `POST /issues/import-batch` — imports up to 25 selected issues.

Dashboard requests include `projectId` when the host provides one so the plugin uses the project-scoped plugin settings and task store.

## Agent tools

The plugin registers plugin tools (not built-in `fn_*` tools):

- `linear_import_browse_issues`
- `linear_import_issue`
- `linear_import_issues`

Tool results summarize imported/skipped issues and include safe issue/task details only.

## Import behavior and duplicate handling

Imported tasks are created in `triage`. The task description contains the Linear issue body or `(no description)`, followed by `Source: <Linear URL>`, the Linear identifier, team, and state. Task provenance stores:

- `sourceIssue.provider: "linear"`
- stable Linear issue id as `sourceIssue.externalIssueId`
- source URL
- `source.sourceType: "api"`
- `source.sourceMetadata.provider: "linear"`
- Linear issue id, identifier, URL, team, state, assignee, and timestamps where available

Duplicate detection checks non-archived tasks by Linear issue id, Linear identifier, and source URL before creating a task. Duplicate route/tool responses identify the existing Fusion task id when available.

## Limitations and non-goals

- No Linear CLI or binary dependency is required or installed.
- No host-owned `/api/linear/*` routes or core Linear settings are added.
- Imports are read-only with respect to Linear; the plugin does not comment on, close, reopen, or update Linear issues.
- Linear workspace/team permissions are determined by the configured API key.

## External Integration Evidence

- Canonical upstream repo URL: `upstream-pending-verification` (Linear is consumed as a SaaS HTTP/GraphQL API; no official client repository is required)
- Docs / homepage URL: <https://developers.linear.app/>
- API docs URL: <https://developers.linear.app/docs/graphql/working-with-the-graphql-api>
- GraphQL API endpoint: <https://api.linear.app/graphql>
- Release / download URL: `upstream-pending-verification` (no downloadable binary is added)
- Binary / CLI name: `none` (HTTP/GraphQL API integration only)
- Checksum: `upstream-pending-verification` (no downloaded binary is added)
