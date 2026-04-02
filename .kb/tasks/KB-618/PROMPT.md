# Task: KB-618 - Dashboard Multi-Project UX

**Created:** 2026-03-31
**Size:** L

## Review Level: 3 (Full)

**Assessment:** Large surface area touching routing, new UI components, API endpoints, and integration with CentralCore. Multi-project management is a core feature requiring thorough review.
**Score:** 7/8 — Blast radius: 2, Pattern novelty: 2, Security: 2, Reversibility: 1

## Mission

Implement the Dashboard Multi-Project UX to enable users to manage multiple kb projects from a unified interface. This includes a new overview page showing all registered projects with health indicators, drill-down navigation to individual project boards, an interactive setup wizard for adding projects, and a unified activity feed across all projects. This is the dashboard frontend that consumes the CentralCore API (KB-615) and ProjectRuntime abstractions (KB-616).

## Dependencies

- **Task:** KB-616 (Per-Project Runtime Abstraction) — must provide CentralCore API access via `ProjectManager` or similar interface with methods like `listProjects()`, `registerProject()`, `getProjectHealth()`, etc.

## Context to Read First

1. `packages/dashboard/app/App.tsx` — Current app structure, understand how single-project mode works
2. `packages/dashboard/app/api.ts` — Existing API patterns and type conventions
3. `packages/dashboard/app/components/Header.tsx` — Header component patterns, navigation structure
4. `packages/dashboard/src/routes.ts` — Server-side API route patterns (around line 1500-1700 for task endpoints)
5. `packages/dashboard/src/server.ts` — Server initialization and how TaskStore is passed to routes
6. `packages/core/src/types.ts` — Type definitions, especially ActivityLogEntry and related types

## File Scope

- `packages/dashboard/app/routes/overview.tsx` (new)
- `packages/dashboard/app/routes/projects/$projectId/board.tsx` (new)
- `packages/dashboard/app/routes/projects/$projectId/list.tsx` (new)
- `packages/dashboard/app/components/ProjectCard.tsx` (new)
- `packages/dashboard/app/components/SetupWizard.tsx` (new)
- `packages/dashboard/app/components/ActivityFeed.tsx` (new)
- `packages/dashboard/app/components/ProjectSwitcher.tsx` (new)
- `packages/dashboard/app/components/FirstRunModal.tsx` (new)
- `packages/dashboard/app/api.ts` (add project API methods)
- `packages/dashboard/app/App.tsx` (modify for routing, project context)
- `packages/dashboard/src/routes.ts` (add project API endpoints)
- `packages/dashboard/src/server.ts` (inject CentralCore into route context)

## Steps

### Step 1: Core Types and API Layer

- [ ] Read CentralCore types from KB-616 output (ProjectInfo, ProjectHealth, ActivityFeedEntry)
- [ ] Add project API methods to `packages/dashboard/app/api.ts`:
  - `fetchProjects(): Promise<ProjectInfo[]>`
  - `registerProject(input: ProjectCreateInput): Promise<ProjectInfo>`
  - `unregisterProject(id: string): Promise<void>`
  - `fetchProjectHealth(id: string): Promise<ProjectHealth>`
  - `fetchActivityFeed(options?: FeedOptions): Promise<ActivityFeedEntry[]>`
  - `pauseProject(id: string): Promise<ProjectInfo>`
  - `resumeProject(id: string): Promise<ProjectInfo>`
  - `fetchFirstRunStatus(): Promise<{ hasProjects: boolean; singleProjectPath: string | null }>`
- [ ] Add TypeScript types for all project-related API payloads
- [ ] Write unit tests for new API methods in `packages/dashboard/app/api.test.ts`

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/app/api.test.ts` (modified)

### Step 2: Server-Side API Routes

- [ ] Add project management endpoints to `packages/dashboard/src/routes.ts`:
  - `GET /api/projects` — list all projects with health metrics
  - `POST /api/projects` — register new project (body: `{ name, workingDirectory, isolationMode }`)
  - `DELETE /api/projects/:id` — unregister project
  - `GET /api/projects/:id/health` — detailed health for single project
  - `GET /api/activity-feed` — unified activity feed with query params (`limit`, `since`, `projectId`)
  - `POST /api/projects/:id/pause` — pause project runtime
  - `POST /api/projects/:id/resume` — resume project runtime
  - `GET /api/first-run-status` — detect if user has projects or needs migration
- [ ] Integrate CentralCore into route handlers (access via `options.centralCore`)
- [ ] Add request validation for project creation (directory exists, has `.fusion/` or offer init)
- [ ] Write tests for new endpoints in `packages/dashboard/src/routes.test.ts`

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 3: ProjectCard Component

- [ ] Create `packages/dashboard/app/components/ProjectCard.tsx`:
  - Props interface with `project: ProjectInfo`, `health: ProjectHealth`, `onSelect`, `onPause`, `onResume`, `onRemove`
  - Visual design: Card with project name, working directory path (truncated), status badge
  - Status badges: "active" (green), "paused" (yellow), "errored" (red)
  - Task count bar showing triage/todo/in-progress/in-review/done counts
  - Last activity timestamp (relative time like "2h ago")
  - Quick action buttons: pause/resume toggle, open (drill down), remove
  - Hover states and loading states for async actions
- [ ] Create CSS classes in `packages/dashboard/app/styles.css` (or use existing Tailwind-style classes)
- [ ] Write component tests in `packages/dashboard/app/components/__tests__/ProjectCard.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/ProjectCard.tsx` (new)
- `packages/dashboard/app/components/__tests__/ProjectCard.test.tsx` (new)

### Step 4: ActivityFeed Component

- [ ] Create `packages/dashboard/app/components/ActivityFeed.tsx`:
  - Props: `entries: ActivityFeedEntry[]`, `projectNames: Record<string, string>` (for display)
  - Timeline-style list with chronological order
  - Entry types: task created, moved, completed, failed, merged, project paused/resumed
  - Each entry shows: timestamp, project name badge, event description, task link (if applicable)
  - Auto-refresh every 30 seconds via polling
  - Empty state when no activity
- [ ] Add loading and error states
- [ ] Write component tests

**Artifacts:**
- `packages/dashboard/app/components/ActivityFeed.tsx` (new)
- `packages/dashboard/app/components/__tests__/ActivityFeed.test.tsx` (new)

### Step 5: SetupWizard Component

- [ ] Create `packages/dashboard/app/components/SetupWizard.tsx`:
  - Props: `isOpen: boolean`, `onClose: () => void`, `onProjectCreated: (project: ProjectInfo) => void`
  - Multi-step wizard UI:
    - Step 1: Directory selection (text input with browse button, validation)
    - Step 2: Project name (auto-suggested from directory basename, editable)
    - Step 3: Isolation mode (in-process default, child-process opt-in with explanation)
    - Step 4: Validation (check `.fusion/` exists, offer to initialize if missing)
    - Step 5: Summary and confirmation
  - Navigation: Back/Next buttons, Cancel, Create Project
  - Validation errors displayed inline
  - Loading state during creation
- [ ] Use existing modal styling patterns from other components (SettingsModal, etc.)
- [ ] Write component tests

**Artifacts:**
- `packages/dashboard/app/components/SetupWizard.tsx` (new)
- `packages/dashboard/app/components/__tests__/SetupWizard.test.tsx` (new)

### Step 6: Overview Page

- [ ] Create `packages/dashboard/app/routes/overview.tsx`:
  - Main layout: Header with "Projects" title, "Add Project" button, global search
  - Grid of ProjectCard components (responsive: 1 col mobile, 2 col tablet, 3 col desktop)
  - Global concurrency indicator: "X of Y agents active across Z projects"
  - ActivityFeed section at bottom (collapsible)
  - Empty state when no projects (prompt to add first project)
  - Loading skeleton while fetching projects
- [ ] Fetch projects and health on mount, refresh every 30 seconds
- [ ] Handle project selection: navigate to `/projects/:projectId/board`
- [ ] Implement "Add Project" button opening SetupWizard

**Artifacts:**
- `packages/dashboard/app/routes/overview.tsx` (new)

### Step 7: Project Switcher and Drill-Down Routes

- [ ] Create `packages/dashboard/app/components/ProjectSwitcher.tsx`:
  - Dropdown button showing current project name
  - List of all projects with status indicators
  - Quick navigation to overview
  - Search/filter within project list
- [ ] Create `packages/dashboard/app/routes/projects/$projectId/board.tsx`:
  - Wrap existing Board component with project context
  - Fetch tasks for specific project via `fetchProjectTasks(projectId)` API
  - Show ProjectSwitcher in header instead of global navigation
  - Breadcrumb: "Projects > {ProjectName} > Board"
- [ ] Create `packages/dashboard/app/routes/projects/$projectId/list.tsx`:
  - Similar structure for list view
  - Share data fetching logic with board view
- [ ] Add project-aware API methods:
  - `fetchProjectTasks(projectId: string, ...): Promise<Task[]>`
  - `fetchProjectConfig(projectId: string): Promise<ProjectConfig>`

**Artifacts:**
- `packages/dashboard/app/components/ProjectSwitcher.tsx` (new)
- `packages/dashboard/app/routes/projects/$projectId/board.tsx` (new)
- `packages/dashboard/app/routes/projects/$projectId/list.tsx` (new)

### Step 8: App.tsx Routing Refactor

- [ ] Modify `packages/dashboard/app/App.tsx` to support routing:
  - Import React Router components (BrowserRouter, Routes, Route, Navigate)
  - Add route configuration:
    - `/` → redirects to `/overview` (or first project if only one)
    - `/overview` → Overview page
    - `/projects/:projectId/board` → Project Board
    - `/projects/:projectId/list` → Project List
    - `/projects/:projectId/tasks/:taskId` → Task Detail (within project context)
  - Maintain backward compatibility: single-project mode should still work
  - Add project context provider for sharing selected project across components
- [ ] Update Header component props to include project switcher
- [ ] Ensure all existing modals (Settings, Terminal, etc.) work in both contexts

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 9: First Run Experience

- [ ] Create `packages/dashboard/app/components/FirstRunModal.tsx`:
  - Detects first run via `/api/first-run-status` endpoint
  - If single project detected: show migration prompt ("Add current project to multi-project dashboard?")
  - If no projects: show welcome message + "Set up your first project" CTA
  - Offer to initialize `.fusion/` if missing from selected directory
- [ ] Integrate into App.tsx: show modal on first load if conditions met
- [ ] Write component tests

**Artifacts:**
- `packages/dashboard/app/components/FirstRunModal.tsx` (new)
- `packages/dashboard/app/components/__tests__/FirstRunModal.test.tsx` (new)

### Step 10: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in packages/dashboard
- [ ] Verify all existing tests still pass
- [ ] Ensure new tests have good coverage (>80% for new components)
- [ ] Manual verification checklist:
  - Overview page loads with project cards
  - Clicking project navigates to project board
  - Task operations work within project context
  - Setup wizard can add a new project
  - Activity feed shows events
  - First run modal appears appropriately
  - Single-project backward compatibility maintained
- [ ] Build passes: `pnpm build`

### Step 11: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` with:
  - Multi-project feature overview
  - How to add/remove projects
  - Isolation mode explanation
- [ ] Create changeset for the new feature: `feat(KB-618): add multi-project dashboard UX`
- [ ] Out-of-scope findings:
  - Child process runtime debugging tools → new task
  - Project import/export → new task
  - Cross-project task dependencies → new task

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — add "Multi-Project Management" section

**Check If Affected:**
- `packages/dashboard/CHANGELOG.md` — add entry for this feature
- `AGENTS.md` — document new API endpoints if relevant to agents

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Manual verification of overview page, drill-down, and setup wizard
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-618): complete Step N — description`
- **Bug fixes:** `fix(KB-618): description`
- **Tests:** `test(KB-618): description`

Example commits:
- `feat(KB-618): complete Step 1 — add project API methods`
- `feat(KB-618): complete Step 3 — add ProjectCard component`
- `feat(KB-618): complete Step 8 — implement routing refactor`

## Do NOT

- Modify core engine logic (stay in dashboard package)
- Change the TaskStore API surface (work with what KB-616 provides)
- Implement actual child process spawning (that’s KB-616’s responsibility)
- Skip writing tests for API endpoints or components
- Break existing single-project mode behavior
- Add database migrations (central DB is KB-615’s scope)
- Store project configuration in new files (use CentralCore API)
