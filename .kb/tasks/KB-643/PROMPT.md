# Task: KB-643 - Dashboard Script Runner UI

**Created:** 2026-04-01
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This feature adds new API endpoints and UI components following established patterns in the dashboard. It integrates with existing terminal infrastructure for script execution. Moderate blast radius touching types, API routes, and frontend components.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Add a Scripts UI to the dashboard that allows users to define, manage, and execute quick shell commands (scripts) from project settings. This provides a GUI alternative to the CLI `fn script` and `fn run` commands, enabling users to run common project commands (like `npm build`, `pnpm test`) directly from the dashboard with output streaming to an integrated terminal.

## Dependencies

- **Task:** KB-292 (the scripts feature foundation — adds `scripts` field to ProjectSettings and CLI commands. If KB-292 is not fully implemented, this task must add the `scripts?: Record<string, string>` field to ProjectSettings in types.ts as part of Step 1)

## Context to Read First

- `packages/core/src/types.ts` — Settings type definitions (see `ProjectSettings` interface, `DEFAULT_PROJECT_SETTINGS`, `PROJECT_SETTINGS_KEYS`)
- `packages/dashboard/src/routes.ts` — API route patterns (see workflow steps routes around line 5221 for CRUD patterns, settings routes around line 1084)
- `packages/dashboard/app/api.ts` — Client-side API functions (see `fetchWorkflowSteps`, `createWorkflowStep` patterns)
- `packages/dashboard/app/components/WorkflowStepManager.tsx` — Similar management UI pattern for reference
- `packages/dashboard/app/components/Header.tsx` — Header buttons and overflow menu pattern
- `packages/dashboard/app/components/TerminalModal.tsx` — Terminal integration for script execution
- `packages/dashboard/app/App.tsx` — Modal state management pattern

## File Scope

- `packages/core/src/types.ts` — Add `scripts` field to ProjectSettings (if not present from KB-292)
- `packages/dashboard/src/routes.ts` — Add API endpoints for script CRUD and execution
- `packages/dashboard/app/api.ts` — Add client-side API functions for scripts
- `packages/dashboard/app/components/ScriptsModal.tsx` — New modal component for script management
- `packages/dashboard/app/components/Header.tsx` — Add Scripts button to header
- `packages/dashboard/app/App.tsx` — Add Scripts modal state management

## Steps

### Step 1: Add Scripts Type to ProjectSettings

- [ ] Add `scripts?: Record<string, string>` field to `ProjectSettings` interface in `packages/core/src/types.ts` (if not already present from KB-292)
- [ ] Update `DEFAULT_PROJECT_SETTINGS` to include `scripts: {}` as default
- [ ] Add `"scripts"` to `PROJECT_SETTINGS_KEYS` array for proper scoping
- [ ] Run `pnpm typecheck` to verify type compilation passes

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Create API Endpoints for Scripts

- [ ] Add API routes in `packages/dashboard/src/routes.ts`:
  - `GET /api/scripts` — Returns `Record<string, string>` from project settings
  - `POST /api/scripts` — Add/update a script (body: `{ name: string, command: string }`). Validates name (alphanumeric, hyphens, underscores only, no spaces). Rejects empty names or commands.
  - `DELETE /api/scripts/:name` — Remove a script by name
  - `POST /api/scripts/:name/run` — Execute script with optional `args` array. Streams output via the terminal service or returns execution result. Rejects if script not found.
- [ ] Script execution uses existing `getTerminalService()` or `execSync` with proper working directory set to project root
- [ ] Return appropriate HTTP status codes (400 for validation errors, 404 for missing scripts, 409 for duplicate names on create)
- [ ] Include error messages in JSON responses

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 3: Add Client-Side API Functions

- [ ] Add to `packages/dashboard/app/api.ts`:
  - `fetchScripts(): Promise<Record<string, string>>` — GET /api/scripts
  - `addScript(name: string, command: string): Promise<void>` — POST /api/scripts
  - `removeScript(name: string): Promise<void>` — DELETE /api/scripts/:name
  - `runScript(name: string, args?: string[]): Promise<{ output: string; exitCode: number }>` — POST /api/scripts/:name/run
- [ ] Handle API errors with descriptive messages matching existing patterns
- [ ] Type all function parameters and return values

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 4: Create Scripts Modal Component

- [ ] Create `packages/dashboard/app/components/ScriptsModal.tsx`:
  - Manage scripts UI similar to WorkflowStepManager pattern
  - List all defined scripts with name and command preview (truncated if long)
  - "Add Script" button opening a form with name input and command textarea
  - Edit capability for existing scripts (inline or modal form)
  - Delete confirmation before removing scripts
  - "Run" button next to each script that executes it
  - Script name validation (alphanumeric, hyphens, underscores only)
  - Empty state message when no scripts defined
  - Loading states during API calls
  - Error display for validation or execution failures
- [ ] Use Lucide icons: `Play` for run, `Trash2` for delete, `Plus` for add, `Terminal` for header
- [ ] Follow existing modal styling patterns from WorkflowStepManager
- [ ] Props interface: `{ isOpen: boolean; onClose: () => void; addToast: (message: string, type?: ToastType) => void; onRunScript?: (name: string, command: string) => void }`

**Artifacts:**
- `packages/dashboard/app/components/ScriptsModal.tsx` (new)

### Step 5: Integrate Scripts Modal into Dashboard

- [ ] Update `packages/dashboard/app/App.tsx`:
  - Add `scriptsOpen` state variable
  - Add `setScriptsOpen` handlers
  - Include `<ScriptsModal />` in the modal render section
  - Pass `addToast` and `onRunScript` callback to ScriptsModal
  - `onRunScript` callback should open TerminalModal with the script command pre-filled
- [ ] Update `packages/dashboard/app/components/Header.tsx`:
  - Add `onOpenScripts?: () => void` to HeaderProps
  - Add Scripts button in header with `Terminal` icon (or overflow menu on mobile)
  - Position near other utility buttons (Workflow, Agents, etc.)
  - Use consistent styling with existing header buttons
- [ ] Connect Header to App: pass `onOpenScripts={() => setScriptsOpen(true)}` from App to Header

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Create `packages/dashboard/app/components/__tests__/ScriptsModal.test.tsx` with tests for:
  - Rendering empty state when no scripts exist
  - Adding a new script (form submission, API call)
  - Script name validation (rejects invalid characters)
  - Running a script (triggers onRunScript callback)
  - Deleting a script with confirmation
  - Error handling when API calls fail
- [ ] Mock API calls and toast notifications in tests
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Open dashboard, add a test script (`echo "hello"`), run it and verify output appears in terminal

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ScriptsModal.test.tsx` (new)

### Step 7: Documentation & Delivery

- [ ] Create changeset file for the new feature (minor bump):
  ```bash
  cat > .changeset/add-dashboard-scripts-ui.md << 'EOF'
  ---
  "@gsxdsm/fusion": minor
  ---
  
  Add Scripts UI to dashboard for managing and running quick project commands
  EOF
  ```
- [ ] Verify changeset file is included in the task directory for review

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] `scripts` field present in ProjectSettings type with proper defaults
- [ ] API endpoints for list, add, remove, and run scripts working correctly
- [ ] ScriptsModal UI component functional with add/edit/delete/run capabilities
- [ ] Scripts button visible in dashboard header
- [ ] Running a script from the dashboard opens the terminal with the command
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-643): complete Step N — description`
- **Bug fixes:** `fix(KB-643): description`
- **Tests:** `test(KB-643): description`

## Do NOT

- Modify the CLI package (extension.ts, bin.ts) — this is dashboard-only
- Add global-level scripts (project-only scope is sufficient)
- Support background/async script execution (synchronous terminal only)
- Add script composition (scripts calling other scripts) — keep it simple
- Modify the pi extension
- Skip validation on script names (must be alphanumeric + hyphen/underscore)
- Allow script names that could conflict with system commands or existing features
