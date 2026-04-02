# Task: KB-175 - Files as Top-Level Dashboard Feature with Workspace Selector

**Created:** 2026-03-30
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** This task combines UI restructuring (moving file browser to header), backend API additions for multi-root file browsing, and new UI features (workspace selector, session file tracking on task cards). Changes span dashboard frontend and backend with new visual components.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Transform the file browser from a task-scoped detail view into a top-level dashboard feature accessible from the header. Add the ability to switch between the main project directory and any active task worktree (workspace). On task cards, replace the worktree-based Files indicator with a display of files actually modified during the current execution session.

This makes file browsing a first-class citizen of the dashboard — always available, not tied to specific tasks, and context-aware with workspace selection.

## Dependencies

- **None**
- **Note:** This task supersedes KB-104 which covered the basic "move files to toolbar" concept. KB-104 can be considered a subset of this work.

## Context to Read First

1. `packages/dashboard/app/components/FileBrowserModal.tsx` — Current file browser modal implementation (task-scoped)
2. `packages/dashboard/app/components/FileBrowser.tsx` — File browser UI component
3. `packages/dashboard/app/components/Header.tsx` — Dashboard toolbar where the new button will live
4. `packages/dashboard/app/components/TaskCard.tsx` — Task card component (where session files will be displayed)
5. `packages/dashboard/app/App.tsx` — Main app component that orchestrates modals
6. `packages/dashboard/src/routes.ts` — Backend API routes (see File API Routes)
7. `packages/dashboard/src/file-service.ts` — File service functions
8. `packages/dashboard/app/api.ts` — Frontend API client functions
9. `packages/dashboard/app/hooks/useFileBrowser.ts` — Current file browser hook
10. `packages/dashboard/app/hooks/useFileEditor.ts` — Current file editor hook
11. `packages/core/src/types.ts` — Task type definitions (see `worktree` field)

## File Scope

### Frontend
- `packages/dashboard/app/components/Header.tsx` (modified)
- `packages/dashboard/app/components/FileBrowserModal.tsx` (modified — add workspace selector)
- `packages/dashboard/app/components/FileBrowser.tsx` (modified — show workspace-aware paths)
- `packages/dashboard/app/components/TaskCard.tsx` (modified — add session files indicator)
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified — remove Files tab)
- `packages/dashboard/app/App.tsx` (modified — add file browser state)
- `packages/dashboard/app/api.ts` (modified — add workspace-aware file APIs)
- `packages/dashboard/app/hooks/useWorkspaceFileBrowser.ts` (new — workspace-scoped hook)
- `packages/dashboard/app/hooks/useWorkspaceFileEditor.ts` (new — workspace-scoped hook)

### Backend
- `packages/dashboard/src/routes.ts` (modified — add workspace file routes)
- `packages/dashboard/src/file-service.ts` (modified — add project file functions)
- `packages/dashboard/src/task-store.ts` (may need rootDir access method)

## Steps

### Step 1: Backend API - Add Workspace File Routes

- [ ] Add `listWorkspaceFiles()`, `readWorkspaceFile()`, `writeWorkspaceFile()` functions to `file-service.ts`
  - Accept a `rootPath` parameter instead of `taskId`
  - When `rootPath` is "project", use `store.getRootDir()` 
  - When `rootPath` is a task ID, use that task's worktree path
  - Maintain path traversal protection using existing `validatePath`
  - Skip hidden files (starting with ".") in directory listings
- [ ] Add new API routes in `routes.ts`:
  - `GET /api/files?workspace={project|taskId}&path={subPath}` — List files in workspace directory
  - `GET /api/files/{*filepath}?workspace={project|taskId}` — Read file content
  - `POST /api/files/{*filepath}?workspace={project|taskId}` — Write file content
- [ ] Add `GET /api/workspaces` endpoint to list available workspaces:
  - Returns `{ project: string, tasks: Array<{ id: string, title?: string, worktree: string }> }`
  - Only includes tasks that have a worktree assigned
- [ ] Run backend build to verify no TypeScript errors: `pnpm build`

**Artifacts:**
- `packages/dashboard/src/file-service.ts` (modified)
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Frontend API - Add Workspace File Client Functions

- [ ] Add `fetchWorkspaces()` function to `api.ts` — returns list of available workspaces
- [ ] Add `fetchWorkspaceFileList(workspace: string, path?: string)` function to `api.ts`
- [ ] Add `fetchWorkspaceFileContent(workspace: string, filePath: string)` function to `api.ts`
- [ ] Add `saveWorkspaceFileContent(workspace: string, filePath: string, content: string)` function to `api.ts`
- [ ] Reuse existing `FileNode`, `FileListResponse`, `FileContentResponse`, `SaveFileResponse` types

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 3: Frontend Hooks - Create Workspace File Hooks

- [ ] Create `useWorkspaceFileBrowser.ts` hook modeled after `useFileBrowser.ts`:
  - Takes `workspace: string` parameter ("project" or task ID)
  - Uses new workspace file API functions
  - Returns same interface as `useFileBrowser` for compatibility
- [ ] Create `useWorkspaceFileEditor.ts` hook modeled after `useFileEditor.ts`:
  - Takes `workspace: string` and `filePath: string | null` parameters
  - Uses new workspace file API functions
  - Returns same interface as `useFileEditor` for compatibility
- [ ] Create `useWorkspaces.ts` hook to fetch and cache available workspaces
  - Polls periodically to keep task list fresh
  - Returns `{ projectName: string, workspaces: WorkspaceInfo[] }`

**Artifacts:**
- `packages/dashboard/app/hooks/useWorkspaceFileBrowser.ts` (new)
- `packages/dashboard/app/hooks/useWorkspaceFileEditor.ts` (new)
- `packages/dashboard/app/hooks/useWorkspaces.ts` (new)

### Step 4: Create Workspace Selector Component

- [ ] Create new `WorkspaceSelector.tsx` component:
  - Props: `currentWorkspace: string`, `workspaces: WorkspaceInfo[]`, `onSelect: (workspace: string) => void`
  - Dropdown UI showing "Project Root" at top, then task workspaces grouped
  - Each task shows `id` and truncated `title` if available
  - Current workspace highlighted in dropdown
  - Compact header-style button when closed showing current selection
- [ ] Add styles to `WorkspaceSelector.css` for dropdown appearance matching dashboard theme

**Artifacts:**
- `packages/dashboard/app/components/WorkspaceSelector.tsx` (new)
- `packages/dashboard/app/components/WorkspaceSelector.css` (new)

### Step 5: Update FileBrowserModal for Workspace Mode

- [ ] Modify `FileBrowserModal.tsx` to support workspace mode:
  - Remove `taskId` prop, replace with `initialWorkspace?: string` prop
  - Add `WorkspaceSelector` component to modal header
  - Use `useWorkspaceFileBrowser` and `useWorkspaceFileEditor` hooks
  - Track `currentWorkspace` in local state
  - When workspace changes, reset file selection and path to root
- [ ] Update modal title to show "Files — {workspaceName}" ("Project" for project root, task ID for tasks)
- [ ] Ensure keyboard shortcuts (Escape to close, Cmd+S to save) work in workspace mode
- [ ] Ensure file browser still functions correctly when switching workspaces

**Artifacts:**
- `packages/dashboard/app/components/FileBrowserModal.tsx` (modified)

### Step 6: Add Files Button to Header Toolbar

- [ ] Import `Folder` icon from lucide-react in `Header.tsx`
- [ ] Add `onOpenFiles?: () => void` prop to HeaderProps interface
- [ ] Add Files button to header actions (between Terminal and Pause buttons)
- [ ] Button shows `Folder` icon with title "Browse files"
- [ ] On mobile, include in overflow menu

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 7: Integrate File Browser into App with Workspace State

- [ ] Add state in `AppInner`:
  - `filesOpen: boolean`, `setFilesOpen`
  - `fileBrowserWorkspace: string`, `setFileBrowserWorkspace` (default "project")
- [ ] Add `handleOpenFiles` callback to open file browser
- [ ] Add `handleWorkspaceChange` callback to switch workspace in file browser
- [ ] Pass `onOpenFiles={handleOpenFiles}` to Header component
- [ ] Add `FileBrowserModal` instance:
  ```tsx
  {filesOpen && (
    <FileBrowserModal
      initialWorkspace={fileBrowserWorkspace}
      isOpen={true}
      onClose={() => setFilesOpen(false)}
      onWorkspaceChange={setFileBrowserWorkspace}
    />
  )}
  ```
- [ ] Use `useWorkspaces` hook to provide workspace list to FileBrowserModal

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 8: Remove Files Tab from Task Detail Modal

- [ ] In `TaskDetailModal.tsx`:
  - Remove "files" from `activeTab` state type union
  - Remove the Files tab button from the tab bar (remove the conditional `task.worktree` check)
  - Remove the `activeTab === "files"` render block
  - Remove `FileBrowserModal` import from TaskDetailModal
  - Remove `worktree` from the Tab guard condition (no longer needed for Files tab)

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 9: Add Session Files Indicator to Task Cards

- [ ] Add API endpoint to get files modified in a task session:
  - `GET /api/tasks/:id/session-files` — Returns `string[]` of file paths modified
  - Use git diff against base branch or first commit to find modified files
  - Cache result for performance
- [ ] Add `fetchSessionFiles(taskId: string)` to `api.ts`
- [ ] Create `useSessionFiles.ts` hook:
  - Takes `taskId: string`, `worktree?: string` parameters
  - Only fetches when task is in "in-progress" or "in-review" column
  - Returns `{ files: string[], loading: boolean }`
- [ ] Modify `TaskCard.tsx`:
  - Add `SessionFilesIndicator` component (inline or separate file)
  - Shows only when task has a worktree AND is in "in-progress" or "in-review"
  - Displays count of modified files: "N files changed"
  - Compact UI: small text, muted color, below progress bar
  - On click: opens the file browser directly to that task's workspace
  - Props from parent: `onOpenFilesForTask?: (taskId: string) => void`
- [ ] Pass `onOpenFilesForTask` through from App → Board → TaskCard

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)
- `packages/dashboard/app/hooks/useSessionFiles.ts` (new)
- `packages/dashboard/src/routes.ts` (modified — add session-files route)

### Step 10: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification checklist:
  - Files button appears in header toolbar
  - Clicking Files button opens modal showing project root directory
  - Workspace selector dropdown shows "Project Root" and all tasks with worktrees
  - Can switch between project root and task workspaces
  - File browser updates correctly when switching workspaces
  - Can navigate directories in the file browser
  - Can click files to open in editor
  - Can edit and save files (Cmd+S and Save button)
  - Escape key closes the modal
  - Files tab no longer appears in task detail modal
  - Task detail modal still functions correctly for other tabs
  - Task cards show "N files changed" for in-progress/in-review tasks with worktrees
  - Clicking session files indicator opens file browser to that task's workspace

**Artifacts:**
- All test files passing

### Step 11: Documentation & Delivery

- [ ] Update any inline comments in modified files
- [ ] Update AGENTS.md if needed to document new file browser behavior
- [ ] Create changeset file for the dashboard package:
  ```bash
  cat > .changeset/move-files-to-header-workspaces.md << 'EOF'
  ---
  "@kb/dashboard": minor
  ---

  Move file browser to top-level toolbar with workspace selection

  - File browser now accessible from dashboard header toolbar
  - Can switch between Project Root and any task worktree via workspace selector
  - Task detail modal no longer has Files tab (moved to top-level)
  - Task cards show files modified in current session for in-progress/in-review tasks
  - File browser shows project filesystem or task worktree based on selection
  EOF
  ```
- [ ] Out-of-scope findings: Create new tasks if discovered during implementation

**Artifacts:**
- `.changeset/move-files-to-header-workspaces.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/dashboard/app/components/Header.tsx` — Document new Files button prop
- `packages/dashboard/app/components/FileBrowserModal.tsx` — Document workspace mode

**Check If Affected:**
- `AGENTS.md` — Update dashboard section if file browsing behavior is documented

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] File browser accessible from dashboard header toolbar
- [ ] Workspace selector functional with Project Root + task workspaces
- [ ] Files tab removed from task detail modal
- [ ] Task cards show files modified in session for active tasks
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-175): complete Step N — description`
- **Bug fixes:** `fix(KB-175): description`
- **Tests:** `test(KB-175): description`

Example commits:
```
feat(KB-175): complete Step 1 — add workspace file API routes to backend
feat(KB-175): complete Step 4 — create workspace selector component
feat(KB-175): complete Step 9 — add session files indicator to task cards
```

## Do NOT

- Remove the ability to browse task files (support it via workspace selector)
- Add file creation, deletion, or directory management (out of scope)
- Change the file browser UI design significantly (keep existing look and feel)
- Skip the session files feature (it's a key differentiator from KB-104)
- Modify the file service security/validation logic beyond workspace path handling
- Skip writing tests for new hooks and API functions
- Fix unrelated file editor layout issues in this task (KB-077 covers that)
