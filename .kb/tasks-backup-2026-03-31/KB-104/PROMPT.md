# Task: KB-104 - Move Files from Task Card to Dashboard Toolbar

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** The task involves UI restructuring (moving file browser from task detail to top-level), backend API additions for project-wide file browsing, and component refactoring. Changes are localized to dashboard package but require coordination across frontend and backend.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Move the file browser functionality from the task detail modal's "Files" tab to a top-level dashboard toolbar button. The file browser should now display the main project filesystem (from the repository root) instead of a task-specific worktree. This makes file browsing a first-class dashboard feature accessible at any time, not tied to specific tasks.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/FileBrowserModal.tsx` — Current file browser modal implementation (task-scoped)
2. `packages/dashboard/app/components/FileBrowser.tsx` — File browser UI component
3. `packages/dashboard/app/components/Header.tsx` — Dashboard toolbar where the new button will live
4. `packages/dashboard/app/App.tsx` — Main app component that orchestrates modals
5. `packages/dashboard/src/routes.ts` — Backend API routes (see File API Routes section around line 1767)
6. `packages/dashboard/src/file-service.ts` — File service functions (listFiles, readFile, writeFile)
7. `packages/dashboard/app/api.ts` — Frontend API client functions
8. `packages/dashboard/app/hooks/useFileBrowser.ts` — Current file browser hook (task-scoped)
9. `packages/dashboard/app/hooks/useFileEditor.ts` — Current file editor hook (task-scoped)
10. `packages/dashboard/app/components/TaskDetailModal.tsx` — Current location of Files tab (to be removed)

## File Scope

- `packages/dashboard/app/components/Header.tsx` (modified)
- `packages/dashboard/app/components/FileBrowserModal.tsx` (modified — add project-files mode)
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified — remove Files tab)
- `packages/dashboard/app/App.tsx` (modified — add project file browser state)
- `packages/dashboard/app/api.ts` (modified — add project file API functions)
- `packages/dashboard/app/hooks/useProjectFileBrowser.ts` (new — project-scoped file browser hook)
- `packages/dashboard/app/hooks/useProjectFileEditor.ts` (new — project-scoped file editor hook)
- `packages/dashboard/src/routes.ts` (modified — add project file API routes)
- `packages/dashboard/src/file-service.ts` (modified — add project file functions)

## Steps

### Step 1: Backend API - Add Project File Routes

- [ ] Add `listProjectFiles()`, `readProjectFile()`, `writeProjectFile()` functions to `file-service.ts` that operate on project root (via `store.getRootDir()`) instead of task worktree
- [ ] Add new API routes in `routes.ts`:
  - `GET /api/files` — List files in project directory
  - `GET /api/files/{*filepath}` — Read file content
  - `POST /api/files/{*filepath}` — Write file content
- [ ] Ensure path traversal protection is maintained (reuse `validatePath` from file-service.ts)
- [ ] Skip hidden files (starting with ".") in directory listings
- [ ] Run backend build to verify no TypeScript errors: `pnpm build`

**Artifacts:**
- `packages/dashboard/src/file-service.ts` (modified)
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Frontend API - Add Project File Client Functions

- [ ] Add `fetchProjectFileList()`, `fetchProjectFileContent()`, `saveProjectFileContent()` functions to `api.ts`
- [ ] Mirror the existing task-based functions but call `/api/files` endpoints instead of `/api/tasks/:id/files`
- [ ] Reuse existing `FileNode`, `FileListResponse`, `FileContentResponse`, `SaveFileResponse` types

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 3: Frontend Hooks - Create Project File Hooks

- [ ] Create `useProjectFileBrowser.ts` hook modeled after `useFileBrowser.ts` but without taskId parameter, using new project file API
- [ ] Create `useProjectFileEditor.ts` hook modeled after `useFileEditor.ts` but without taskId parameter, using new project file API
- [ ] Both hooks should take `rootPath: string` parameter (from config/store)

**Artifacts:**
- `packages/dashboard/app/hooks/useProjectFileBrowser.ts` (new)
- `packages/dashboard/app/hooks/useProjectFileEditor.ts` (new)

### Step 4: Update FileBrowserModal for Dual Mode

- [ ] Modify `FileBrowserModal.tsx` to support two modes via props:
  - Task mode (existing): `taskId` prop provided, browses task worktree
  - Project mode (new): `projectRoot` prop provided, browses project root
- [ ] Use conditional logic to select appropriate hooks:
  - If `taskId` provided: use existing `useFileBrowser` and `useFileEditor`
  - If `projectRoot` provided: use new `useProjectFileBrowser` and `useProjectFileEditor`
- [ ] Update modal title: "Files — {taskId}" for task mode, "Files — Project" for project mode
- [ ] Ensure keyboard shortcuts (Escape to close, Cmd+S to save) work in both modes

**Artifacts:**
- `packages/dashboard/app/components/FileBrowserModal.tsx` (modified)

### Step 5: Add Files Button to Header Toolbar

- [ ] Import `Folder` icon from lucide-react in `Header.tsx`
- [ ] Add `onToggleFiles?: () => void` prop to HeaderProps interface
- [ ] Add Files button to header actions (between Terminal and Pause buttons)
- [ ] Button should show active state when files modal is open (if state is managed externally)

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 6: Integrate Project File Browser into App

- [ ] Add state in `AppInner`: `filesOpen`, `setFilesOpen`
- [ ] Add `handleToggleFiles` callback to toggle file browser modal
- [ ] Pass `onToggleFiles={handleToggleFiles}` to Header component
- [ ] Add `FileBrowserModal` instance in project mode:
  ```tsx
  {filesOpen && (
    <FileBrowserModal
      projectRoot={rootDir}
      isOpen={true}
      onClose={() => setFilesOpen(false)}
    />
  )}
  ```
- [ ] Get rootDir from store config (already fetched via `fetchConfig`)

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 7: Remove Files Tab from Task Detail Modal

- [ ] In `TaskDetailModal.tsx`, remove the "files" option from `activeTab` state type
- [ ] Remove the Files tab button from the tab bar (remove the conditional that checks `task.worktree`)
- [ ] Remove the `activeTab === "files"` render block that renders `FileBrowserModal` inline
- [ ] Remove `FileBrowserModal` import from TaskDetailModal (it's no longer used there)
- [ ] Note: Task detail modal should still show attachments, dependencies, etc. — only remove the Files browser tab

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 8: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification checklist:
  - Files button appears in header toolbar
  - Clicking Files button opens modal showing project root directory
  - Can navigate directories in the file browser
  - Can click files to open in editor
  - Can edit and save files (Cmd+S and Save button)
  - Escape key closes the modal
  - Files tab no longer appears in task detail modal
  - Task detail modal still functions correctly for other tabs

**Artifacts:**
- All test files passing

### Step 9: Documentation & Delivery

- [ ] Update any inline comments in modified files
- [ ] Create changeset file for the dashboard package:
  ```bash
  cat > .changeset/move-files-to-toolbar.md << 'EOF'
  ---
  "@kb/dashboard": minor
  ---
  
  Move file browser from task detail to top-level toolbar
  
  - Files can now be browsed and edited from the main dashboard toolbar
  - File browser shows the project root filesystem instead of task worktrees
  - Removes Files tab from task detail modal (no longer needed)
  EOF
  ```
- [ ] Out-of-scope findings: If you notice the file editor styling issues mentioned in KB-077, note them but do not fix in this task

**Artifacts:**
- `.changeset/move-files-to-toolbar.md` (new)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] File browser accessible from dashboard header toolbar
- [ ] File browser shows project root (not task worktree)
- [ ] Files tab removed from task detail modal
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-104): complete Step N — description`
- **Bug fixes:** `fix(KB-104): description`
- **Tests:** `test(KB-104): description`

Example commits:
```
feat(KB-104): complete Step 1 — add project file API routes to backend
feat(KB-104): complete Step 5 — add Files button to dashboard header
```

## Do NOT

- Expand task scope to fix unrelated file editor layout issues (that's KB-077)
- Add new features like file creation, deletion, or directory management (out of scope)
- Change the file browser UI design significantly (keep existing look and feel)
- Remove the ability to browse task files entirely (the modal should still support task mode for any future use)
- Modify the file service security/validation logic beyond what's needed for project root access
- Skip writing tests for new hooks and API functions
