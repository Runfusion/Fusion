# fusion-plugin-dependency-graph

Plugin-provided top-level **Graph** dashboard view for Fusion.

## Host registration and bundled loading

The dependency graph view is registered as a **bundled plugin view** in the dashboard. This means:

- `registerBundledPluginViews()` (called at dashboard startup) registers the view component in the static plugin view registry under key `plugin:fusion-plugin-dependency-graph:graph`.
- The view component is resolved via a **literal-specifier lazy import** (`import("@fusion-plugin-examples/dependency-graph/dashboard-view")`) — this is critical for Vite/esbuild to emit a production chunk.
- In Vite dev/build and Vitest, `@fusion-plugin-examples/dependency-graph/dashboard-view` is aliased to `plugins/fusion-plugin-dependency-graph/src/dashboard-view.tsx` (source, not `dist/`). This avoids stale dist artifacts breaking the dashboard view.
- The App.tsx graph route resolves to the bundled view via `isPluginViewRegistered` fallback, so the graph view works even when the plugin is not installed/loaded through the PluginLoader API (e.g. fresh DB).
- The canonical route ID is `plugin:fusion-plugin-dependency-graph:graph`.

## Rendering approach

- **Filtering**: includes `triage`, `todo`, `in-progress`, `in-review`; excludes `done`, `archived`
- **Graph build**: edges are resolved only from `task.dependencies` as `source=dependent`, `target=dependency`
- **Orphan dependency handling**: if a visible task depends on an excluded/missing dependency (for example `done`/`archived` after filtering), the missing edge is silently dropped and graph rendering continues without broken connectors
- **Auto-layout**: Sugiyama-style layered layout (`computeAutoLayout`) groups nodes by dependency depth and spaces layers consistently
- **Edge drawing**: SVG bezier curves from source bottom-center to target top-center, with arrowheads showing dependent → dependency direction
- **Interaction**: drag-to-pan canvas background, scroll/two-finger pan, Ctrl/Cmd-wheel zoom, pinch-to-zoom with stationary midpoint, drag-to-reposition nodes, keyboard shortcuts, zoom toolbar, reset, and fit-to-graph
- **Zoomed navigation reachability**: pan clamping now scales with the full rendered graph bounds (min/max node extents) at the active zoom level, so zooming in no longer traps off-screen content behind fixed viewport-only limits
- **Fit-to-graph**: computes node bounding box from both minimum and maximum node coordinates (including negative auto-layout origins) with layout node dimensions and applies zoom/pan so the graph fits in viewport with padding
- **Initial auto-fit**: when no saved scoped positions exist, the first non-empty render auto-fits once; subsequent updates preserve user navigation state
- **Position persistence**: dragged node positions are stored per project in browser localStorage and restored on reload
- **Animated transitions**: fit/reset operations animate `transform` (`var(--transition-normal)`), while continuous drag/wheel/pinch stays transition-free for responsiveness
- **Node rendering**: each graph node renders the real dashboard `TaskCard` via `GraphTaskNode` (no duplicated card markup)
- **Task detail integration**: a primary non-drag click on a graph node surface opens the native dashboard task detail modal exactly once through host context (`openTaskDetail`), matching board/list behavior
- **In-progress behavior**: steps are visible by default and active-task glow (`agent-active`) is preserved because node cards reuse TaskCard directly
- **Active-state indicator bar**: active nodes render a compact top bar (`.graph-task-active-indicator`) with the current execution status label (for example `Executing`, `Planning`) and pulsing `--in-progress` emphasis
- **Current-step highlighting**: active nodes set `data-current-step` for valid native step indices so CSS selectors highlight the currently executing `.card-step-item` and pulse its step dot
- **Zoom-out differentiation**: `.graph-task-node--active` adds amplified glow and subtle scale/border tint so active nodes remain distinguishable at reduced zoom levels
- **In-review visual treatment**: `in-review` nodes get a static `.graph-task-node--in-review` left accent in `--in-review` to distinguish waiting-review work from active execution nodes
- **Graph node classes**: `.graph-task-node`, `.graph-task-node--active`, `.graph-task-node--in-review`, `.graph-task-node--highlighted`, `.graph-task-node--dimmed`, `.graph-node--highlighted`, and `.graph-node--dimmed` are available for graph-specific layering/highlight states while card internals remain owned by `TaskCard.css`
- **Graph edge classes**: `.graph-edge--highlighted` and `.graph-edge--dimmed` are applied during dependency-chain emphasis states
- **Drag behavior**: graph nodes pass `disableDrag={true}` to `TaskCard` so card-level HTML5 drag does not conflict with canvas pan/zoom

## Position persistence

- Canonical base key: `fusion-plugin-dependency-graph:positions`
- Storage key format: `kb:${projectId}:fusion-plugin-dependency-graph:positions` (falls back to `fusion-plugin-dependency-graph:positions` when no project is selected)
- Read path: positions load on graph mount and whenever `projectId` changes, then merge with fresh auto-layout so new tasks still receive layout defaults
- Write path: positions persist on drag end only (not on every drag frame), filtered to currently visible tasks for stale cleanup
- Reset behavior: Fit to graph / Reset view clear persisted positions and re-apply auto-layout
- Implementation detail: the plugin now reuses dashboard `projectStorage` helpers (`getScopedItem` / `setScopedItem` / `removeScopedItem`) instead of duplicating scoped localStorage logic

## Dependency chain highlighting

- **Hover** a node to highlight the full transitive upstream + downstream chain for that task.
- **Click** a node to persist selection highlighting until the same node is clicked again or the canvas pane is clicked; this same click also opens task detail once through the host detail callback.
- **Priority**: hover state overrides selected state; when hover leaves, selected highlighting reappears.
- **Dimming**: when a chain is active, unrelated nodes and edges are dimmed.
- **Neutral state**: when nothing is hovered/selected, no highlight/dim classes are applied.
- **Drag suppression**: drag movements above the node drag threshold suppress the post-drag click, preventing accidental detail opens on pointer release.
- **Edge rule**: an edge is highlighted only when both its source and target nodes are in the active chain.

## Controls

### Toolbar (bottom-right)

- **Zoom in** (`ZoomIn`) — button + `Ctrl+=` / `Cmd+=`
- **Zoom out** (`ZoomOut`) — button + `Ctrl+-` / `Cmd+-`
- **Zoom percent label** — live readout (for example `100%`, `75%`, `250%`)
- **Fit to graph** (`Maximize`) — button + `Ctrl+Shift+F` / `Cmd+Shift+F`
- **Reset view** (`RotateCcw`) — button + `Ctrl+0` / `Cmd+0`

### Additional keyboard behavior

- **Escape** resets to default view (`zoom=1`, `pan=0,0`)
- Shortcuts are suppressed when focus is inside `input`, `textarea`, `select`, or `contentEditable` elements

All controls are rendered as floating `.btn-icon` actions in the bottom-right corner, with mobile-friendly `44px` touch targets in the `@media (max-width: 768px)` override.
