# Task: KB-502 - Dashboard Multi-Project UX: Overview page, drill-down, and setup wizard

**Created:** 2026-03-31
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** This is a substantial UI/UX task that builds on the multi-project infrastructure from KB-500/KB-501. It creates new dashboard surfaces for multi-project management. Moderate blast radius on the dashboard frontend. Security implications around project isolation in the UI. Pattern novelty in the navigation and context switching model.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 2, Security: 1, Reversibility: 1

## Mission

Build the dashboard user experience for kb's multi-project support. Create three interconnected UI surfaces:

1. **Project Overview Page** — A new dashboard view showing all registered projects with health status, task counts, and quick actions. This is the "home" view when multiple projects exist.

2. **Project Drill-Down** — Navigation from overview into a specific project's task board/list. Contextual UI showing which project is active, with the ability to switch between projects.

3. **Setup Wizard** — A first-run experience that guides users through registering their first project(s), with auto-detection of existing kb projects on the filesystem.

This work builds on KB-501 (Per-Project Runtime) which provides the `HybridExecutor` and project runtime management. The dashboard needs to integrate with `CentralCore` from KB-500 for project registry operations.

## Dependencies

- **Task:** KB-501 (Per-Project Runtime Abstraction and Hybrid Executor Lifecycle)
  - Must provide: `HybridExecutor`, `ProjectRuntime` interface, project lifecycle management
  - Must expose: APIs for project health, runtime status, per-project task stores

- **Task:** KB-500 (Core Infrastructure)
  - Must provide: `CentralCore`, `ProjectRegistry`, `RegisteredProject` type, `GlobalActivityLogEntry` type with project attribution
  - Must expose: project CRUD APIs, global activity feed with `projectId` and `projectName` fields

## Context to Read First

- `packages/dashboard/app/App.tsx` — Current single-project dashboard structure
- `packages/dashboard/app/api.ts` — API client patterns (lines 1-100 for structure)
- `packages/dashboard/app/components/Header.tsx` — Navigation header patterns
- `packages/dashboard/app/components/Board.tsx` and `ListView.tsx` — Current task views
- `packages/dashboard/app/hooks/useTasks.ts` — Task data fetching patterns
- `packages/dashboard/src/server.ts` and `routes.ts` — Server-side route patterns
- `packages/core/src/types.ts` — Type definitions (KB-500 will add `RegisteredProject`, `ProjectStatus`, `IsolationMode`, `GlobalActivityLogEntry`)
- KB-500's `packages/core/src/central-core.ts` — CentralCore API for project registry (when complete)

## File Scope

### New Files
- `packages/dashboard/app/components/ProjectOverview.tsx` — Multi-project grid view
- `packages/dashboard/app/components/ProjectCard.tsx` — Individual project status card
- `packages/dashboard/app/components/ProjectSelector.tsx` — Project switcher dropdown
- `packages/dashboard/app/components/SetupWizard.tsx` — First-run setup flow
- `packages/dashboard/app/components/SetupProjectForm.tsx` — Project registration form
- `packages/dashboard/app/components/ProjectHealthBadge.tsx` — Health status indicator
- `packages/dashboard/app/components/ProjectGridSkeleton.tsx` — Loading skeleton for project grid
- `packages/dashboard/app/components/SetupWizardModal.tsx` — Modal wrapper for wizard
- `packages/dashboard/app/components/ProjectDetectionResults.tsx` — Auto-detect results UI
- `packages/dashboard/app/hooks/useProjects.ts` — Project data fetching hook
- `packages/dashboard/app/hooks/useProjects.test.ts` — Tests for useProjects hook
- `packages/dashboard/app/hooks/useCurrentProject.ts` — Active project context hook
- `packages/dashboard/app/hooks/useCurrentProject.test.ts` — Tests for useCurrentProject hook
- `packages/dashboard/app/hooks/useProjectHealth.ts` — Project health polling hook
- `packages/dashboard/app/hooks/useActivityLog.ts` — Activity log hook (extracted from modal)
- `packages/dashboard/app/hooks/useActivityLog.test.ts` — Tests for useActivityLog hook
- `packages/dashboard/app/utils/projectDetection.ts` — Auto-detect kb projects in filesystem
- `packages/dashboard/src/__tests__/project-routes.test.ts` — API route tests
- `packages/dashboard/app/components/ProjectOverview.test.tsx` — Component tests
- `packages/dashboard/app/components/ProjectCard.test.tsx` — Component tests
- `packages/dashboard/app/components/ProjectSelector.test.tsx` — Component tests
- `packages/dashboard/app/components/SetupWizard.test.tsx` — Wizard flow tests

### Modified Files
- `packages/dashboard/app/App.tsx` — Add multi-project routing and project context
- `packages/dashboard/app/api.ts` — Add project API functions (list, register, update, etc.)
- `packages/dashboard/app/components/Header.tsx` — Add project selector, switcher UI
- `packages/dashboard/app/components/Board.tsx` — Accept projectId prop, filter tasks
- `packages/dashboard/app/components/ListView.tsx` — Accept projectId prop, filter tasks
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Show project context
- `packages/dashboard/app/components/ActivityLogModal.tsx` — Use useActivityLog hook, show project attribution
- `packages/dashboard/app/hooks/useTasks.ts` — Support per-project task fetching
- `packages/dashboard/src/routes.ts` — Add project management API endpoints
- `packages/dashboard/src/server.ts` — Integrate CentralCore for project operations

## Steps

### Step 0: Testing Infrastructure Setup

- [ ] Verify vitest configuration in `packages/dashboard/vitest.config.ts` exists and is functional
- [ ] Add `@testing-library/react` and `@testing-library/user-event` to devDependencies if not present
- [ ] Create test setup file `packages/dashboard/app/test/setup.ts` with common mocks
- [ ] Add test script to `packages/dashboard/package.json`: `"test": "vitest run"`
- [ ] Create first smoke test to verify test infrastructure works
- [ ] Run `pnpm test` in dashboard package to confirm infrastructure functional

**Artifacts:**
- `packages/dashboard/app/test/setup.ts` (new)
- `packages/dashboard/vitest.config.ts` (verify/modify)
- `packages/dashboard/package.json` (modify — test script)

### Step 1: Project API Routes and Backend Integration

- [ ] Add project management API functions to `packages/dashboard/app/api.ts`:
  - `fetchProjects(): Promise<RegisteredProject[]>` — List all registered projects
  - `fetchProject(id: string): Promise<RegisteredProject>` — Get single project details
  - `registerProject(input: ProjectRegisterInput): Promise<RegisteredProject>` — Create new project
  - `updateProject(id: string, updates: Partial<RegisteredProject>): Promise<RegisteredProject>` — Update project
  - `unregisterProject(id: string): Promise<void>` — Remove project from registry
  - `detectProjects(basePath?: string): Promise<DetectedProject[]>` — Auto-detect kb projects
  - `fetchProjectHealth(id: string): Promise<ProjectHealth>` — Get project health metrics
- [ ] Add corresponding API routes in `packages/dashboard/src/routes.ts`:
  - `GET /api/projects` — List projects (returns empty array if CentralCore not available yet)
  - `GET /api/projects/:id` — Get project details
  - `POST /api/projects` — Register new project
  - `PATCH /api/projects/:id` — Update project
  - `DELETE /api/projects/:id` — Unregister project
  - `POST /api/projects/detect` — Auto-detect projects in path
  - `GET /api/projects/:id/health` — Get project health
- [ ] Integrate `CentralCore` from `@fusion/core` in server routes:
  - Import `createCentralCore` from `@fusion/core`
  - Use `ProjectRegistry` for CRUD operations
  - Handle validation errors (duplicate names, invalid paths, etc.)
  - Graceful fallback if CentralCore/database not initialized yet
- [ ] Write API tests in `packages/dashboard/src/__tests__/project-routes.test.ts`:
  - Test GET /api/projects returns array
  - Test POST /api/projects with valid input
  - Test validation (duplicate names, invalid paths) returns 400
  - Test auto-detection endpoint returns detected projects
- [ ] Run targeted tests: `pnpm test packages/dashboard/src/__tests__/project-routes.test.ts`

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified — new functions)
- `packages/dashboard/src/routes.ts` (modified — new routes)
- `packages/dashboard/src/__tests__/project-routes.test.ts` (new)

### Step 2: Project Data Hooks

- [ ] Create `packages/dashboard/app/hooks/useProjects.ts`:
  - `useProjects()` hook returning `{ projects, loading, error, refresh, register, update, unregister }`
  - Polling refresh every 5 seconds for health updates
  - Optimistic updates for UI responsiveness
  - Handle empty projects list gracefully
- [ ] Create `packages/dashboard/app/hooks/useProjects.test.ts`:
  - Test hook renders without crashing
  - Test loading state
  - Test data fetching (mock api.fetchProjects)
  - Test refresh function
  - Test register/update/unregister functions
- [ ] Create `packages/dashboard/app/hooks/useCurrentProject.ts`:
  - `useCurrentProject()` hook returning `{ currentProject, setCurrentProject, clearCurrentProject }`
  - Persist selected project in `localStorage`
  - Default to first active project if none selected
  - Validate project still exists on load (clear if unregistered)
- [ ] Create `packages/dashboard/app/hooks/useCurrentProject.test.ts`:
  - Test hook renders without crashing
  - Test localStorage persistence
  - Test project validation (clears invalid)
- [ ] Create `packages/dashboard/app/hooks/useProjectHealth.ts`:
  - `useProjectHealth(projectId)` hook for polling health metrics
  - Returns `{ health, status, activeTasks, lastActivityAt, loading }`
  - Poll every 10 seconds when project is active
  - Stop polling when component unmounts
- [ ] Run targeted tests: `pnpm test packages/dashboard/app/hooks/useProjects.test.ts`

**Artifacts:**
- `packages/dashboard/app/hooks/useProjects.ts` (new)
- `packages/dashboard/app/hooks/useProjects.test.ts` (new)
- `packages/dashboard/app/hooks/useCurrentProject.ts` (new)
- `packages/dashboard/app/hooks/useCurrentProject.test.ts` (new)
- `packages/dashboard/app/hooks/useProjectHealth.ts` (new)

### Step 3: useActivityLog Hook Creation

- [ ] Extract activity log logic from `ActivityLogModal.tsx` into new hook:
  - Create `packages/dashboard/app/hooks/useActivityLog.ts`
  - Move `fetchActivityLog` call and state management from modal
  - Add polling mechanism (every 5 seconds)
  - Add `projectId` filter parameter (for future use)
  - Return `{ entries, loading, error, refresh, clear }`
- [ ] Create `packages/dashboard/app/hooks/useActivityLog.test.ts`:
  - Test hook renders without crashing
  - Test loading state
  - Test data fetching
  - Test refresh functionality
- [ ] Update `packages/dashboard/app/components/ActivityLogModal.tsx`:
  - Replace direct API calls with `useActivityLog()` hook
  - Ensure no regression in existing functionality
- [ ] Run targeted tests: `pnpm test packages/dashboard/app/hooks/useActivityLog.test.ts`

**Artifacts:**
- `packages/dashboard/app/hooks/useActivityLog.ts` (new)
- `packages/dashboard/app/hooks/useActivityLog.test.ts` (new)
- `packages/dashboard/app/components/ActivityLogModal.tsx` (modified)

### Step 4: Project Overview Page UI

- [ ] Create `packages/dashboard/app/components/ProjectCard.tsx`:
  - Props: `project: RegisteredProject`, `health?: ProjectHealth`, `onSelect`, `onEdit`, `onPause`, `onRemove`
  - Show project name, path (truncated), status badge
  - Show task counts: total, active, done (use health data)
  - Show isolation mode indicator (in-process vs child-process)
  - Show last activity timestamp
  - Actions: Open, Edit, Pause/Resume, Remove
  - Use existing card styling patterns from TaskCard
- [ ] Create `packages/dashboard/app/components/ProjectCard.test.tsx`:
  - Test renders without crashing
  - Test displays project name
  - Test action buttons trigger callbacks
- [ ] Create `packages/dashboard/app/components/ProjectHealthBadge.tsx`:
  - Props: `status: ProjectStatus`, `health?: ProjectHealth`
  - Color-coded badges: green (active/healthy), yellow (paused), red (errored)
  - Show tooltip with detailed health metrics on hover (if health provided)
- [ ] Create `packages/dashboard/app/components/ProjectOverview.tsx`:
  - Grid layout of ProjectCards (responsive: 1 col mobile, 2 col tablet, 3 col desktop)
  - "Add Project" button opening registration modal
  - Empty state when no projects registered (prompt to run setup wizard)
  - Sort options: name, last activity, status (if multi-project)
  - Filter by status: all, active, paused, errored
  - Quick stats header: total projects, total active tasks, total tasks across all projects
- [ ] Create `packages/dashboard/app/components/ProjectOverview.test.tsx`:
  - Test renders without crashing
  - Test displays project cards when projects provided
  - Test shows empty state when no projects
  - Test "Add Project" button exists
- [ ] Create `packages/dashboard/app/components/ProjectGridSkeleton.tsx`:
  - Loading skeleton for project cards (3-6 skeleton cards)
  - Use existing skeleton patterns from styles.css
- [ ] Run targeted tests: `pnpm test packages/dashboard/app/components/ProjectOverview.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/ProjectCard.tsx` (new)
- `packages/dashboard/app/components/ProjectCard.test.tsx` (new)
- `packages/dashboard/app/components/ProjectHealthBadge.tsx` (new)
- `packages/dashboard/app/components/ProjectOverview.tsx` (new)
- `packages/dashboard/app/components/ProjectOverview.test.tsx` (new)
- `packages/dashboard/app/components/ProjectGridSkeleton.tsx` (new)

### Step 5: Project Selector and Header Integration

- [ ] Update `packages/dashboard/app/components/Header.tsx`:
  - Import `useProjects` and `useCurrentProject` hooks
  - Add `ProjectSelector` component in header when 2+ projects exist
  - Show current project name with dropdown to switch
  - Show "All Projects" option to return to overview
  - Hide selector when only one project registered (single-project mode)
  - Add project name to page title when viewing specific project
- [ ] Create `packages/dashboard/app/components/ProjectSelector.tsx`:
  - Dropdown with search/filter for projects (if 5+ projects)
  - Show project status indicators in dropdown items
  - Keyboard navigation (arrow keys, enter, escape)
  - Recent projects at top of list
  - "Manage Projects" link at bottom
- [ ] Create `packages/dashboard/app/components/ProjectSelector.test.tsx`:
  - Test renders without crashing
  - Test dropdown opens on click
  - Test project switching triggers callback
- [ ] Add project indicator to existing views:
  - Update `Board.tsx` to show current project name in header area (when projectId provided)
  - Update `ListView.tsx` to show current project name (when projectId provided)
- [ ] Run targeted tests: `pnpm test packages/dashboard/app/components/ProjectSelector.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)
- `packages/dashboard/app/components/ProjectSelector.tsx` (new)
- `packages/dashboard/app/components/ProjectSelector.test.tsx` (new)
- `packages/dashboard/app/components/Board.tsx` (modified)
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 6: Project Drill-Down and Task Views

- [ ] Update `packages/dashboard/app/hooks/useTasks.ts`:
  - Add optional `projectId` parameter to hook options
  - When `projectId` provided, include in API calls (routes will handle)
  - Maintain backward compatibility (no projectId = current behavior)
- [ ] Update `packages/dashboard/app/components/Board.tsx`:
  - Add `projectId?: string` prop
  - When `projectId` provided, pass to useTasks and show only that project's tasks
  - Show project context in column headers (project name badge)
- [ ] Update `packages/dashboard/app/components/ListView.tsx`:
  - Add `projectId?: string` prop
  - Pass to useTasks hook for filtering
  - Show project name in list header when provided
- [ ] Update `packages/dashboard/app/App.tsx`:
  - Add view state for "overview" vs "project" mode
  - Use `useCurrentProject` to determine active view
  - When `currentProject` set, render Board/ListView with projectId
  - When `currentProject` null, render ProjectOverview
  - Add "Back to All Projects" button in header when viewing specific project
  - URL hash routing optional (can use state for first iteration)
- [ ] Update `packages/dashboard/app/components/TaskDetailModal.tsx`:
  - Show project name/breadcrumb in modal header (if task has project context)
- [ ] Run targeted tests: `pnpm test packages/dashboard/app/hooks/useTasks.test.ts` (if exists) or add basic test

**Artifacts:**
- `packages/dashboard/app/hooks/useTasks.ts` (modified)
- `packages/dashboard/app/components/Board.tsx` (modified)
- `packages/dashboard/app/components/ListView.tsx` (modified)
- `packages/dashboard/app/App.tsx` (modified)
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 7: Setup Wizard

- [ ] Create `packages/dashboard/app/utils/projectDetection.ts`:
  - `scanForProjects(basePath: string): Promise<DetectedProject[]>`
  - Recursively scan for `.fusion/fusion.db` files (limit depth to avoid perf issues)
  - Validate found projects (check not already registered)
  - Suggest project names from directory names
  - Return array of `{ path, suggestedName, existing: boolean }`
- [ ] Create `packages/dashboard/app/components/SetupProjectForm.tsx`:
  - Form for manual project registration
  - Path input with text entry (directory picker optional enhancement)
  - Name input with validation (alphanumeric, hyphens, underscores)
  - Isolation mode selector (in-process vs child-process)
  - Path validation: check exists, check contains `.fusion/fusion.db`
  - Real-time name availability check (debounced)
- [ ] Create `packages/dashboard/app/components/ProjectDetectionResults.tsx`:
  - Show detected projects from auto-scan
  - Checkboxes to select which to register
  - Edit name before registering
  - Show warnings for invalid projects (no .fusion/fusion.db)
- [ ] Create `packages/dashboard/app/components/SetupWizard.tsx`:
  - Step-based wizard UI with progress indicator
  - Step 1: Welcome / intro to multi-project mode
  - Step 2: Auto-detect existing projects (runs scan)
  - Step 3: Review and confirm detected projects
  - Step 4: Manual project registration (if needed, optional)
  - Step 5: Complete / get started
  - Cancel/resume capability (save step to localStorage)
- [ ] Create `packages/dashboard/app/components/SetupWizardModal.tsx`:
  - Modal wrapper for wizard
  - Open automatically when no projects registered (on first load)
  - Can be reopened from settings or "Add Project" button
- [ ] Create `packages/dashboard/app/components/SetupWizard.test.tsx`:
  - Test wizard renders without crashing
  - Test step navigation (next/previous)
  - Test completion handler
- [ ] Run targeted tests: `pnpm test packages/dashboard/app/components/SetupWizard.test.tsx`

**Artifacts:**
- `packages/dashboard/app/utils/projectDetection.ts` (new)
- `packages/dashboard/app/components/SetupProjectForm.tsx` (new)
- `packages/dashboard/app/components/ProjectDetectionResults.tsx` (new)
- `packages/dashboard/app/components/SetupWizard.tsx` (new)
- `packages/dashboard/app/components/SetupWizard.test.tsx` (new)
- `packages/dashboard/app/components/SetupWizardModal.tsx` (new)

### Step 8: Global Activity Feed Integration

- [ ] Update `packages/dashboard/app/hooks/useActivityLog.ts`:
  - Add `projectId` filter parameter (already added in Step 3)
  - Support fetching global activity (all projects) or per-project
  - Use `GlobalActivityLogEntry` type from KB-500 (with projectId, projectName)
- [ ] Update `packages/dashboard/app/components/ActivityLogModal.tsx`:
  - Show project name for each activity entry (using projectName from entry)
  - Add filter dropdown by project (list of registered projects)
  - "All Projects" option for global view
  - Group activities by date (existing) then optionally by project
- [ ] Add API function in `packages/dashboard/app/api.ts`:
  - `fetchGlobalActivity(options?: { projectId?: string; limit?: number }): Promise<GlobalActivityLogEntry[]>`
  - Uses existing `fetchActivityLog` endpoint (KB-500 should add global endpoint)
- [ ] Write tests for global activity:
  - Test ActivityLogModal renders entries with project names
  - Test project filter dropdown
- [ ] Run targeted tests: `pnpm test packages/dashboard/app/hooks/useActivityLog.test.ts`

**Artifacts:**
- `packages/dashboard/app/hooks/useActivityLog.ts` (modified)
- `packages/dashboard/app/components/ActivityLogModal.tsx` (modified)
- `packages/dashboard/app/api.ts` (modified)

### Step 9: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full dashboard test suite: `pnpm test packages/dashboard`
- [ ] Verify no TypeScript errors: `pnpm build` in packages/dashboard
- [ ] Verify no lint errors: `pnpm lint` (if configured)
- [ ] Manual integration test:
  1. Start dashboard with fresh central database
  2. Verify setup wizard appears (or shows empty state with "Add Project")
  3. Register 2-3 test projects manually (since auto-detect needs existing projects)
  4. Verify project overview shows all projects
  5. Click into a project, verify task view opens
  6. Use project selector to switch between projects
  7. Click "Back to All Projects" to return to overview
  8. Verify activity log shows entries (once KB-500 provides global feed)
- [ ] Test single-project backward compatibility:
  1. With only 1 project registered, verify selector is hidden
  2. Verify dashboard behaves like current single-project mode

### Step 10: Documentation & Delivery

- [ ] Add JSDoc comments to all new components and hooks
- [ ] Update `AGENTS.md` — Document the multi-project dashboard:
  - Project Overview page and navigation
  - How to switch between projects
  - Setup wizard first-run experience
  - Project health indicators
- [ ] Create changeset for the feature:
    ```bash
    cat > .changeset/dashboard-multi-project-ux.md << 'EOF'
    ---
    "@fusion/dashboard": minor
    ---
    
    Add multi-project UX with overview page, drill-down, and setup wizard
    
    - New Project Overview page showing all registered projects
    - Project selector in header for switching contexts
    - Project drill-down into per-project task views
    - Setup wizard for first-run project registration
    - Global activity feed with project attribution
    EOF
    ```
- [ ] Include changeset in commit
- [ ] Out-of-scope findings created as new tasks via `task_create` tool:
  - If CLI multi-project commands needed (belongs in KB-503)
  - If migration tooling improvements needed (belongs in KB-504)

## Documentation Requirements

**Must Update:**
- `packages/dashboard/app/api.ts` — Document new project API functions
- `AGENTS.md` — Add section on "Multi-Project Dashboard" describing:
  - How to navigate between overview and project views
  - Project health indicators and what they mean
  - Setup wizard for new users
  - Project context switching behavior

**Check If Affected:**
- `packages/dashboard/README.md` — Update with multi-project features
- `packages/dashboard/package.json` — Test script added

## Completion Criteria

- [ ] Testing infrastructure set up and functional
- [ ] All project API routes working (list, register, update, unregister, detect, health)
- [ ] `useProjects`, `useCurrentProject`, `useProjectHealth` hooks with tests
- [ ] `useActivityLog` hook extracted and enhanced
- [ ] Project Overview page showing grid of project cards
- [ ] Project Selector in header allowing quick context switching
- [ ] Project drill-down working: clicking project opens its task view
- [ ] Task views (Board/List) accept projectId and filter accordingly
- [ ] Setup wizard with auto-detection and manual registration flows
- [ ] Global activity feed showing project attribution
- [ ] All new components have smoke tests (renders without crashing)
- [ ] All tests passing
- [ ] Build passes with no TypeScript errors
- [ ] Manual integration test passes
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-502): complete Step N — description`
  - Example: `feat(KB-502): complete Step 1 — Project API routes and backend integration`
- **Bug fixes:** `fix(KB-502): description`
- **Tests:** `test(KB-502): description`
- **Docs:** `docs(KB-502): description`

## Do NOT

- Break existing single-project dashboard behavior
- Skip project path validation (security-critical)
- Allow UI to show sensitive absolute paths (use relative/project names)
- Skip tests for project context switching (state management critical)
- Implement CLI project commands (belongs in KB-503)
- Implement automatic migration (belongs in KB-504)
- Skip mobile/responsive design for project overview
- Allow project selector to disappear without "back" navigation

## Security Considerations

- Validate all project paths server-side (path traversal prevention)
- Don't expose absolute filesystem paths in UI (use relative/project names)
- Sanitize project names (alphanumeric, hyphens, underscores only)
- Reject attempts to register projects outside allowed base paths
- Validate project registration permissions (if multi-user in future)
- Clear project context on logout (if auth implemented)

## UX Guidelines

- Always show current project context clearly
- Provide obvious "escape hatch" back to overview from project view
- Preserve view preference (board vs list) per project in localStorage
- Show loading states during project switching (avoid jarring transitions)
- Auto-refresh project health every 10 seconds when visible
- Empty states should guide users to next action (add project, run wizard)
- Keyboard shortcuts: `Cmd/Ctrl+Shift+P` for project selector (optional)

## Testing Guidelines

- Smoke tests: Each component must have a test that verifies it renders without crashing
- Hook tests: Each hook must have tests for loading states and basic functionality
- Integration tests: Critical user flows (wizard → register → view) should be tested
- Mock external APIs: Use vitest mocks for `fetch`, `localStorage`, and API calls
- Coverage: Aim for meaningful test coverage, not arbitrary percentages
