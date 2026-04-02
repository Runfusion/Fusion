# Task: KB-276 - Planning mode should let you upload a doc

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This feature requires coordination between frontend UI changes, backend API additions, and AI prompt integration. It touches file upload patterns and planning session state management.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Enable document uploads in Planning Mode so users can provide reference materials (design docs, API specs, screenshots, etc.) that the AI can reference during the interactive planning conversation. This extends the existing planning session infrastructure to support file attachments, similar to how task attachments work in the TaskDetailModal.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/PlanningModeModal.tsx` — Current planning mode UI implementation
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Reference for file upload UI pattern (lines 377-430, 837-910)
- `packages/dashboard/app/api.ts` — API functions including `uploadAttachment`, `startPlanningStreaming`, `respondToPlanning`
- `packages/dashboard/src/planning.ts` — Server-side planning session management (Session interface, createSessionWithAgent)
- `packages/dashboard/src/routes.ts` — API routes for task attachments (lines 1258-1300) and planning endpoints (lines 3904-4130)
- `packages/core/src/types.ts` — TaskAttachment type definition

## File Scope

- `packages/dashboard/app/components/PlanningModeModal.tsx` — Add file upload UI
- `packages/dashboard/app/api.ts` — Add planning attachment API functions
- `packages/dashboard/src/planning.ts` — Add attachments to Session interface and prompt integration
- `packages/dashboard/src/routes.ts` — Add planning attachment routes
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` — Add tests for upload functionality

## Steps

### Step 1: Backend Planning Session Attachments

- [ ] Add `attachments: TaskAttachment[]` field to the internal `Session` interface in `packages/dashboard/src/planning.ts`
- [ ] Initialize `attachments` as empty array in `createSession` and `createSessionWithAgent`
- [ ] Create `addPlanningAttachment(sessionId: string, file: File)` function to store attachments in session
- [ ] Create `getPlanningAttachment(sessionId: string, filename: string)` function to retrieve files
- [ ] Create `deletePlanningAttachment(sessionId: string, filename: string)` function
- [ ] Update session `updatedAt` timestamp on attachment operations

**Artifacts:**
- `packages/dashboard/src/planning.ts` (modified)

### Step 2: Backend API Routes

- [ ] Add `POST /planning/:sessionId/attachments` route with multer upload handler
- [ ] Add `GET /planning/:sessionId/attachments/:filename` route for download
- [ ] Add `DELETE /planning/:sessionId/attachments/:filename` route for deletion
- [ ] Add `GET /planning/:sessionId/attachments` route to list attachments
- [ ] Store uploaded files in `.fusion/planning-attachments/:sessionId/` directory
- [ ] Return `TaskAttachment` metadata on successful upload
- [ ] Handle errors: session not found, file too large (>10MB), invalid file type

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 3: Frontend API Functions

- [ ] Add `uploadPlanningAttachment(sessionId: string, file: File): Promise<TaskAttachment>` in `api.ts`
- [ ] Add `deletePlanningAttachment(sessionId: string, filename: string): Promise<void>` in `api.ts`
- [ ] Add `fetchPlanningAttachments(sessionId: string): Promise<TaskAttachment[]>` in `api.ts`
- [ ] Use FormData for file uploads (same pattern as task attachments)

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 4: Frontend UI Implementation

- [ ] Add attachment state management to `PlanningModeModal` component
- [ ] Add file upload button in the initial planning view (below the textarea)
- [ ] Display uploaded file list with file names, sizes, and delete buttons
- [ ] Support drag-and-drop file upload on the planning modal
- [ ] Support paste-to-upload for images (screenshots)
- [ ] Show upload progress indicator
- [ ] Disable uploads when planning is in "loading" or "question" state (after session has progressed)
- [ ] Style with existing CSS classes (`.planning-*` pattern)

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)

### Step 5: AI Prompt Integration

- [ ] Modify `PLANNING_SYSTEM_PROMPT` in `planning.ts` to mention that document context may be provided
- [ ] When calling the AI agent, include attachment metadata in the context:
  - Filename, mime type, and size
  - For text files: include file content in the prompt
  - For images: mention they are available as reference
- [ ] Update the `initialPlan` prompt to reference attached documents when present

**Artifacts:**
- `packages/dashboard/src/planning.ts` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: "uploads file in planning mode" — verify file upload UI and API call
- [ ] Add test: "displays uploaded attachments" — verify file list renders with correct metadata
- [ ] Add test: "deletes attachment" — verify delete button calls API and updates UI
- [ ] Add test: "includes attachments in AI context" — verify prompt includes attachment info
- [ ] Run full test suite: `pnpm test`
- [ ] Run build: `pnpm build`
- [ ] Fix all failures

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` (modified)

### Step 7: Documentation & Delivery

- [ ] Create changeset file: `.changeset/planning-mode-doc-upload.md` with patch bump for `@dustinbyrne/kb`
- [ ] Update dashboard documentation if there is a user guide mentioning planning mode
- [ ] Check if `AGENTS.md` needs updates for planning mode usage

**Artifacts:**
- `.changeset/planning-mode-doc-upload.md` (new)

## Documentation Requirements

**Must Update:**
- `.changeset/planning-mode-doc-upload.md` — Document the new document upload feature in planning mode

**Check If Affected:**
- `AGENTS.md` — Update if there's a section on planning mode usage

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] User can upload documents in planning mode initial view
- [ ] Uploaded documents are visible in the UI before starting planning
- [ ] AI agent receives attachment context during planning conversation
- [ ] Attachments transfer to the created task when planning completes
- [ ] Changeset file included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-276): complete Step N — description`
- **Bug fixes:** `fix(KB-276): description`
- **Tests:** `test(KB-276): description`

## Do NOT

- Expand scope to allow uploads during question/answer phase (only initial view)
- Allow executable file uploads (.exe, .bin, .sh) — restrict to docs, images, text files
- Store attachments permanently — clean up with session cleanup
- Skip security validation on file uploads (size limits, type checks)
- Modify the task attachment system — planning attachments are separate
