# Task: KB-029 - Add File Browser and Editor on Dashboard using CodeMirror

**Created:** 2026-03-30
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This task involves significant new UI components (file browser, editor modal), server-side API routes for file system operations, CodeMirror integration, and security considerations for file access. Full review required due to file system access patterns and potential security implications.

**Score:** 7/8 — Blast radius: 2 (touches multiple packages, server API, new dependencies), Pattern novelty: 2 (new CodeMirror integration, file browser UI patterns), Security: 2 (file system read/write operations), Reversibility: 1 (new dependencies can be removed, code deletions are straightforward)

## Mission

Add a file browser and code editor to the kb dashboard using CodeMirror 6. This feature allows users to browse the task's worktree files directly from the task detail modal, view file contents with syntax highlighting, and make edits that are saved back to the filesystem. The editor integrates as a new tab in the existing TaskDetailModal component, providing seamless access to the task's code without leaving the dashboard.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/src/routes.ts` — Understand existing API route patterns, error handling, and TaskStore integration
2. `packages/dashboard/app/api.ts` — Client-side API function patterns and fetch wrappers
3. `packages/dashboard/app/components/TaskDetailModal.tsx` — Modal structure, tab system, and how new tabs are added
4. `packages/dashboard/app/components/SpecEditor.tsx` — Editor component patterns (toolbar, view/edit modes, save/cancel)
5. `packages/dashboard/app/hooks/useAgentLogs.ts` — Hook patterns for data fetching
6. `packages/dashboard/app/styles.css` — CSS class naming conventions, modal styles, color variables
7. `packages/core/src/store.ts` — TaskStore class, task directory structure, file operations

## File Scope

### New Files
- `packages/dashboard/src/file-service.ts` — Server-side file operations (list, read, write)
- `packages/dashboard/app/components/FileBrowser.tsx` — File tree browser component
- `packages/dashboard/app/components/FileEditor.tsx` — CodeMirror 6 editor wrapper
- `packages/dashboard/app/components/FileBrowserModal.tsx` — Combined modal with browser + editor
- `packages/dashboard/app/hooks/useFileBrowser.ts` — Hook for file tree fetching and state
- `packages/dashboard/app/hooks/useFileEditor.ts` — Hook for file content operations

### Modified Files
- `packages/dashboard/package.json` — Add `@codemirror/*` dependencies
- `packages/dashboard/src/routes.ts` — Add file API routes (GET/POST for file operations)
- `packages/dashboard/src/server.ts` — Wire up file service to routes if needed
- `packages/dashboard/app/api.ts` — Add client-side file API functions
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Add "Files" tab integration
- `packages/dashboard/app/styles.css` — Add file browser and editor styles
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` — Update tests for new tab

## Steps

### Step 1: Add CodeMirror Dependencies

- [ ] Install CodeMirror 6 core packages:
  - `@codemirror/state`, `@codemirror/view`, `@codemirror/basic-setup`
  - `@codemirror/lang-javascript`, `@codemirror/lang-typescript`, `@codemirror/lang-json`
  - `@codemirror/lang-markdown`, `@codemirror/lang-css`, `@codemirror/theme-one-dark`
- [ ] Add `pnpm install` command for new packages
- [ ] Run `pnpm build` to verify no type conflicts
- [ ] Run `pnpm test` to ensure existing tests still pass

**Artifacts:**
- `packages/dashboard/package.json` (modified)
- `pnpm-lock.yaml` (modified via pnpm install)

### Step 2: Create Server-Side File Service

- [ ] Create `packages/dashboard/src/file-service.ts` with:
  - `listFiles(taskId: string, basePath?: string): Promise<FileNode[]>` — Recursive directory listing
  - `readFile(taskId: string, filePath: string): Promise<string>` — Read file contents
  - `writeFile(taskId: string, filePath: string, content: string): Promise<void>` — Write file contents
  - `validatePath(taskId: string, filePath: string): string` — Security: ensure path stays within worktree
- [ ] Security: Use `path.resolve()` and `path.relative()` to prevent directory traversal attacks
- [ ] Security: Block access to `..` patterns and paths outside the task directory
- [ ] Handle errors: ENOENT (404), EACCES (403), generic errors (500)
- [ ] Add JSDoc comments for all exported functions

**Artifacts:**
- `packages/dashboard/src/file-service.ts` (new)

### Step 3: Add File API Routes

- [ ] Add to `packages/dashboard/src/routes.ts`:
  - `GET /api/tasks/:id/files` — List files in task directory (or worktree if available)
    - Query param: `?path=relative/path` for subdirectory navigation
    - Returns: `{ path: string; entries: FileNode[] }` where FileNode = `{ name: string; type: 'file' | 'directory'; size?: number; mtime?: string }`
  - `GET /api/tasks/:id/files/:filepath(*)` — Read file contents
    - Returns: `{ content: string; mtime: string; size: number }`
  - `POST /api/tasks/:id/files/:filepath(*)` — Write file contents
    - Body: `{ content: string }`
    - Returns: `{ success: true; mtime: string; size: number }`
- [ ] Reuse existing error handling patterns from other routes
- [ ] Use `file-service.ts` functions for actual file operations
- [ ] Add tests in `routes.test.ts` for new endpoints

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 4: Create Client-Side API Functions

- [ ] Add to `packages/dashboard/app/api.ts`:
  - `fetchFileList(taskId: string, path?: string): Promise<FileListResponse>`
  - `fetchFileContent(taskId: string, filePath: string): Promise<FileContentResponse>`
  - `saveFileContent(taskId: string, filePath: string, content: string): Promise<SaveFileResponse>`
- [ ] Use existing `api<T>()` wrapper pattern for consistent error handling
- [ ] Add TypeScript interfaces for response types in `api.ts`

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 5: Create File Browser Hook

- [ ] Create `packages/dashboard/app/hooks/useFileBrowser.ts`:
  - `useFileBrowser(taskId: string, enabled: boolean)` hook
  - Returns: `{ entries, currentPath, setPath, loading, error, refresh }`
  - `FileNode` type with `name`, `type`, `size`, `mtime`
  - Sort: directories first, then files alphabetically
  - Handle "up one level" navigation for subdirectories

**Artifacts:**
- `packages/dashboard/app/hooks/useFileBrowser.ts` (new)

### Step 6: Create File Editor Hook

- [ ] Create `packages/dashboard/app/hooks/useFileEditor.ts`:
  - `useFileEditor(taskId: string, filePath: string | null, enabled: boolean)` hook
  - Returns: `{ content, setContent, originalContent, loading, saving, error, save, hasChanges, mtime }`
  - Load file content when `filePath` changes
  - Track dirty state (`hasChanges = content !== originalContent`)
  - `save()` function calls API to write back

**Artifacts:**
- `packages/dashboard/app/hooks/useFileEditor.ts` (new)

### Step 7: Create FileBrowser Component

- [ ] Create `packages/dashboard/app/components/FileBrowser.tsx`:
  - File tree list view with folder/file icons from `lucide-react`
  - Click directory to navigate in, show ".." row to navigate up
  - Click file to select it (calls `onSelectFile` callback)
  - Show file sizes (formatted), modification times
  - Empty state for empty directories
  - Loading state spinner
  - Error state with retry button
  - CSS classes matching existing patterns (`.file-browser`, `.file-node`, etc.)

**Artifacts:**
- `packages/dashboard/app/components/FileBrowser.tsx` (new)

### Step 8: Create FileEditor Component (CodeMirror)

- [ ] Create `packages/dashboard/app/components/FileEditor.tsx`:
  - Initialize CodeMirror 6 with `@codemirror/basic-setup`
  - Apply one-dark theme matching dashboard dark mode
  - Auto-detect language from file extension:
    - `.ts`, `.tsx` → typescript
    - `.js`, `.jsx` → javascript
    - `.json` → json
    - `.css`, `.scss` → css
    - `.md` → markdown
    - Default: plain text
  - Props: `content`, `onChange`, `readOnly`, `language`
  - Use React ref to manage CodeMirror instance lifecycle
  - Cleanup editor instance on unmount

**Artifacts:**
- `packages/dashboard/app/components/FileEditor.tsx` (new)

### Step 9: Create FileBrowserModal Component

- [ ] Create `packages/dashboard/app/components/FileBrowserModal.tsx`:
  - Split-pane layout: left sidebar (FileBrowser, ~250px), right editor area
  - Header showing current file path, close button
  - Editor toolbar with: Save button (disabled when no changes), Discard Changes button
  - Keyboard shortcuts: `Ctrl/Cmd+S` to save, `Ctrl/Cmd+W` or `Escape` to close
  - Use `useFileBrowser` and `useFileEditor` hooks
  - When no file selected: show placeholder "Select a file to edit"
  - When file is binary (>1MB or non-text mime): show "Binary file, cannot edit"
  - Max file size limit: 1MB (API should reject larger files)
  - `FileBrowserModalProps`: `taskId: string; worktreePath?: string; onClose: () => void; isOpen: boolean`

**Artifacts:**
- `packages/dashboard/app/components/FileBrowserModal.tsx` (new)

### Step 10: Integrate with TaskDetailModal

- [ ] Modify `packages/dashboard/app/components/TaskDetailModal.tsx`:
  - Add new tab `"files"` to `activeTab` state union type
  - Add tab button: "Files" with `Folder` icon from lucide-react
  - Tab is visible only when `task.worktree` exists
  - When Files tab is active, render `FileBrowserModal` inline (not as overlay)
  - OR open `FileBrowserModal` as overlay when Files tab clicked (simpler: use the modal pattern)
  - Better approach: Make FileBrowserModal a separate overlay that opens from the Files tab
  - Add `useState` for `fileBrowserOpen` controlled by Files tab click

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 11: Add Styles

- [ ] Add to `packages/dashboard/app/styles.css`:
  - `.file-browser` — Container with border, background
  - `.file-node` — Row styling, hover effects
  - `.file-node--directory`, `.file-node--file` — Type-specific styling
  - `.file-node--selected` — Selected state highlight
  - `.file-editor-container` — CodeMirror wrapper sizing
  - `.file-browser-modal` — Full modal layout (flex, split pane)
  - `.file-browser-sidebar` — Left panel styles
  - `.file-browser-content` — Right panel styles
  - `.file-browser-toolbar` — Editor toolbar layout
  - Responsive: Stack vertically on mobile (<768px)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 12: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add tests for `file-service.ts` in new `file-service.test.ts`:
  - Test path traversal prevention (attempting `../etc/passwd` should fail)
  - Test list, read, write operations
  - Test error handling for missing files, permission errors
- [ ] Add tests for new API routes in `routes.test.ts`:
  - Test GET /api/tasks/:id/files
  - Test GET /api/tasks/:id/files/:filepath
  - Test POST /api/tasks/:id/files/:filepath
- [ ] Add tests for components:
  - `FileBrowser.test.tsx` — Renders file list, handles clicks, navigation
  - `FileEditor.test.tsx` — CodeMirror renders, onChange fires
  - `FileBrowserModal.test.tsx` — Integration of browser + editor
- [ ] Update `TaskDetailModal.test.tsx` — New Files tab exists when worktree present
- [ ] Run full test suite: `pnpm test`
- [ ] Run build: `pnpm build`
- [ ] Fix all failures

**Artifacts:**
- `packages/dashboard/src/file-service.test.ts` (new)
- `packages/dashboard/app/components/__tests__/FileBrowser.test.tsx` (new)
- `packages/dashboard/app/components/__tests__/FileEditor.test.tsx` (new)
- `packages/dashboard/app/components/__tests__/FileBrowserModal.test.tsx` (new)
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified)

### Step 13: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` — Document the file browser feature
- [ ] Add changeset for the dashboard package (though it's private, for consistency):
  ```bash
  cat > .changeset/add-file-browser-editor.md << 'EOF'
  ---
  "@kb/dashboard": minor
  ---
  
  Add file browser and editor to task detail modal. Browse worktree files and edit with CodeMirror 6.
  EOF
  ```
- [ ] Out-of-scope findings:
  - If worktree path handling reveals issues with path normalization, create new task
  - If CodeMirror bundle size is too large, consider lazy loading for follow-up

**Artifacts:**
- `packages/dashboard/README.md` (modified)
- `.changeset/add-file-browser-editor.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — Add section "File Browser" describing how to browse and edit files from the task detail modal

**Check If Affected:**
- `AGENTS.md` — Update if dashboard development patterns changed significantly

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (full suite: `pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Can open task detail, click Files tab, browse worktree, open file, edit with syntax highlighting, save changes
- [ ] Path traversal attacks are blocked (verified by tests)
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-029): complete Step N — description`
- **Bug fixes:** `fix(KB-029): description`
- **Tests:** `test(KB-029): description`

## Do NOT

- Allow file access outside the task's worktree (security critical)
- Skip security tests for path traversal
- Use CodeMirror 5 (must use CodeMirror 6)
- Skip TypeScript types for new APIs
- Use arbitrary file paths without validation
- Skip error handling for file operations (ENOENT, EACCES, etc.)
- Load entire file tree at once (use pagination/lazy loading if directory is huge — though not required for MVP)
