---
title: "DirectoryPicker empty folder reverts on navigation"
date: 2026-06-06
category: ui-bugs
module: packages/dashboard/app/components/DirectoryPicker
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Selecting an empty folder in the directory picker automatically reverts to the previous folder"
  - "Navigation into folders with subdirectories works correctly; empty folders do not"
  - "The 'Select' button shows the wrong path after clicking into an empty directory"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags:
  - react-useeffect
  - state-management
  - directory-picker
  - setup-wizard
  - project-management
  - stale-prop
---

# DirectoryPicker empty folder reverts on navigation

## Problem

In the Fusion dashboard's project setup flow (Setup Wizard and Project Overview "Add Project"), the `DirectoryPicker` component allowed users to browse the filesystem and select a project directory. However, when a user navigated into a folder that contained **no subdirectories**, the picker would automatically jump back to the previously browsed directory. This made it impossible to select an empty folder as a project path — a common scenario when creating a new project in a freshly created directory.

## Symptoms

- Open the directory picker, navigate to a folder with no subdirectories.
- The picker briefly shows "No subdirectories" then reverts to the parent directory.
- If the target folder contains even a single empty subdirectory, navigation works correctly.
- The `currentPath` display in the action footer shows the wrong path after the revert.

## What Didn't Work

- Adding defensive checks for `entries.length === 0` in the render path — the render was correct; the problem was a re-fetch triggered by a `useEffect` that overwrote the navigated state.
- Suspecting a race condition between `onChange` and browser close — the revert happened even without clicking "Select", purely on navigation.
- Suspecting the API response for empty folders — the API correctly returned `entries: []`; the bug was in how the frontend handled that response.

## Solution

In `packages/dashboard/app/components/DirectoryPicker.tsx`, the `useEffect` that auto-fetches entries when the browser panel opens was using the stale `value` prop instead of `browser.currentPath`:

**Before:**

```tsx
useEffect(() => {
  if (browser.isOpen && !browser.loading && browser.entries.length === 0 && !browser.error) {
    fetchEntries(value || undefined, browser.showHidden);
  }
}, [browser.isOpen, browser.loading, browser.entries.length, browser.error, value, browser.showHidden, fetchEntries, nodeId, localNodeId]);
```

**After:**

```tsx
useEffect(() => {
  if (browser.isOpen && !browser.loading && browser.entries.length === 0 && !browser.error) {
    // Use browser.currentPath if available (user has navigated), otherwise fall back to value prop
    fetchEntries(browser.currentPath || value || undefined, browser.showHidden);
  }
}, [browser.isOpen, browser.loading, browser.entries.length, browser.error, value, browser.showHidden, fetchEntries, nodeId, localNodeId]);
```

The fix prioritizes `browser.currentPath` (which reflects the user's current navigation) over the `value` prop (which only updates when the user explicitly clicks "Select").

## Why This Works

The `useEffect` fires when `browser.entries.length === 0` — which is true both on initial open (no entries loaded yet) and after navigating into an empty folder (API returned `entries: []`).

- **On initial open**: `browser.currentPath` is `""`, so `value || undefined` fetches the initial directory. Correct.
- **After navigating into an empty folder**: `browser.currentPath` is the navigated path, so `browser.currentPath || value` fetches the current directory. Correct.
- **Without the fix**: After navigating into an empty folder, the effect used `value` (still `""` or the previous path), causing a refetch of the wrong directory and overwriting `browser.currentPath`.

The bug was a **stale closure / stale prop** issue: the effect captured `value` at render time, but `value` is only updated by the parent when `handleSelect` calls `onChange(browser.currentPath)`. Until then, `value` lags behind the user's navigation.

## Prevention

- **When a `useEffect` re-fetches based on empty-state conditions, prefer derived/local state over props.** Props that update via callbacks are inherently stale until the callback fires. Local state (`browser.currentPath`) reflects the immediate user interaction.
- **Audit empty-state refetch effects** in components with browse/navigate patterns. Any effect keyed on `entries.length === 0` or `data.length === 0` that uses a prop for the fetch path is vulnerable to this pattern.
- **Regression test**: Mock `browseDirectory` to return `entries: []` for a subdirectory, navigate into it, and assert the component does not re-fetch the parent path. The test in `DirectoryPicker.test.tsx` ("does not revert to previous folder when navigating into an empty directory") captures this invariant.
- **Grep heuristic** for similar bugs:
  ```bash
  git grep -nE "fetchEntries\(.*value.*\)" -- '*.tsx'
  git grep -nE "useEffect.*entries\.length === 0" -- '*.tsx'
  ```
  Look for effects that fetch based on empty data and use a prop as the fetch key.

## Related

- PR #1466 — fix and "New folder" button feature.
- `docs/solutions/ui-bugs/skill-autocomplete-highlight-reset-on-swr-revalidation.md` — a related class of `useEffect` bugs keyed on stale/array identity, with broader prevention guidance.
- `packages/dashboard/app/components/DirectoryPicker.tsx` — the fixed component.
- `packages/dashboard/app/components/__tests__/DirectoryPicker.test.tsx` — regression tests.