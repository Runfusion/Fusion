# Task: KB-225 - Add a refine with AI option in the quick task

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This involves UI components in multiple locations (QuickEntryBox, NewTaskModal), a new backend API endpoint for AI text refinement, and integration with the existing AI infrastructure. The pattern is similar to planning mode but simpler.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Add an AI-powered text refinement feature to both the quick task entry box and the new task dialog. Users can click a "refine with AI" button that presents a submenu with refinement options (clarify, add details, expand, simplify). The AI will process the current description text and return an improved version, which replaces the input content.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/QuickEntryBox.tsx` - The quick entry textarea component used in board triage column and list view
2. `packages/dashboard/app/components/NewTaskModal.tsx` - The full task creation modal with description field
3. `packages/dashboard/app/api.ts` - Frontend API functions, note the `refineTask` function (different from this feature - that's for creating refinement tasks)
4. `packages/dashboard/src/routes.ts` - Backend API routes, see the planning mode endpoints around line 2830 for AI integration patterns
5. `packages/dashboard/src/planning.ts` - Planning mode implementation showing how to use `@kb/engine`'s `createKbAgent` for AI calls. Pay special attention to:
   - Rate limiting pattern using in-memory Map with TTL cleanup (lines 235-262)
   - Dynamic import pattern for `@kb/engine` (line 89-101)
   - Session management patterns
6. `packages/dashboard/app/styles.css` - CSS classes for dropdowns (`.dep-dropdown`, `.inline-create-model-dropdown`)
7. `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` - Existing tests for QuickEntryBox

## File Scope

### Frontend
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)
- `packages/dashboard/app/components/NewTaskModal.tsx` (modified)
- `packages/dashboard/app/api.ts` (modified - add `refineText` API function)
- `packages/dashboard/app/styles.css` (modified - add refine submenu styles)

### Backend
- `packages/dashboard/src/ai-refine.ts` (new - AI text refinement service)
- `packages/dashboard/src/routes.ts` (modified - add POST /api/ai/refine-text endpoint)

### Tests
- `packages/dashboard/src/ai-refine.test.ts` (new - backend service tests)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` (modified)

## Steps

### Step 1: Backend API - AI Text Refinement Service

Create a simple AI text refinement service and API endpoint.

- [ ] Create `packages/dashboard/src/ai-refine.ts` with:
  - `RefinementType` union type: `"clarify" | "add-details" | "expand" | "simplify"`
  - `REFINE_SYSTEM_PROMPT` - Instructions for the AI to refine task descriptions based on the type
  - `refineText(text: string, type: RefinementType): Promise<string>` function
  - Uses `createKbAgent` from `@kb/engine` using the dynamic import pattern from `planning.ts`
  - Rate limiting using in-memory Map with TTL (follow `planning.ts` pattern exactly):
    - Max 10 requests per IP per hour
    - Store timestamps in Map, cleanup expired entries
    - Throw `RateLimitError` when limit exceeded
  - Text length validation: 1-2000 characters input

- [ ] Add POST `/api/ai/refine-text` endpoint in `routes.ts`:
  - Request body: `{ text: string, type: string }`
  - Response: `{ refined: string }`
  - HTTP status codes:
    - 200: Success
    - 400: Missing text, text too short/long (not 1-2000 chars), or missing type
    - 422: Invalid refinement type (not one of the 4 valid options)
    - 429: Rate limit exceeded (10/hour per IP)
    - 500: AI service error or internal error
  - Error response format: `{ error: string }`

**Artifacts:**
- `packages/dashboard/src/ai-refine.ts` (new)
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Frontend API Integration

Add the frontend API function to call the refinement endpoint.

- [ ] Add `RefinementType` re-export in `api.ts` (type defined in `ai-refine.ts`)
- [ ] Add `refineText(text: string, type: RefinementType): Promise<string>` function in `api.ts`
- [ ] Handle error cases with appropriate toast messages:
  - Rate limit (429): "Too many refinement requests. Please wait an hour."
  - Invalid type (422): "Invalid refinement option selected."
  - Network/server errors: "Failed to refine text. Please try again."
  - Text validation errors: Pass through error message from backend

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 3: QuickEntryBox Enhancements

Add the refine with AI button and submenu to the quick entry box.

- [ ] Add state to QuickEntryBox:
  - `isRefineMenuOpen: boolean`
  - `isRefining: boolean`

- [ ] Add refine button (sparkles icon "✨" or "Refine" text) visible when:
  - Textarea has content (description.trim().length > 0)
  - Not currently submitting
  - Position: right side of the quick entry box or as a small button near the textarea
  
- [ ] Create submenu that appears when refine button is clicked:
  - Position: absolute, below the button (follow `.dep-dropdown` positioning)
  - Options with title and description:
    - "Clarify" — "Make the description clearer and more specific"
    - "Add details" — "Add implementation details and context"
    - "Expand" — "Expand into a more comprehensive description"
    - "Simplify" — "Simplify and make more concise"
  - Close on click outside, Escape key, or selecting an option
  - Use CSS classes following the `.dep-dropdown` pattern

- [ ] Implement refinement flow:
  - On menu item click, call `refineText(description, type)`
  - Show loading state: button shows spinner or "Refining..." text
  - Disable refine button during refinement
  - On success: replace textarea content with refined text, close menu, show toast "Description refined with AI"
  - On error: show toast with error message from api.ts, keep original text
  - Auto-resize textarea after content update (use existing `autoResize` callback)

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 4: NewTaskModal Enhancements

Add the same refine functionality to the new task modal's description field.

- [ ] Add state to NewTaskModal:
  - `isRefineMenuOpen: boolean`
  - `isRefining: boolean`

- [ ] Add refine button positioned near the description textarea (right side, similar to how InlineCreateCard positions buttons)

- [ ] Reuse the same submenu component/pattern for the refinement options:
  - Same 4 options with descriptions as QuickEntryBox
  - Same styling and behavior

- [ ] Implement the same refinement flow as QuickEntryBox:
  - Loading state with button disabled
  - Success: update description, show toast, close menu
  - Error: show toast, preserve original
  - Auto-resize description textarea after refinement (call `handleDescriptionChange` or similar)

**Artifacts:**
- `packages/dashboard/app/components/NewTaskModal.tsx` (modified)

### Step 5: Styling

Add CSS styles for the refine submenu and button states.

- [ ] Add `.refine-menu` class following the `.dep-dropdown` pattern:
  - Background: var(--surface)
  - Border: 1px solid var(--border)
  - Border-radius: 6px
  - Box-shadow: 0 4px 12px rgba(0,0,0,0.15)
  - Min-width: 200px
  - Z-index: 100 (above other elements)
  - Position: absolute

- [ ] Add `.refine-menu-item` class following `.dep-dropdown-item`:
  - Padding: 10px 14px
  - Hover background: var(--surface-hover)
  - Cursor: pointer
  - Border-bottom: 1px solid var(--border) (except last item)

- [ ] Add `.refine-menu-item-title` for bold option text (font-weight: 500)
- [ ] Add `.refine-menu-item-desc` for smaller descriptive text (font-size: 12px, color: var(--text-secondary))
- [ ] Add `.refine-button` styles matching existing small button patterns
- [ ] Add `.refine-button--loading` state with reduced opacity and cursor: not-allowed
- [ ] Ensure menu works in both light and dark themes (uses CSS variables)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add tests for `ai-refine.ts` backend service:
  - Rate limiting allows 10 requests then blocks
  - Rate limit resets after 1 hour
  - Valid text refinement returns refined text
  - Invalid type throws appropriate error
  - Text length validation (1-2000 chars)

- [ ] Add tests for QuickEntryBox:
  - Refine button appears when text is entered
  - Refine button hidden when textarea is empty
  - Refine menu opens on button click
  - Menu closes on Escape key
  - Menu closes on click outside
  - Menu closes when option selected
  - Successful refinement updates textarea content
  - Failed refinement shows toast and preserves original text
  - Loading state disables button during refinement
  - Auto-resize called after refinement

- [ ] Add tests for NewTaskModal:
  - Refine button appears when description has content
  - Refine flow works correctly (success path)
  - Error handling shows toast
  - Textarea auto-resizes after refinement

- [ ] Run full test suite:
  ```bash
  cd packages/dashboard && pnpm test
  ```
- [ ] Fix all failures
- [ ] Build passes:
  ```bash
  pnpm build
  ```

**Artifacts:**
- `packages/dashboard/src/ai-refine.test.ts` (new)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` (modified)

### Step 7: Documentation & Delivery

- [ ] Create changeset for the new feature (minor bump for `@dustinbyrne/kb` since this adds new user-facing functionality):
  ```bash
  cat > .changeset/add-ai-refine-option.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add AI text refinement to quick task entry and new task dialog. Users can now refine task descriptions with options to clarify, add details, expand, or simplify the text before creating tasks.
  EOF
  ```

- [ ] Include changeset in final commit

## Documentation Requirements

**Must Update:**
- Changeset file as shown above

**Check If Affected:**
- `AGENTS.md` - Add note about the refine feature if documenting dashboard features

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Both QuickEntryBox (board and list views) and NewTaskModal have the refine feature
- [ ] Four refinement options work: clarify, add-details, expand, simplify
- [ ] Rate limiting prevents abuse (10/hour per IP) with proper error messages
- [ ] UI shows appropriate loading and error states
- [ ] Changeset created for version bump
- [ ] No browser keyboard shortcut conflicts (avoided Ctrl/Cmd+R)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-225): complete Step N — description`
- **Bug fixes:** `fix(KB-225): description`
- **Tests:** `test(KB-225): description`

## Do NOT

- Expand task scope beyond the specified refinement options
- Skip tests for the new functionality
- Modify files outside the File Scope without good reason
- Use the existing `refineTask` API (that's for creating refinement tasks, not text refinement)
- Commit without the task ID prefix
- Add keyboard shortcuts that conflict with browser defaults (e.g., Ctrl/Cmd+R for reload)
