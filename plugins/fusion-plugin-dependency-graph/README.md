# fusion-plugin-dependency-graph

Plugin-provided top-level **Graph** dashboard view for Fusion.

- Registers `dashboardViews: [{ viewId: "graph", placement: "more" }]`
- Renders active task dependency graph for `triage`, `todo`, `in-progress`, `in-review`
- Excludes `done` and `archived`
- Persists drag positions in browser localStorage at:
  - `kb:${projectId}:dependency-graph-positions`

The first version uses a lightweight custom SVG/HTML renderer (no React Flow dependency).
