# Proposal: Dashboard Theme and UI Plugin System for Fusion

Status: proposal / feasibility spike
Owner: Fusion maintainers
Project: Fusion
Mission: Dashboard theme and plugin system (M-MR1L2R3U-0001-GZAH)
Goal: Make Fusion extensible through dashboard themes and UI experiments (G-MR1L1G5U-0001-CV8D)

## Short version

Fusion should support multiple dashboard UI themes or shells that run against the same backend, project store, task APIs, mission APIs, plugin routes, and auth/session layer.

The point is not just “dark mode with different colors.” The useful version is a controlled extension point where different dashboard experiences can compete:

- dense operator console
- calmer executive/project overview
- Jony/Ivory-style polished product UI
- mobile/tablet-first shell
- plugin-specific workspaces like Compound Engineering

All of them should use the same source of truth and should be swappable without forking backend behavior.

## Problem

Fusion is becoming two things at once:

1. a backend/orchestration system for multi-agent work, and
2. a dashboard/product surface for humans operating that system.

Those two layers are coupled too tightly. UI experiments currently compete inside the main dashboard codepath, which creates three bad outcomes:

- style experiments become risky because they can disturb core dashboard behavior;
- plugin views can feel visually bolted on instead of first-class;
- maintainers cannot compare alternate layouts or interaction models against the same live project state.

A theme/plugin system should create a safe lane for UI exploration without turning the core app into a pile of conditionals.

## What this should mean

A “theme” should be more than CSS tokens, but less than an arbitrary untrusted app.

Recommended model:

1. Theme tokens
   - color palettes
   - spacing/radius/shadow scale
   - typography/font scale
   - semantic status colors
   - density presets
   - imported from or exported to `DESIGN.md` files

2. DESIGN.md as the theme interchange format
   - a theme should be representable as a `DESIGN.md` file in the project root or theme package
   - the YAML front matter is the normative token source; the Markdown body explains taste, usage, and constraints for agents and humans
   - Fusion should be able to lint DESIGN.md files with the `@google/design.md` CLI, including token references and WCAG contrast checks
   - Fusion should eventually export a selected theme to Tailwind/DTCG JSON and import community DESIGN.md systems from sources such as designmd.ai

3. Component skinning
   - wrappers or variants for shared primitives: cards, buttons, tabs, sidebars, tables, kanban columns, headers, modals
   - no backend access here; purely presentational

3. Dashboard shell plugins
   - optional alternate page layouts for the same views
   - e.g. board/list/mission/goals/files arranged differently
   - constrained by a stable host context and API client

4. View plugins
   - current plugin dashboard views already point in this direction
   - they need stronger project scoping, file-opening, auth, and styling contracts

## Non-goals for v1

- Do not let themes run arbitrary privileged code by default.
- Do not fork task/mission/goal semantics per theme.
- Do not require every existing dashboard component to be rewritten before the first useful experiment.
- Do not build a marketplace before local/bundled themes work.
- Do not turn this into a full microfrontend architecture unless the spike proves it is needed.

## Proposed v1 architecture

### 1. Theme manifest

Each theme ships a manifest:

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

For bundled/local themes, this can reuse the existing plugin installation and discovery flow. Later, theme packages can become a narrower plugin type.

### 2. Stable dashboard host context

Theme/plugin UI should receive a stable context object instead of importing dashboard internals directly:

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

The critical rule: every context-provided helper must be project-scoped. If a user selects the Fusion project, Goals, Compound Engineering artifacts, file browser, missions, tasks, and plugin routes must resolve against Fusion — not the previous/default project.

### 3. API client with mandatory project scoping

Instead of every component manually remembering to append `?projectId=...`, expose a scoped client:

```ts
const api = createDashboardApiClient({ projectId });
api.goals.list();
api.missions.list();
api.files.open("docs/plans/foo.md");
api.plugins.route("fusion-plugin-compound-engineering", "/artifacts");
```

This avoids the class of bugs where a project-aware view accidentally calls `/api/goals` or `/api/missions` without projectId.

### 4. Token-to-CSS bridge

Use CSS variables as the first compatibility layer:

```css
:root[data-fusion-theme="operator-console"] {
  --fusion-bg: #070a0f;
  --fusion-panel: #101722;
  --fusion-border: #243244;
  --fusion-accent: #80ffdb;
  --fusion-radius-card: 10px;
  --fusion-density-row: 32px;
}
```

Then progressively migrate dashboard surfaces from hardcoded styles to semantic variables.

### 5. Theme switcher

Add a settings control:

- Built-in theme: Current Fusion
- Built-in theme: Operator Console
- Built-in theme: Polished Product
- Plugin theme: any installed theme plugin

Theme selection should be project-scoped at first. Global default can come later.

## Why this matters

This gives maintainers a safe way to answer product questions with working UI instead of arguments:

- Should Fusion feel like an IDE, a mission control room, or a calm project cockpit?
- Does a dense board outperform a more editorial mission view?
- Can Compound Engineering feel like a first-class workflow instead of a side panel?
- Can plugins add serious UI without inheriting every dashboard coupling bug?

Right now those questions require invasive edits. A theme/plugin system turns them into experiments.

## Immediate evidence of need

While setting up Fusion as its own Fusion project, project scoping already showed cracks:

- Goals view appears to fetch `/api/goals` and `/api/missions` without threading the selected `projectId`.
- `MainContent` renders `<GoalsView anchorGoalId={...} onNavigateToMission={...} />` without passing `currentProject?.id`.
- `GoalsView` has no `projectId` prop and calls unscoped endpoints directly.
- Compound Engineering does receive `context.projectId` for artifact discovery, but artifact “Open” delegates to a generic `openFile(entry.path)` helper. That helper depends on the outer app’s current project/file modal scoping. This should be made explicit in the contract to avoid cross-project file confusion.

This is exactly the kind of bug a scoped dashboard host context should prevent.

## Feasibility spike

### Question 1: Can themes be CSS-token-only first?

Likely yes for color, radius, typography, density, and high-level feel.

Risk: many dashboard styles may be hardcoded and need gradual semantic-variable migration.

### Question 2: Can dashboard shells be plugin-provided?

Likely yes for bounded views. Existing plugin dashboard views already prove a plugin can render a surface inside Fusion.

Risk: full shell replacement may need a stricter contract for navigation, modals, file browser, project context, and auth.

### Question 3: Can this stay safe?

Yes if v1 separates:

- token themes: safe/static
- component variants: constrained React exports
- dashboard-shell plugins: explicit capabilities and host APIs

Do not give arbitrary theme code direct access to privileged internals.

## Proposed implementation slices

### Slice 1: Fix project-scoping regressions first

Before new theming work, selected-project correctness needs to be boring.

Acceptance criteria:

- Goals view receives `projectId`.
- Goals view appends projectId to goals, missions, linked-mission, create, update, link, unlink, archive, and description-draft calls.
- Regression tests prove Fusion project goals do not show Atlas Notes goals.
- Compound Engineering artifact discovery and file opening have tests that prove the selected project is threaded.

### Slice 2: Define dashboard extension contracts

Create docs and types for:

- `DashboardHostContext`
- scoped API client
- file actions
- navigation actions
- theme token schema
- DESIGN.md import/export and lint pipeline
- plugin/theme manifest fields

Acceptance criteria:

- plugin authors can understand what they may call;
- existing Compound Engineering view can be described in the contract;
- no plugin needs to import dashboard internals for normal host actions.

### Slice 3: Token theme registry

Add a small theme registry:

- built-in current/default theme
- built-in operator-console theme
- built-in polished-product theme
- project-scoped selection setting
- CSS variable injection
- `DESIGN.md` import from project root or theme package
- `@google/design.md` lint in the theme validation path
- optional export to Tailwind/DTCG JSON for implementation tooling

Acceptance criteria:

- switching theme changes visible dashboard tokens without reload;
- persisted per project;
- no task/mission data behavior changes.

### Slice 4: Migrate shared primitives to semantic tokens

Start with:

- ViewHeader
- cards
- buttons
- sidebar/nav
- kanban columns
- task cards
- modals

Acceptance criteria:

- two themes produce meaningfully different UI using the same component tree;
- screenshots can be compared in docs or visual tests.

### Slice 5: Optional shell experiment

Build one alternate shell behind an experimental flag:

- `operator-console`: dense, table/terminal-like, high signal per pixel
- or `polished-product`: calmer, bigger whitespace, less chrome

Acceptance criteria:

- same selected Fusion project data;
- same task/mission/goal actions;
- can be turned off without migration.

## Maintainer decision points

1. Should v1 define “theme” as DESIGN.md-backed tokens only, or include view/shell plugins from the start?
2. Should theme selection be global, per project, or both?
3. Should bundled themes live under `packages/dashboard` or `plugins/`?
4. Should plugin dashboard views be required to use a scoped host API client instead of raw `fetch`?
5. How strict should the security boundary be for local theme code?
6. Should Fusion ship a DESIGN.md browser/importer for community systems from designmd.ai, or only support local files first?

## Recommended first move

Do not start with a giant theme framework.

Start with:

1. fix project scoping bugs;
2. define the scoped dashboard host context;
3. add token theme registry and two bundled visual themes;
4. only then test whether shell-level plugins are worth the extra complexity.

That sequence compounds. It improves the dashboard immediately, reduces future plugin bugs, and creates room for UI experimentation without destabilizing the backend.
