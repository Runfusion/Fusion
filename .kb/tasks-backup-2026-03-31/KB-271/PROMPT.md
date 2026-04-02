# Task: KB-271 - Add Option on New Task Dialog to Specify Thinking Level

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This change spans the full stack (types, store, API, frontend) with a clear pattern following existing model override fields. Low blast radius — additive feature that doesn't modify existing behavior when not specified.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Add a "Thinking Level" option to the new task creation dialog (both NewTaskModal and QuickEntryBox) that allows users to specify the AI reasoning effort level (off/minimal/low/medium/high) on a per-task basis. This overrides the global `defaultThinkingLevel` setting for that specific task.

The thinking level controls how much reasoning effort the AI model uses — higher levels produce better results but cost more. This gives users fine-grained control over the quality/cost tradeoff for individual tasks.

## Dependencies

- **Task:** KB-074 (Quick Entry Box for Tasks) — Must be complete as we add thinking level to both NewTaskModal and QuickEntryBox

## Context to Read First

1. `/Users/eclipxe/Projects/kb/packages/core/src/types.ts` — Review `ThinkingLevel` type definition and `Task`/`TaskCreateInput` interfaces
2. `/Users/eclipxe/Projects/kb/packages/core/src/store.ts` — Review `createTask` method to understand how fields are persisted
3. `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — Review POST `/api/tasks` endpoint around line 1118 to see how `modelProvider`/`modelId` are validated and passed
4. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/NewTaskModal.tsx` — Review how model configuration section works, especially the `ModelCombobox` pattern
5. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/QuickEntryBox.tsx` — Review how model overrides are handled in the inline creation flow
6. `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — Review `createTask` function to see how task creation parameters are sent to the server

## File Scope

### Core Types & Store
- `packages/core/src/types.ts` — Add `thinkingLevel` to `Task` and `TaskCreateInput` interfaces
- `packages/core/src/store.ts` — Update `createTask` to persist `thinkingLevel` field

### Dashboard API & Routes
- `packages/dashboard/src/routes.ts` — Add `thinkingLevel` validation and pass to `store.createTask()` in POST `/api/tasks` endpoint
- `packages/dashboard/app/api.ts` — Add `thinkingLevel` parameter to `createTask` function

### Frontend Components
- `packages/dashboard/app/components/NewTaskModal.tsx` — Add thinking level selector UI in Model Configuration section
- `packages/dashboard/app/components/QuickEntryBox.tsx` — Add thinking level selector alongside model dropdown

### Tests
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` — Add tests for thinking level selection

## Steps

### Step 1: Update Core Types

- [ ] Add `thinkingLevel?: ThinkingLevel` field to `Task` interface in `packages/core/src/types.ts`
- [ ] Add `thinkingLevel?: ThinkingLevel` field to `TaskCreateInput` interface in `packages/core/src/types.ts`
- [ ] Run `pnpm build` in `packages/core` to verify types compile

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Update Store Layer

- [ ] Update `createTask` method in `packages/core/src/store.ts` to include `thinkingLevel: input.thinkingLevel` in the task object creation
- [ ] Run `pnpm test` in `packages/core` to verify store tests pass

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 3: Update Dashboard API Routes

- [ ] Add `thinkingLevel` validation in POST `/api/tasks` endpoint in `packages/dashboard/src/routes.ts` (validate it's one of the valid `THINKING_LEVELS` values if provided)
- [ ] Pass `thinkingLevel` to `store.createTask()` call
- [ ] Run `pnpm test` in `packages/dashboard` to verify route tests pass

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 4: Update Frontend API Layer

- [ ] Add `thinkingLevel?: import("@kb/core").ThinkingLevel` parameter to `createTask` function in `packages/dashboard/app/api.ts`
- [ ] Include `thinkingLevel` in the JSON body sent to the API

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 5: Add Thinking Level Selector to NewTaskModal

- [ ] Add `thinkingLevel` state variable (default to empty string meaning "use default")
- [ ] Add thinking level dropdown/select in the Model Configuration section, after the validator model selector
- [ ] Use the same pattern as model selectors: "Use default" option plus the 5 thinking levels (off, minimal, low, medium, high)
- [ ] Include `thinkingLevel` in the `onCreateTask` call when creating the task
- [ ] Reset `thinkingLevel` state in `handleClose` and `handleSubmit` functions

**UI Pattern to Follow:**
```tsx
<div className="model-select-row">
  <label htmlFor="thinking-level" className="model-select-label">Thinking Level</label>
  <select id="thinking-level" value={thinkingLevel} onChange={...}>
    <option value="">Use default</option>
    <option value="off">Off</option>
    <option value="minimal">Minimal</option>
    <option value="low">Low</option>
    <option value="medium">Medium</option>
    <option value="high">High</option>
  </select>
</div>
```

**Artifacts:**
- `packages/dashboard/app/components/NewTaskModal.tsx` (modified)

### Step 6: Add Thinking Level Selector to QuickEntryBox

- [ ] Add `thinkingLevel` state variable (default to undefined)
- [ ] Add thinking level dropdown in the models dropdown panel, after the validator model selector
- [ ] Include `thinkingLevel` in the `onCreate` call
- [ ] Reset `thinkingLevel` state in `resetForm` function

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test in `NewTaskModal.test.tsx` to verify thinking level selection is passed to `onCreateTask`
- [ ] Add test to verify "Use default" (empty) doesn't send thinking level
- [ ] Run `pnpm test` in `packages/dashboard` — all tests must pass
- [ ] Run `pnpm test` in `packages/core` — all tests must pass
- [ ] Run `pnpm build` at root — must compile without errors

**Test Example:**
```tsx
it("creates task with selected thinking level", async () => {
  const { props } = renderNewTaskModal();
  fireEvent.change(screen.getByLabelText(/Description/i), { target: { value: "Test task" } });
  fireEvent.change(screen.getByLabelText(/Thinking Level/i), { target: { value: "high" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
  await waitFor(() => {
    expect(props.onCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      thinkingLevel: "high",
    }));
  });
});
```

### Step 8: Documentation & Delivery

- [ ] Update AGENTS.md if there's a section about task creation options
- [ ] Create changeset file for this feature (minor bump for `@dustinbyrne/kb` since it's a new feature)

**Changeset:**
```bash
cat > .changeset/add-thinking-level-option.md << 'EOF'
---
"@dustinbyrne/kb": minor
---

Add thinking level option to new task dialog. Users can now specify per-task reasoning effort (off/minimal/low/medium/high) overriding the global default.
EOF
```

**Artifacts:**
- `.changeset/add-thinking-level-option.md` (new)

## Completion Criteria

- [ ] User can select thinking level in NewTaskModal (off/minimal/low/medium/high or use default)
- [ ] User can select thinking level in QuickEntryBox model dropdown
- [ ] Selected thinking level is persisted on the task and visible in task details
- [ ] When thinking level is not specified, task uses global `defaultThinkingLevel` setting
- [ ] All tests pass
- [ ] Build succeeds
- [ ] Changeset created

## Do NOT

- Modify the engine executor to actually use the thinking level yet — this task is only about adding the option to the dialog and storing it on tasks
- Add thinking level to the task detail modal or task card display (separate task if needed)
- Change global settings or default thinking level behavior
- Add thinking level to model presets (out of scope)
