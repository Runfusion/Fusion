---
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: atlas
---

# Dashboard Theme and UI Plugin System Plan

Status: proposal / feasibility spike
Project: Fusion
Mission: Dashboard theme and plugin system
Goal: Make Fusion extensible through dashboard themes and UI experiments

## Product Contract

Fusion should support multiple dashboard UI themes or shells that run against the same backend, project store, task APIs, mission APIs, plugin routes, and auth/session layer.

The useful version is not just alternate colors. It is a controlled extension point where different dashboard experiences can compete against the same live project state:

- dense operator console
- calmer executive/project overview
- Jony/Ivory-style polished product UI
- mobile/tablet-first shell
- plugin-specific workspaces like Compound Engineering

Every theme or shell must preserve task, mission, goal, file, auth, and plugin semantics. UI experiments must not fork backend behavior.

## Design Contract

Themes should be DESIGN.md-backed where practical.

A Fusion dashboard theme package should be able to include a `DESIGN.md` file as its interchange/source format:

- YAML front matter provides normative design tokens.
- Markdown body explains taste, usage, and constraints for humans and coding agents.
- Fusion can lint with `@google/design.md`, including token references and WCAG contrast checks.
- Fusion can eventually export selected themes to Tailwind or DTCG JSON.
- Fusion can eventually import community DESIGN.md systems from designmd.ai.

Example theme manifest direction:

```json
{
  "id": "fusion-theme-operator-console",
  "name": "Operator Console",
  "version": "0.1.0",
  "type": "dashboard-theme",
  "entry": "dist/index.js",
  "css": "dist/theme.css",
  "design": "DESIGN.md",
  "capabilities": ["tokens", "designMd", "componentVariants"],
  "supports": {
    "fusionDashboardApi": ">=0.1.0",
    "designMd": "alpha"
  }
}
```

## Technical Contract

Define a stable dashboard host context instead of requiring plugin/theme UI to import dashboard internals:

```ts
interface DashboardHostContext {
  projectId?: string;
  projectName?: string;
  api: DashboardApiClient;
  navigation: DashboardNavigation;
  files: DashboardFileActions;
  tasks: DashboardTaskActions;
  toast: DashboardToastActions;
  theme: ResolvedThemeTokens;
}
```

Critical rule: every context-provided helper must be selected-project scoped. If the user selects the Fusion project, Goals, Compound Engineering artifacts, file browser, missions, tasks, and plugin routes must resolve against Fusion — not the previous/default project.

## Implementation Units

1. Fix selected-project scoping bugs first.
   - Goals view must receive current projectId.
   - Goals APIs must append projectId to goals/missions/link/edit/archive/draft calls.
   - Compound Engineering artifact discovery and file opening must be selected-project scoped.
   - Artifact views must clear stale previous-project data while the new project fetch is pending.

2. Define dashboard extension contracts.
   - `DashboardHostContext`
   - scoped dashboard API client
   - file actions
   - navigation actions
   - theme token schema
   - DESIGN.md import/export/lint pipeline
   - plugin/theme manifest fields

3. Add a token theme registry.
   - built-in current/default theme
   - built-in operator-console theme
   - built-in polished-product theme
   - project-scoped selection setting
   - CSS variable injection
   - DESIGN.md import from project root or theme package
   - `@google/design.md` lint in validation path
   - optional Tailwind/DTCG export

4. Migrate shared primitives to semantic tokens.
   - ViewHeader
   - cards
   - buttons
   - sidebar/nav
   - kanban columns
   - task cards
   - modals

5. Only then test shell-level plugins.
   - one alternate shell behind an experimental flag
   - same selected Fusion project data
   - same task/mission/goal actions
   - clean rollback path

## Verification Contract

- Switching theme changes visible dashboard tokens without reload.
- Theme selection persists per project.
- Theme switching does not change task/mission/goal data behavior.
- Two themes produce meaningfully different UI from the same component tree.
- Plugin dashboard views can use scoped host APIs without raw `fetch`.
- Regression tests prove Fusion project data does not show Atlas Notes or local-runtime project data.

## Open Decisions

1. Should v1 define “theme” as DESIGN.md-backed tokens only, or include view/shell plugins from the start?
2. Should theme selection be global, per project, or both?
3. Should bundled themes live under `packages/dashboard` or `plugins/`?
4. Should plugin dashboard views be required to use a scoped host API client instead of raw `fetch`?
5. Should Fusion ship a DESIGN.md browser/importer for designmd.ai systems, or only local file import first?
