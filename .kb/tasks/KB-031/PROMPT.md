# Task: KB-031 - Factory Droid Mission Control Theme

**Created:** 2026-03-30
**Size:** M
**Status:** BLOCKED

## ⚠️ TASK BLOCKED — DO NOT IMPLEMENT

This task **CANNOT be executed** until dependency **KB-024** is complete.

### Blockage Reason
KB-024 (Light Mode Toggle and Theme Selector) provides the theming infrastructure required for this task. Without KB-024's completion, the following essential components do not exist:

- `ColorTheme` type in `packages/core/src/types.ts`
- CSS variable architecture with `[data-color-theme]` attribute selectors
- `useTheme` hook in `packages/dashboard/app/hooks/useTheme.ts`
- `ThemeSelector` component in `packages/dashboard/app/components/ThemeSelector.tsx`

KB-024 is currently in **"todo"** status and has not been started.

### Unblocking Procedure
1. Complete KB-024 fully (all steps, tests passing, infrastructure in place)
2. Return to this task
3. Rewrite this PROMPT.md with a full implementation specification
4. Execute the rewritten specification

---

## Future Task Description (Pending KB-024)

**Goal:** Create a "Factory Droid" theme replicating the industrial sci-fi aesthetic of Factory Droid's Mission Control interface (factorydroid.ai).

**Aesthetic Preview:**
- Dark industrial backgrounds (#0a0a0a, #111111)
- Amber/orange warning light accents (#F59E0B)
- High-contrast terminal-style text
- Industrial status indicator colors (amber, cyan, purple, green)
- Mission control / factory floor automation vibe

**Expected Implementation (once KB-024 complete):**
1. Add `"factory-droid"` to `ColorTheme` type
2. Add `[data-color-theme="factory-droid"]` CSS rules with color variables
3. Register theme in ThemeSelector component
4. Update README documentation
5. Test and verify all components render correctly

**Estimated Effort:** ~2-3 hours of implementation once unblocked.

---

## Dependency

- **Task:** KB-024 — Light Mode Toggle and Theme Selector (MUST be complete)

## Current Action

**DO NOT PROCEED.** Move this task back to Triage column with note: "Blocked on KB-024 — theming infrastructure not yet implemented."
