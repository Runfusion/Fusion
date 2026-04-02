# Task: KB-227 - Allow Viewing All Files in File Editor (Remove Binary File Restrictions)

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Straightforward change removing an artificial restriction. Well-defined scope with clear completion criteria. Minimal blast radius confined to file service and related tests.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1 (still has path validation), Reversibility: 1

## Mission

The dashboard's file editor currently blocks viewing of "binary" files based on file extension (e.g., .png, .jpg, .pdf). This restriction is unnecessary — users should be able to view any file, even if they can't meaningfully edit binary content. Remove the binary file restriction from the read endpoints while keeping binary files read-only in the editor.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/file-service.ts` — Core file service with `readFile()` and `readProjectFile()` functions that currently throw errors for binary files
- `packages/dashboard/src/routes.test.ts` — Tests that verify the current binary file blocking behavior (search for "binary")
- `packages/dashboard/app/components/FileEditor.tsx` — Simple textarea-based editor component
- `packages/dashboard/app/components/FileBrowserModal.tsx` — Modal that orchestrates file browsing and editing, passes `readOnly` prop to FileEditor

## File Scope

- `packages/dashboard/src/file-service.ts` (modify)
- `packages/dashboard/src/routes.test.ts` (modify test expectations)
- `packages/dashboard/app/components/FileBrowserModal.tsx` (modify — detect binary files and set readOnly)

## Steps

### Step 1: Remove Binary File Restriction from File Service

- [ ] Remove the binary file check from `readFile()` function (around line 295) — delete the `if (isBinaryFile(basename))` block that throws `FileServiceError`
- [ ] Remove the binary file check from `readProjectFile()` function (around line 511) — delete the same pattern
- [ ] Remove the now-unused `isBinaryFile()` function and `BINARY_EXTENSIONS` Set (around lines 87-106) — keep `TEXT_EXTENSIONS` as it may be useful for other purposes
- [ ] Verify the `MAX_FILE_SIZE` check remains in place (security guardrail)

**Artifacts:**
- `packages/dashboard/src/file-service.ts` (modified)

### Step 2: Update Backend Tests

- [ ] Update the test "returns 415 for binary files" in routes.test.ts (around line 3459) — change expectation from error (415) to success (200)
- [ ] The test should now verify that binary files (e.g., `image.png`) can be read successfully
- [ ] Run backend tests: `pnpm test -- packages/dashboard/src/routes.test.ts` and ensure they pass

**Artifacts:**
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 3: Set Binary Files to Read-Only in Frontend

- [ ] In `FileBrowserModal.tsx`, add logic to detect binary files by extension before passing to FileEditor
- [ ] Create a helper function `isBinaryFile(filename: string): boolean` that checks common binary extensions (use the same list that was in file-service.ts: .png, .jpg, .jpeg, .gif, .webp, .ico, .pdf, .zip, .tar, .gz, .mp3, .mp4, .woff, .ttf, etc.)
- [ ] Pass `readOnly={isBinaryFile(selectedFile)}` to the `FileEditor` component
- [ ] Binary files should show "Binary file — read only" indicator in the toolbar area (add visual cue near the filename in the toolbar)

**Artifacts:**
- `packages/dashboard/app/components/FileBrowserModal.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] No documentation updates required — this is a UX improvement that removes an artificial limitation
- [ ] Out-of-scope findings created as new tasks via `task_create` tool (if any)

## Completion Criteria

- [ ] All binary file viewing restrictions removed from backend
- [ ] Binary files can be viewed (content returned as-is, even if not human-readable)
- [ ] Binary files are automatically set to read-only in the editor
- [ ] Text files remain editable as before
- [ ] All tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-227): complete Step N — description`
- **Bug fixes:** `fix(KB-227): description`
- **Tests:** `test(KB-227): description`

## Do NOT

- Remove the `MAX_FILE_SIZE` limit (1MB) — this is a legitimate security guardrail
- Remove path traversal protection in `validatePath()` — this must remain
- Add binary-to-text conversion (hex view, base64, etc.) — out of scope, raw content only
- Change the file browser listing behavior — it already handles directories correctly
- Modify the save/write endpoints to allow writing binary files — keep write restrictions for binary files

## Binary File Extension Reference (for frontend detection)

Use this list in the frontend `isBinaryFile()` helper:
- Images: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.ico`, `.bmp`, `.svgz`
- Executables/Libraries: `.exe`, `.dll`, `.so`, `.dylib`
- Archives: `.zip`, `.tar`, `.gz`, `.bz2`, `.xz`, `.7z`, `.rar`
- Documents: `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`
- Media: `.mp3`, `.mp4`, `.avi`, `.mov`, `.webm`, `.mkv`, `.flv`
- Fonts: `.woff`, `.woff2`, `.ttf`, `.otf`, `.eot`
- Other: `.wasm`, `.bin`
