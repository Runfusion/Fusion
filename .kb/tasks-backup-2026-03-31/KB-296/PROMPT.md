# Task: KB-296 - Show Executor Model on Task Cards for Completed Tasks

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UI enhancement to display existing model data on task cards. No complex logic or state changes, just displaying already-stored task properties.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Add executor model information to task cards so users can see which AI model was used to execute a task without opening the task detail modal. When tasks are in "done", "in-review", or "archived" columns, display a compact model badge showing the provider and model ID if a per-task model override was set. This improves visibility into model usage for auditing and debugging completed work.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskCard.tsx` — How task cards currently display badges (status, size, PR/issue info)
- `packages/dashboard/app/components/ProviderIcon.tsx` — Provider icon component for visual identification
- `packages/dashboard/app/components/ModelSelectorTab.tsx` — How model data is extracted from tasks (`getExecutorSelection`)
- `packages/dashboard/app/styles.css` — Card badge styling patterns (`.card-size-badge`, `.card-status-badge`)

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` — Add model badge display logic
- `packages/dashboard/app/styles.css` — Add `.card-model-badge` styling

## Steps

### Step 1: Add Model Badge Component and Styles

- [ ] Create a compact model badge that displays provider icon + short model name
- [ ] Add `.card-model-badge` CSS class with subtle styling (similar to `.card-size-badge` but distinct)
- [ ] Handle model ID truncation for long names (e.g., "claude-sonnet-4-5" → "claude-sonnet")
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/styles.css` — New `.card-model-badge` styles (modified)

### Step 2: Display Model Badge on TaskCard

- [ ] Import `ProviderIcon` component in TaskCard
- [ ] Add `getExecutorSelection` utility function (or inline equivalent) to extract model info from task
- [ ] Display model badge in card header area when:
  - Task has `modelProvider` AND `modelId` set (custom model override was used)
  - Task is in "done", "in-review", or "archived" column
- [ ] Add tooltip showing full model name on hover
- [ ] Update `areTaskCardPropsEqual` to include model fields (already included, verify working)
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` — Model badge display logic (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify model badge appears on cards with model overrides in done/in-review columns
- [ ] Verify model badge does NOT appear when using default models (no override set)
- [ ] Verify model badge does NOT appear in triage/todo/in-progress columns
- [ ] Verify provider icons render correctly for: anthropic, openai, google/gemini, ollama
- [ ] Verify tooltip shows full model name
- [ ] Verify badge styling is consistent with other card badges
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Update relevant documentation (check if AGENTS.md mentions model display)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Check If Affected:**
- `AGENTS.md` — Check if there's a section on model visibility or task card display; update if relevant

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Model badge displays on done/in-review/archived tasks that used a custom model override
- [ ] Badge styling matches existing card aesthetic
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-296): complete Step N — description`
- **Bug fixes:** `fix(KB-296): description`
- **Tests:** `test(KB-296): description`

## Do NOT

- Modify model storage or task.json structure
- Add model selection to task cards (keep read-only display)
- Show model badge for triage/todo/in-progress columns
- Show model badge when task uses default models (no override)
- Change the ModelSelectorTab behavior
- Add validator model display (focus on executor model only for now)
