# Task: KB-230 - Use the real provider icons in the quota dropdown

**Created:** 2026-03-31
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** Low blast radius (single file change), simple pattern following existing implementation in CustomModelDropdown, no security implications, easily reversible.
**Score:** 3/8 — Blast radius: 0, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Update the `ModelCombobox` component in `NewTaskModal.tsx` to display provider icons alongside provider names, matching the behavior of the shared `CustomModelDropdown` component. Currently, the New Task modal's model dropdown shows plain text for providers while other dropdowns in the app (Settings, Task Detail, Inline Create) show actual provider icons (Anthropic, OpenAI, Google, Ollama logos). Search the web for the actual icons

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/CustomModelDropdown.tsx` — Reference implementation showing how ProviderIcon is integrated
2. `packages/dashboard/app/components/ProviderIcon.tsx` — The icon component to use
3. `packages/dashboard/app/components/NewTaskModal.tsx` — The file to modify (see the local `ModelCombobox` component starting at line 28)

## File Scope

- `packages/dashboard/app/components/NewTaskModal.tsx` — Modify the local `ModelCombobox` component

## Steps

### Step 1: Add ProviderIcon import and trigger icon

- [ ] Import `ProviderIcon` from `./ProviderIcon`
- [ ] Extract the current provider from the selected value (similar to CustomModelDropdown)
- [ ] Add provider icon to the trigger button when a model is selected (before the text)

**Implementation notes:**
- In `CustomModelDropdown`, the current provider is extracted with:
  ```ts
  const currentProvider = useMemo(() => {
    if (!value) return null;
    const slashIdx = value.indexOf("/");
    return slashIdx === -1 ? null : value.slice(0, slashIdx);
  }, [value]);
  ```
- The trigger icon is rendered as:
  ```tsx
  {currentProvider && (
    <span className="model-combobox-trigger-icon">
      <ProviderIcon provider={currentProvider} size="sm" />
    </span>
  )}
  ```

**Artifacts:**
- `packages/dashboard/app/components/NewTaskModal.tsx` (modified)

### Step 2: Add provider icons to dropdown groups

- [ ] Add `ProviderIcon` component to each provider optgroup header in the dropdown list
- [ ] Match the styling from `CustomModelDropdown` (icon + text pattern)

**Implementation notes:**
- In `CustomModelDropdown`, the optgroup is rendered as:
  ```tsx
  <div className="model-combobox-optgroup" data-index={groupStartIndex}>
    <ProviderIcon provider={provider} size="sm" />
    <span className="model-combobox-optgroup-text">{provider}</span>
  </div>
  ```
- You'll need to update the optgroup div in `NewTaskModal.tsx` (around line 209) that currently just shows `{provider}` as text

**Artifacts:**
- `packages/dashboard/app/components/NewTaskModal.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run the dashboard tests: `cd packages/dashboard && pnpm test`
- [ ] Run full test suite: `pnpm test` from project root
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Manual verification:**
1. Open the dashboard and click "Create a task with AI planning" (lightbulb icon) or any button that opens the New Task modal
2. In the Model Configuration section, verify:
   - The Executor dropdown trigger shows the provider icon when a model is selected
   - The Validator dropdown trigger shows the provider icon when a model is selected
   - Opening either dropdown shows provider icons next to provider names in the group headers
3. Compare the visual appearance with the Settings modal's model dropdown (which uses CustomModelDropdown)

### Step 4: Documentation & Delivery

- [ ] No documentation updates needed (UI only, consistent with existing patterns)
- [ ] Out-of-scope findings: If you notice other dropdowns missing icons, create follow-up tasks via `task_create` tool

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] New Task modal model dropdowns display provider icons in:
  - Trigger button (when model selected)
  - Dropdown optgroup headers

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-230): complete Step N — description`
- **Bug fixes:** `fix(KB-230): description`
- **Tests:** `test(KB-230): description`

## Do NOT

- Expand task scope to refactor other dropdowns unless explicitly broken
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Remove the existing "Simplified ModelCombobox" comment - it's accurate documentation
