# Task: KB-634 - Dashboard UI: Mission List, Detail View, and Timeline

**Created:** 2026-04-01
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is the primary user-facing surface for the Missions system. It involves complex UI components with hierarchical display, drag-and-drop, and inline editing. Must follow existing dashboard component patterns from TaskList and TaskDetailModal.

**Score:** 5/8 — Blast radius: 2 (new components, minimal existing changes), Pattern novelty: 1 (extends existing modal/panel patterns), Security: 1 (UI only), Reversibility: 1 (new components)

## Mission

Create the main dashboard UI surfaces for the Missions system: a mission list/overview page showing all missions with aggregate progress, a hierarchical detail view for drilling into mission → milestone → slice → feature, and a timeline/roadmap visualization. This is the primary interface users will interact with for large-scale project planning.

## Dependencies

- **Task:** KB-632 — Missions Foundation (Database Schema, Types, and Core Store)
  - MissionStore with CRUD operations must be complete
  - Mission types and status enums available from `@fusion/core`
  - Verify exports exist: `Mission`, `MissionWithHierarchy`, `Milestone`, `Slice`, `MissionFeature`, `MissionStatus`, `MilestoneStatus`, `SliceStatus`, `FeatureStatus`
- **Task:** KB-633 — Mission REST API and Interview System
  - REST API endpoints at `/api/missions/*` must be functional
  - API client functions available in `packages/dashboard/app/api.ts`
  - Verify exports exist: `fetchMissions`, `fetchMission`, `createMission`, `updateMission`, `deleteMission`, `fetchMilestones`, `createMilestone`, `updateMilestone`, `reorderMilestones`, `fetchSlices`, `createSlice`, `updateSlice`, `activateSlice`, `reorderSlices`, `fetchFeatures`, `createFeature`, `updateFeature`, `linkFeatureToTask`
  - Verify SSE events emit from server: `mission:created`, `mission:updated`, `mission:deleted`

## Context to Read First

1. `packages/dashboard/app/components/TaskDetailModal.tsx` — Review modal structure, tabs, inline editing patterns, and close handling
2. `packages/dashboard/app/components/Board.tsx` — Understand board layout and filtering patterns
3. `packages/dashboard/app/components/Header.tsx` — Study header component structure for adding mission indicator
4. `packages/dashboard/app/hooks/useTasks.ts` — Review data fetching patterns, SSE event handling, optimistic updates (lines 95-120 for rollback pattern)
5. `packages/dashboard/app/api.ts` — Reference existing API client patterns
6. `packages/dashboard/app/App.tsx` — Understand how modals are integrated and state is managed; check for existing keyboard shortcuts

## File Scope

**New Files:**
- `packages/dashboard/app/components/MissionListModal.tsx` — Mission overview/list UI
- `packages/dashboard/app/components/MissionDetailModal.tsx` — Hierarchical tree view with editing
- `packages/dashboard/app/components/MissionTimeline.tsx` — Gantt-style visualization
- `packages/dashboard/app/components/MissionCard.tsx` — Mission card component for grid display
- `packages/dashboard/app/hooks/useMissions.ts` — Data fetching hook for missions with SSE support
- `packages/dashboard/app/components/__tests__/MissionListModal.test.tsx` — Component tests
- `packages/dashboard/app/components/__tests__/MissionDetailModal.test.tsx` — Component tests
- `packages/dashboard/app/components/__tests__/MissionCard.test.tsx` — Component tests
- `packages/dashboard/app/components/__tests__/MissionTimeline.test.tsx` — Component tests
- `packages/dashboard/app/hooks/__tests__/useMissions.test.ts` — Hook tests

**Modified Files:**
- `packages/dashboard/app/components/Header.tsx` — Add mission progress indicator button
- `packages/dashboard/app/components/Board.tsx` — Add mission filtering capability
- `packages/dashboard/app/App.tsx` — Integrate mission modals and keyboard shortcuts

## Steps

### Step 0: Preflight

- [ ] KB-632 complete: MissionStore and types available from `@fusion/core`
- [ ] KB-633 complete: REST API endpoints functional at `/api/missions/*`
- [ ] Import types from `@fusion/core` verified:
  ```typescript
  import type { 
    Mission, 
    MissionWithHierarchy, 
    MissionWithProgress,
    Milestone, 
    Slice, 
    MissionFeature,
    MissionStatus,
    MilestoneStatus,
    SliceStatus,
    FeatureStatus
  } from "@fusion/core";
  ```
- [ ] API client functions verified in `packages/dashboard/app/api.ts`:
  - Mission CRUD: `fetchMissions`, `fetchMission`, `createMission`, `updateMission`, `deleteMission`
  - Milestone: `fetchMilestones`, `createMilestone`, `updateMilestone`, `deleteMilestone`, `reorderMilestones`
  - Slice: `fetchSlices`, `createSlice`, `updateSlice`, `deleteSlice`, `activateSlice`, `reorderSlices`
  - Feature: `fetchFeatures`, `createFeature`, `updateFeature`, `deleteFeature`, `linkFeatureToTask`, `unlinkFeatureToTask`
- [ ] SSE events verified: Server emits `mission:created`, `mission:updated`, `mission:deleted` events
- [ ] Run `pnpm typecheck` in packages/dashboard — must pass with existing code
- [ ] No existing keyboard shortcut conflicts with Cmd/Ctrl+Shift+M in App.tsx

### Step 1: Mission Data Hook

- [ ] Create `packages/dashboard/app/hooks/useMissions.ts`:
  - `useMissions()` hook returning `{ missions, loading, error, refresh }`
  - Initial fetch on mount via `fetchMissions()` API
  - Poll for updates every 30 seconds using `setInterval`
  - Expose `refresh()` for manual refetch
  - Handle loading and error states with proper typing
- [ ] Create `useMission(id: string)` hook for single mission with hierarchy:
  - Returns `{ mission, loading, error, refresh }` where mission is `MissionWithHierarchy | undefined`
  - Uses `fetchMission(id)` to get full hierarchy including milestones, slices, features
  - Auto-refresh on window focus (`visibilitychange` event)
- [ ] Add SSE event listeners for real-time updates:
  - Listen for "mission:created", "mission:updated", "mission:deleted" events via existing SSE connection
  - Extend event handlers in `useMissions` to update local state when events received
  - Follow the timestamp-based freshness comparison from `useTasks.ts` lines 95-120
- [ ] Export both hooks from module
- [ ] Create test file `packages/dashboard/app/hooks/__tests__/useMissions.test.ts`:
  - Test initial fetch on mount
  - Test polling behavior
  - Test SSE event handling
  - Test error states

**Artifacts:**
- `packages/dashboard/app/hooks/useMissions.ts` (new)
- `packages/dashboard/app/hooks/__tests__/useMissions.test.ts` (new)

### Step 2: Mission Card Component

- [ ] Create `MissionCard.tsx` component:
  - Props interface: `{ mission: MissionWithProgress; onClick: () => void }`
  - Uses `MissionWithProgress` type from `@fusion/core` (has progress fields)
  - Layout: card container with left border color-coded by status
  - Shows: mission title (bold), description (truncated to 2 lines), status badge
- [ ] Status badge component (inline or separate):
  - "planning" — gray/blue border and badge
  - "active" — green border and badge
  - "blocked" — red/orange border and badge  
  - "complete" — purple border and badge
- [ ] Progress display:
  - Show dual progress bars: milestones complete / total, features done / total
  - Or single combined progress metric (features done / total features)
  - Percentage label next to bars
- [ ] Styling follows existing card patterns (border-radius, shadows, hover states)
- [ ] Click handler triggers `onClick` prop
- [ ] Create test file `packages/dashboard/app/components/__tests__/MissionCard.test.tsx`:
  - Test rendering with different statuses
  - Test progress bar display
  - Test click handler invocation

**Artifacts:**
- `packages/dashboard/app/components/MissionCard.tsx` (new)
- `packages/dashboard/app/components/__tests__/MissionCard.test.tsx` (new)

### Step 3: Mission List Modal

- [ ] Create `MissionListModal.tsx`:
  - Props: `{ isOpen: boolean; onClose: () => void; onSelectMission: (id: string) => void; onCreateMission: () => void }`
  - Large modal (follow `TaskDetailModal` sizing patterns)
  - Header: title "Missions", close button (×), "New Mission" button (primary)
- [ ] Use `useMissions()` hook for data fetching:
  - Show loading skeletons while `loading` is true
  - Show error message with retry button if `error` exists
- [ ] Grid layout for mission cards:
  - CSS Grid with responsive columns: 1 col mobile, 2 col tablet, 3 col desktop
  - Gap between cards following design system
- [ ] Empty state:
  - Icon (Target or Flag from lucide-react)
  - "No missions yet" heading
  - "Create your first mission to start tracking large-scale goals" description
  - "Create Mission" CTA button
- [ ] Search/filter bar in header:
  - Text input for searching by title/description
  - Status filter tabs: All, Active, Planning, Complete, Blocked
  - Sort dropdown: Recent, Name (A-Z), Progress (high-low)
- [ ] Clicking a mission card calls `onSelectMission(mission.id)`
- [ ] "New Mission" button calls `onCreateMission()`
- [ ] Escape key closes modal
- [ ] Create test file `packages/dashboard/app/components/__tests__/MissionListModal.test.tsx`:
  - Test open/close behavior
  - Test mission selection callback
  - Test filter and search functionality
  - Test empty state rendering

**Artifacts:**
- `packages/dashboard/app/components/MissionListModal.tsx` (new)
- `packages/dashboard/app/components/__tests__/MissionListModal.test.tsx` (new)

### Step 4: Mission Detail Modal — Structure and Header

- [ ] Create `MissionDetailModal.tsx` shell:
  - Props: `{ isOpen: boolean; onClose: () => void; missionId: string; onInterview?: (missionId: string) => void; onInterviewMilestone?: (milestoneId: string) => void }`
  - Large modal (80vw width, 90vh height max)
  - Layout: left sidebar (300px) + main content area (flex: 1)
- [ ] Header section:
  - Editable mission title (inline edit on click, Enter to save, Escape to cancel)
  - Editable description (textarea inline edit)
  - Status badge with dropdown to change status (follow TaskDetailModal column badge pattern)
  - Action buttons: Interview (lightbulb icon), Delete (trash icon)
- [ ] Left sidebar (hierarchical tree):
  - Collapsible sections for each hierarchy level
  - Visual tree indicators showing parent-child relationships
  - Each node shows: icon, title, status indicator dot
  - Click node to expand/collapse and show details in main area
- [ ] Use `useMission(missionId)` hook to load data
- [ ] Show loading state while fetching, error state with retry

**Artifacts:**
- `packages/dashboard/app/components/MissionDetailModal.tsx` (new — structure)

### Step 5: Milestone Display and Editing

- [ ] Milestone list section in sidebar/main area:
  - Display milestones in order (use `orderIndex` for sorting)
  - Each milestone row shows: order number, title, status badge, progress indicator
  - Expand/collapse to show slices within milestone
- [ ] Inline milestone editing:
  - Click title to edit (input field replaces text)
  - Click description to edit (textarea)
  - Status dropdown with `MilestoneStatus` values
  - "Add Milestone" button at bottom of list
  - "Delete" button with confirmation dialog
- [ ] Milestone progress calculation:
  - Compute from slices: complete slices / total slices
  - Visual mini progress bar
- [ ] API integration:
  - Use `updateMilestone`, `createMilestone`, `deleteMilestone` from API
  - Optimistic UI updates (update local state before API confirms)
  - Error handling with toast notifications via `useToast`
- [ ] Interview integration:
  - "Interview" button on each milestone calls `onInterviewMilestone(milestoneId)`

**Artifacts:**
- `packages/dashboard/app/components/MissionDetailModal.tsx` (milestones expanded)

### Step 6: Slice Display and Activation

- [ ] Slice section within milestones (when expanded):
  - List slices in `orderIndex` order
  - Each slice shows: title, status badge, feature count
  - Visual distinction for active slice (highlighted background)
- [ ] Inline slice editing:
  - Editable title and description (same pattern as milestones)
  - Status dropdown with `SliceStatus` values
  - "Add Slice" button at milestone level
  - "Delete" button with confirmation
- [ ] Slice activation UI:
  - "Activate" button for slices with status "pending"
  - Confirmation dialog: "Activating this slice will create tasks for all linked features. Continue?"
  - Call `activateSlice(id)` API on confirm
  - After activation: status changes to "active", show `activatedAt` timestamp
- [ ] Feature count display:
  - Show "{n} features" label on each slice row
  - Breakdown: {defined} defined, {triaged} triaged, {in-progress} active, {done} done

**Artifacts:**
- `packages/dashboard/app/components/MissionDetailModal.tsx` (slices expanded)

### Step 7: Feature Display and Task Linking

- [ ] Feature section within slices (when slice expanded):
  - List features in creation order
  - Each feature shows: title, status indicator, linked task reference
- [ ] Feature inline editing:
  - Editable title and description
  - Editable acceptance criteria (textarea)
  - "Add Feature" button at slice level
  - "Delete" button with confirmation
- [ ] Status visualization:
  - Visual indicator showing progression: defined → triaged → in-progress → done
  - Color coding: gray → blue → yellow → green
- [ ] Task linking:
  - "Create Task" button for features with no linked task
  - Opens task creation flow (reuse existing `NewTaskModal` or inline form)
  - Pre-fills task title/description from feature data
  - On creation, calls `linkFeatureToTask(featureId, taskId)`
  - Shows linked task ID with clickable link to open task detail
- [ ] Feature status sync:
  - Display linked task status
  - Show warning if feature status doesn't match task status

**Artifacts:**
- `packages/dashboard/app/components/MissionDetailModal.tsx` (features expanded)

### Step 8: Drag-and-Drop Reordering

- [ ] Implement drag-and-drop for milestones:
  - Add drag handle (grip icon from lucide-react) on each milestone row
  - Use HTML5 Drag and Drop API (no external libraries needed)
  - `draggable="true"` on rows with drag handle as handle
  - Visual feedback during drag: opacity 0.5 on dragged item, border highlight on drop target
  - Drop zones between milestones (insertion indicators)
- [ ] Implement drag-and-drop for slices:
  - Same pattern as milestones but within milestone scope
  - Drag handle on each slice row
  - Can only reorder within same milestone
- [ ] Reordering logic:
  - On drop, calculate new `orderIndex` values
  - Call `reorderMilestones(missionId, orderedIds)` or `reorderSlices(milestoneId, orderedIds)` API
  - Optimistic UI update: reorder immediately in state, rollback on error (follow `useTasks.ts` pattern lines 95-120)
- [ ] Keyboard accessibility:
  - Up/down arrow buttons as alternative to drag
  - `title` attributes explaining keyboard shortcuts
- [ ] Touch support (optional but nice):
  - Basic touch event handling for mobile

**Artifacts:**
- `packages/dashboard/app/components/MissionDetailModal.tsx` (complete with DND)

### Step 9: Mission Timeline Visualization

- [ ] Create `MissionTimeline.tsx`:
  - Props: `{ mission: MissionWithHierarchy; onSelectMilestone: (id: string) => void; onSelectSlice: (id: string) => void }`
  - Horizontal timeline layout using CSS Grid or flexbox
- [ ] Timeline layout:
  - X-axis: sequence position (not actual dates — purely order-based visualization)
  - Y-axis: swimlanes for milestones
  - Each milestone shown as horizontal bar spanning its slices
  - Slices shown as segments within milestone bars
- [ ] Visual elements:
  - Milestone bars with color by status
  - Slice segments with border separation
  - Legend for status colors
- [ ] Interactivity:
  - Click milestone bar to select (call `onSelectMilestone`)
  - Click slice segment to select (call `onSelectSlice`)
  - Hover tooltips showing title and status
- [ ] Progress indication:
  - Show completion percentage within each bar
  - Striped pattern for "active" items
- [ ] Empty/missing data handling:
  - Show placeholder when no milestones exist
  - Guidance text: "Add milestones to see timeline"
- [ ] Create test file `packages/dashboard/app/components/__tests__/MissionTimeline.test.tsx`:
  - Test rendering with mission data
  - Test click handlers
  - Test empty state

**Artifacts:**
- `packages/dashboard/app/components/MissionTimeline.tsx` (new)
- `packages/dashboard/app/components/__tests__/MissionTimeline.test.tsx` (new)

### Step 10: Board View Mission Filtering

- [ ] Modify `packages/dashboard/app/components/Board.tsx`:
  - Add `filterMission?: { type: 'mission' | 'milestone' | 'slice'; id: string }` prop
  - Add filter controls to board header (when not in search mode)
- [ ] Filter UI:
  - Dropdown button in board header showing current filter or "All Tasks"
  - Hierarchical menu: Missions → Milestones → Slices
  - "Clear Filter" button when filter active
- [ ] Filter logic:
  - When filtered by mission: show all tasks linked to that mission's features
  - When filtered by milestone: show tasks from that milestone's slices
  - When filtered by slice: show tasks from that slice's features
  - Tasks show their mission context when filtered
- [ ] URL integration:
  - Update URL query params when filter changes: `?filterMission=KB-M-001` (distinct from detail view param)
  - Read URL params on mount to restore filter
  - Use `URLSearchParams` for parsing/setting
- [ ] Visual indicators:
  - Show active filter as badge in header
  - Show filtered task count (e.g., "12 tasks")
- [ ] Integration with existing filters:
  - Mission filter combines with column filters (AND logic)
  - Search still works within mission filter

**Artifacts:**
- `packages/dashboard/app/components/Board.tsx` (modified)

### Step 11: Header Progress Indicator

- [ ] Modify `packages/dashboard/app/components/Header.tsx`:
  - Add props: `onOpenMissions?: () => void; activeMission?: { id: string; title: string; progress: number }`
- [ ] Progress badge component:
  - Compact display showing mission name (truncated) and mini progress bar
  - Position: left side of header actions (after logo)
  - Click to open mission detail
- [ ] Visual design:
  - Pill-shaped badge with mission status color
  - Mini progress bar (80px wide, 4px height)
  - Percentage text
  - Hover: show full mission name in tooltip
- [ ] Empty state:
  - When no active mission, show "Missions" button instead
  - Opens mission list on click
- [ ] Responsive behavior:
  - Collapse to icon-only on mobile
  - Show "M" badge with progress color

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 12: App Integration

- [ ] Modify `packages/dashboard/app/App.tsx`:
  - Add state: `missionListOpen: boolean`, `selectedMissionId: string | null`
  - Import `MissionListModal`, `MissionDetailModal`, `useMissions`
- [ ] Modal integration:
  - Add `MissionListModal` instance (conditional on `missionListOpen`)
  - Add `MissionDetailModal` instance (conditional on `selectedMissionId`)
  - Ensure modals don't overlap awkwardly (close list when opening detail)
- [ ] Keyboard shortcut:
  - Cmd/Ctrl+Shift+M opens mission list
  - Add to existing keyboard shortcut handler (verify no conflicts in App.tsx)
- [ ] Menu integration:
  - Add "Missions" menu item in header overflow menu
  - Position after "Agents" or similar
- [ ] URL routing:
  - Support `?mission=ID` query param to open specific mission detail on load (distinct from `?filterMission`)
  - Support `?mission=ID&milestone=ID` for deeper linking
  - Update URL when mission detail opened
  - Clean up URL when modal closed
- [ ] Active mission tracking:
  - Track most recently viewed mission in `sessionStorage`
  - Pass to Header as `activeMission` prop
  - Derive progress from `mission.milestones` and feature counts

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 13: Create Mission Detail Modal Tests

- [ ] Create test file `packages/dashboard/app/components/__tests__/MissionDetailModal.test.tsx`:
  - Test viewing full hierarchy rendering
  - Test inline editing of mission title/description
  - Test adding/editing/deleting milestones
  - Test adding/editing/deleting slices
  - Test adding/editing/deleting features
  - Test slice activation flow (confirmation → API call)
  - Test drag-and-drop reordering
  - Test keyboard reordering with arrow buttons
  - Test interview button callbacks
  - Test close and escape key handling

**Artifacts:**
- `packages/dashboard/app/components/__tests__/MissionDetailModal.test.tsx` (new)

### Step 14: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run all new tests:
  - `pnpm test packages/dashboard/app/hooks/__tests__/useMissions.test.ts`
  - `pnpm test packages/dashboard/app/components/__tests__/MissionCard.test.tsx`
  - `pnpm test packages/dashboard/app/components/__tests__/MissionListModal.test.tsx`
  - `pnpm test packages/dashboard/app/components/__tests__/MissionDetailModal.test.tsx`
  - `pnpm test packages/dashboard/app/components/__tests__/MissionTimeline.test.tsx`
- [ ] Run existing dashboard tests: `pnpm test` in packages/dashboard — all pass
- [ ] Run `pnpm typecheck` in packages/dashboard — zero errors
- [ ] Run `pnpm build` — successful build
- [ ] Manual verification checklist:
  - MissionListModal opens/closes correctly
  - MissionCard renders with correct status colors
  - MissionDetailModal shows full hierarchy
  - Inline editing works for all entity types
  - Drag-and-drop reordering works (milestones and slices)
  - Timeline renders with correct swimlanes
  - Board filtering by mission works
  - URL params restore state correctly
  - Header indicator shows progress
  - Keyboard shortcut (Cmd/Ctrl+Shift+M) works

### Step 15: Documentation & Delivery

- [ ] Add JSDoc comments to all components:
  - `MissionCard`: explain props, status color mapping
  - `MissionListModal`: explain callbacks and filtering
  - `MissionDetailModal`: explain hierarchy editing and DND
  - `MissionTimeline`: explain sequence-based (not date-based) visualization
  - `useMissions`: explain SSE integration and polling
- [ ] Add inline comments for complex logic:
  - Optimistic update rollback pattern
  - Drag-and-drop event handling
  - URL query param synchronization
- [ ] No changeset needed — `@fusion/dashboard` is a private package per AGENTS.md
- [ ] Commit: `feat(KB-634): complete Mission Dashboard UI`

## Documentation Requirements

**Must Update:**
- JSDoc comments on all public components and hooks
- Inline comments for complex optimistic update patterns

**Check If Affected:**
- No README changes needed yet (feature will be documented when fully integrated)
- No changeset needed (dashboard is private package)

## Completion Criteria

- [ ] All 15 steps complete
- [ ] MissionListModal showing all missions with progress and filtering
- [ ] MissionDetailModal with full hierarchy editing (milestones, slices, features)
- [ ] Drag-and-drop reordering for milestones and slices
- [ ] MissionTimeline visualization component
- [ ] Board filtering by mission/milestone/slice with URL integration
- [ ] Header progress indicator showing active mission
- [ ] Keyboard shortcuts (Cmd/Ctrl+Shift+M) working
- [ ] All test files created and passing
- [ ] Typecheck passing
- [ ] Build successful
- [ ] JSDoc comments added

## Git Commit Convention

- **Step completion:** `feat(KB-634): complete Step N — description`
- **Bug fixes:** `fix(KB-634): description`
- **Tests:** `test(KB-634): description`
- **Docs:** `docs(KB-634): add JSDoc comments`

## Do NOT

- Skip drag-and-drop accessibility (keyboard alternative required)
- Skip mobile responsiveness (test on narrow viewports)
- Skip loading and error states for all async operations
- Skip empty states when no data exists
- Modify existing task card component behavior
- Skip optimistic UI updates for reordering (users expect immediate feedback)
- Skip proper cleanup on modal close (event listeners, timers)
- Skip URL query param cleanup when closing mission detail
- Skip updating `updatedAt` timestamp on inline edits
- Access MissionStore directly from components — always use API layer
- Create changeset for private `@fusion/dashboard` package
