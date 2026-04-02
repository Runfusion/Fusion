# Task: KB-628c - Dashboard UI: Mission List, Detail View, and Timeline

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is the primary user-facing surface for the Missions system. It involves complex UI components with hierarchical display, drag-and-drop, and inline editing. Must follow existing dashboard component patterns.

**Score:** 5/8 — Blast radius: 2 (new components, minimal existing changes), Pattern novelty: 1 (extends existing modal/panel patterns), Security: 1 (UI only), Reversibility: 1 (new components)

## Mission

Create the main dashboard UI surfaces for the Missions system: a mission list/overview page showing all missions with aggregate progress, a hierarchical detail view for drilling into mission → milestone → slice → feature, and a timeline/roadmap visualization. This is the primary interface users will interact with for large-scale project planning.

## Dependencies

- **Task:** KB-628a — Database Schema, Types, and MissionStore
  - MissionStore with CRUD operations
  - Mission types and status enums
- **Task:** KB-628b — Mission REST API and Interview System
  - API client functions for missions
  - MissionInterviewModal component

## Context to Read First

1. `packages/dashboard/app/components/TaskList.tsx` — Study list view patterns, card layout, and progress indicators
2. `packages/dashboard/app/components/TaskDetailModal.tsx` — Review modal structure, tabs, and editable fields
3. `packages/dashboard/app/components/Board.tsx` — Understand board layout and filtering patterns
4. `packages/dashboard/app/components/PlanningModeModal.tsx` — Review interview modal UI patterns
5. `packages/dashboard/app/components/Header.tsx` — Study header component structure for adding mission indicator
6. `packages/dashboard/app/App.tsx` — Understand how modals are integrated into the app
7. `packages/dashboard/app/hooks/useTasks.ts` — Review data fetching patterns
8. `packages/dashboard/app/api.ts` — Reference mission API client functions from KB-628b

## File Scope

**New Files:**
- `packages/dashboard/app/components/MissionListModal.tsx` — Mission overview/list UI
- `packages/dashboard/app/components/MissionDetailModal.tsx` — Hierarchical tree view
- `packages/dashboard/app/components/MissionTimeline.tsx` — Gantt-style visualization
- `packages/dashboard/app/components/MissionCard.tsx` — Mission card component
- `packages/dashboard/app/hooks/useMissions.ts` — Data fetching hook for missions

**Modified Files:**
- `packages/dashboard/app/components/Header.tsx` — Add mission progress indicator
- `packages/dashboard/app/components/Board.tsx` — Add mission filtering
- `packages/dashboard/app/App.tsx` — Integrate mission modals

## Steps

### Step 1: Mission Data Hook

- [ ] Create `packages/dashboard/app/hooks/useMissions.ts`:
  - `useMissions()` hook returning `{ missions, loading, error, refresh }`
  - Uses `useEffect` to fetch missions on mount
  - Polls for updates every 30 seconds
  - Exposes `refresh()` for manual refetch
  - Handles loading and error states
- [ ] Create `useMission(id: string)` hook for single mission:
  - Returns `{ mission, loading, error, refresh }`
  - Fetches full hierarchy including milestones, slices, features
  - Auto-refresh on window focus
- [ ] Add mission event listeners:
  - Listen for "mission:created", "mission:updated", "mission:deleted" events via SSE
  - Auto-refresh when events received
- [ ] Follow `useTasks.ts` patterns for consistency

**Artifacts:**
- `packages/dashboard/app/hooks/useMissions.ts` (new)

### Step 2: Mission Card Component

- [ ] Create `MissionCard.tsx` component:
  - Props: `mission: MissionWithProgress`, `onClick: () => void`
  - Shows: mission title, description (truncated), status badge
  - Progress bar showing: % milestones complete, % features done
  - Visual indicator for mission status (color-coded border)
  - Compact layout suitable for grid display
- [ ] Status badge component:
  - "planning" — gray/blue
  - "active" — green
  - "blocked" — red/orange
  - "complete" — purple
- [ ] Progress calculation:
  - milestonesComplete / totalMilestones
  - featuresDone / totalFeatures
  - Dual progress bars or combined metric

**Artifacts:**
- `packages/dashboard/app/components/MissionCard.tsx` (new)

### Step 3: Mission List Modal

- [ ] Create `MissionListModal.tsx`:
  - Props: `isOpen`, `onClose`, `onSelectMission`, `onCreateMission`
  - Full-screen or large modal (follow TaskListModal pattern)
  - Header with title "Missions", close button, "New Mission" button
  - Grid layout of MissionCards (responsive: 1 col mobile, 2-3 col desktop)
- [ ] Empty state:
  - Illustration or icon when no missions exist
  - "Create your first mission" CTA button
  - Brief explanation of missions feature
- [ ] Loading state:
  - Skeleton cards while loading
  - Spinner for initial load
- [ ] Search/filter bar:
  - Filter by status (tabs: All, Active, Planning, Complete)
  - Text search by title/description
  - Sort options: Recent, Name, Progress
- [ ] Integration with `useMissions` hook
- [ ] Click mission card to open MissionDetailModal
- [ ] "New Mission" button opens MissionInterviewModal

**Artifacts:**
- `packages/dashboard/app/components/MissionListModal.tsx` (new)

### Step 4: Mission Detail Modal — Structure

- [ ] Create `MissionDetailModal.tsx`:
  - Props: `isOpen`, `onClose`, `missionId`, `onInterview`, `onActivateSlice`
  - Large modal with left sidebar (tree) and main content area
  - Tabs: Overview, Timeline, Tree (or use sidebar for navigation)
- [ ] Header section:
  - Mission title (editable inline)
  - Mission description (editable inline)
  - Status badge with dropdown to change status
  - Action buttons: Interview, Edit, Delete
- [ ] Left sidebar (hierarchical tree):
  - Collapsible tree: mission → milestones → slices → features
  - Visual indicators for status at each level
  - Click node to view details in main area
  - Expand/collapse controls

**Artifacts:**
- `packages/dashboard/app/components/MissionDetailModal.tsx` (new — skeleton)

### Step 5: Milestone Display and Editing

- [ ] Milestone section in detail modal:
  - List of milestones with order numbers
  - Each milestone shows: title, status, progress (slices/features)
  - Expand to show slices within milestone
- [ ] Inline milestone editing:
  - Click title to edit inline
  - Click description to edit
  - Status dropdown
  - "Add Milestone" button at bottom
  - "Delete" button with confirmation
- [ ] Milestone progress calculation:
  - Complete slices / total slices
  - Visual progress bar per milestone
- [ ] Interview integration:
  - "Interview" button on each milestone to launch re-interview
  - Opens MissionInterviewModal with milestone context

**Artifacts:**
- `packages/dashboard/app/components/MissionDetailModal.tsx` (expanded)

### Step 6: Slice Display and Activation

- [ ] Slice section within milestones:
  - List slices in order
  - Each slice shows: title, status, feature count, activation status
  - Visual distinction for active vs pending slices
- [ ] Slice inline editing:
  - Editable title and description
  - Status dropdown
  - "Add Slice" button
  - "Delete" button
- [ ] Slice activation UI:
  - "Activate" button for pending slices
  - Shows confirmation dialog explaining task creation
  - After activation: slice status changes to "active"
  - Displays linked task count (e.g., "3 tasks in triage")
- [ ] Auto-advance indicator:
  - When slice is complete, show "Auto-advance will activate next slice"
  - Visual indicator of which slice will activate next

**Artifacts:**
- `packages/dashboard/app/components/MissionDetailModal.tsx` (expanded)

### Step 7: Feature Display and Task Linking

- [ ] Feature section within slices:
  - List features with acceptance criteria
  - Each feature shows: title, description, linked task status
  - Visual indicator: defined → triaged → in-progress → done
- [ ] Feature inline editing:
  - Editable title and description
  - Editable acceptance criteria (textarea)
  - "Add Feature" button
  - "Delete" button
- [ ] Task linking:
  - "Create Task" button for unlinked features
  - Opens task creation with pre-filled details from feature
  - Shows linked task ID with link to task detail
  - Syncs feature status from linked task status

**Artifacts:**
- `packages/dashboard/app/components/MissionDetailModal.tsx` (expanded)

### Step 8: Drag-and-Drop Reordering

- [ ] Implement drag-and-drop for milestones:
  - Drag handle on each milestone row
  - Drop zones between milestones
  - Visual feedback during drag (opacity change, border highlight)
  - Call `reorderMilestones` API on drop
  - Optimistic UI update
- [ ] Implement drag-and-drop for slices:
  - Drag handle on each slice row
  - Drop zones between slices
  - Visual feedback during drag
  - Call `reorderSlices` API on drop
  - Optimistic UI update
- [ ] Use HTML5 drag and drop API or react-dnd if already in project
  - Check existing dependencies first
  - If no DND library, implement simple HTML5 API
- [ ] Keyboard accessibility:
  - Up/down arrow buttons as alternative to drag
  - Focus management for keyboard reordering

**Artifacts:**
- `packages/dashboard/app/components/MissionDetailModal.tsx` (complete)

### Step 9: Mission Timeline Visualization

- [ ] Create `MissionTimeline.tsx`:
  - Props: `mission: MissionWithHierarchy`, `onSelectMilestone`, `onSelectSlice`
  - Horizontal timeline showing milestones as sections
  - Milestones shown as bars with duration/position
  - Slices shown as sub-bars within milestones
  - Today marker line
  - Dependency lines between milestones (if dependencies defined)
- [ ] Layout options:
  - Gantt-style: horizontal bars on time axis
  - Swimlane: milestones as rows, slices as horizontal segments
  - Compact: vertical list with relative positioning
- [ ] Interactive elements:
  - Click milestone/slice to select and show details
  - Hover for tooltip with details
  - Zoom controls for time scale
- [ ] Status visualization:
  - Color coding by status
  - Progress indication within bars
  - Completed sections shown differently

**Artifacts:**
- `packages/dashboard/app/components/MissionTimeline.tsx` (new)

### Step 10: Board View Mission Filtering

- [ ] Modify `Board.tsx` to support mission filtering:
  - Add filter dropdown to board header
  - Options: "All Tasks", "Mission: [name]", "Milestone: [name]", "Slice: [name]"
  - Hierarchical filter: selecting mission shows all its tasks
- [ ] Filter state management:
  - Store current filter in URL query params (?mission=KB-M-001)
  - Persist filter in session storage
  - Clear filter button
- [ ] Visual filter indicator:
  - Show active filter as badge in header
  - Filtered task count
  - "Clear Filter" button
- [ ] Task grouping option:
  - When filtered by mission, optionally group by milestone/slice
  - Visual group headers
- [ ] Integration with existing task filtering:
  - Mission filter combines with existing column/status filters

**Artifacts:**
- `packages/dashboard/app/components/Board.tsx` (modified)

### Step 11: Header Progress Indicator

- [ ] Modify `Header.tsx` to add mission progress badge:
  - Compact progress indicator showing active mission
  - Badge with mission name and mini progress bar
  - Click to open MissionDetailModal
  - Dropdown menu for quick mission switch
- [ ] Progress calculation:
  - Features done / total features in active mission
  - Or milestones complete / total milestones
  - Real-time updates via polling or SSE
- [ ] Active mission determination:
  - Most recently updated mission with status "active"
  - Or mission most recently viewed
  - Store preference in localStorage
- [ ] Header integration:
  - Add to existing header layout (left of other controls)
  - Collapsible on mobile
  - Theme-aware styling

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 12: App Integration

- [ ] Modify `App.tsx` to integrate mission modals:
  - Add state for `missionListOpen`, `selectedMissionId`
  - Add `MissionListModal` instance
  - Add `MissionDetailModal` instance (conditional on selectedMissionId)
  - Add keyboard shortcut: Cmd/Ctrl+Shift+M opens mission list
- [ ] Add menu items:
  - "Missions" menu item in header dropdown
  - Opens mission list modal
- [ ] Route/URL integration:
  - Support ?mission=ID to open specific mission detail on load
  - Update URL when mission detail opened
- [ ] Ensure all modals close properly and don't overlap

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 13: Testing & Verification

> ZERO test failures allowed.

- [ ] Test MissionListModal:
  - Open/close
  - Create new mission (opens interview)
  - Select mission to open detail
  - Filter by status
  - Search functionality
- [ ] Test MissionDetailModal:
  - View full hierarchy
  - Edit mission title/description
  - Add/edit/delete milestones
  - Add/edit/delete slices
  - Add/edit/delete features
  - Activate slice
  - Drag-and-drop reordering
  - Interview buttons
- [ ] Test MissionTimeline:
  - Timeline renders correctly
  - Milestone bars positioned properly
  - Click to select works
- [ ] Test Board filtering:
  - Filter by mission shows correct tasks
  - URL params work
  - Clear filter works
- [ ] Test Header indicator:
  - Shows active mission progress
  - Click opens detail
- [ ] Run `pnpm test` in dashboard package
- [ ] Run `pnpm typecheck` — zero errors
- [ ] Run `pnpm build` — successful

### Step 14: Documentation & Delivery

- [ ] Create changeset file:
  ```bash
  cat > .changeset/missions-dashboard-ui.md << 'EOF'
  ---
  "@fusion/dashboard": minor
  ---
  
  Add Mission dashboard UI: mission list, detail view with hierarchical tree, timeline visualization, and board filtering.
  EOF
  ```
- [ ] Add JSDoc comments to all components
- [ ] Commit: `feat(KB-628c): complete Mission Dashboard UI`

## Documentation Requirements

**Must Update:**
- Changeset file as shown above

**Check If Affected:**
- No README changes needed yet

## Completion Criteria

- [ ] All 14 steps complete
- [ ] MissionListModal showing all missions with progress
- [ ] MissionDetailModal with full hierarchy editing
- [ ] MissionTimeline visualization
- [ ] Board filtering by mission/milestone/slice
- [ ] Header progress indicator
- [ ] All tests passing
- [ ] Typecheck passing
- [ ] Changeset created

## Git Commit Convention

- **Step completion:** `feat(KB-628c): complete Step N — description`
- **Bug fixes:** `fix(KB-628c): description`
- **Tests:** `test(KB-628c): description`

## Do NOT

- Skip drag-and-drop accessibility (keyboard alternative)
- Skip mobile responsiveness
- Skip loading and error states
- Skip empty states
- Modify existing task card component behavior
- Skip optimistic UI updates for reodering
- Skip proper cleanup on modal close
