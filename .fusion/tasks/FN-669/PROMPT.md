# Task: FN-669 - Support deep link to view task modal from ntfy notification with a setting for the host name to use

**Created:** 2026-04-01
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a cross-cutting feature touching backend (notification system), types/schema, and frontend (dashboard deep link handling). It requires careful integration between the notifier and dashboard routing. Pattern is straightforward (URL param parsing, settings persistence) but multiple files involved.

**Score:** 5/8 — Blast radius: 1 (localized to ntfy notifications), Pattern novelty: 1 (standard query param pattern), Security: 1 (need to validate URLs/hostnames), Reversibility: 2 (easily removable).

## Mission

Add deep link support to ntfy notifications so clicking a notification opens the specific task in the Fusion dashboard. Include a configurable dashboard hostname setting to support different deployment environments (local development, custom domains, etc.).

When a user receives an ntfy notification about a task completing, failing, or merging, tapping the notification should open the dashboard directly to that task's detail modal. The dashboard URL must be configurable since users may run Fusion on different hosts/ports.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — GlobalSettings interface and GLOBAL_SETTINGS_KEYS array (add new setting here)
- `packages/engine/src/notifier.ts` — NtfyNotifier class that sends notifications (add Click header with deep link)
- `packages/dashboard/app/App.tsx` — Main app component, manages TaskDetailModal visibility (parse query param on mount)
- `packages/dashboard/app/components/SettingsModal.tsx` — Settings UI, notifications section (add hostname input field)
- `packages/dashboard/app/api.ts` — API client functions (may need to read task by ID for deep link)

## File Scope

- `packages/core/src/types.ts` — Add `ntfyDashboardHost` to GlobalSettings interface and GLOBAL_SETTINGS_KEYS
- `packages/engine/src/notifier.ts` — Add Click header with deep link URL to notifications
- `packages/engine/src/notifier.test.ts` — Add tests for deep link generation
- `packages/dashboard/app/App.tsx` — Parse `?task={id}` query param on mount, open task modal if present
- `packages/dashboard/app/components/SettingsModal.tsx` — Add hostname input in notifications section
- `packages/dashboard/app/api.ts` — Ensure fetchTask exists for loading task by ID (or verify it exists)

## Steps

### Step 1: Add Setting Type and Schema

- [ ] Add `ntfyDashboardHost?: string` to `GlobalSettings` interface in `packages/core/src/types.ts`
- [ ] Add `"ntfyDashboardHost"` to `GLOBAL_SETTINGS_KEYS` array in same file
- [ ] Set default value to `undefined` in `DEFAULT_GLOBAL_SETTINGS`
- [ ] Run core package tests to ensure types compile

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Update NtfyNotifier to Include Deep Links

- [ ] Read `ntfyDashboardHost` from settings in `NtfyNotifier.loadConfig()`
- [ ] Add private method `buildTaskUrl(taskId: string): string | undefined` that:
  - Returns `undefined` if `ntfyDashboardHost` is not set
  - Strips trailing slash from hostname if present
  - Constructs URL: `{host}/?task={taskId}`
- [ ] Add `Click` HTTP header to all `sendNotification()` calls when URL is available
  - Header format: `Click: {url}`
  - Include for in-review, failed, and merged notifications
- [ ] Update `NtfyNotifierOptions` interface to accept optional `ntfyDashboardHost`

**Artifacts:**
- `packages/engine/src/notifier.ts` (modified)

### Step 3: Update Notifier Tests

- [ ] Add test: "includes Click header with task URL when ntfyDashboardHost is set"
- [ ] Add test: "does not include Click header when ntfyDashboardHost is not set"
- [ ] Add test: "handles hostname with trailing slash correctly"
- [ ] Add test: "handles hostname without trailing slash correctly"
- [ ] Run engine tests to verify all pass

**Artifacts:**
- `packages/engine/src/notifier.test.ts` (modified)

### Step 4: Add Dashboard Deep Link Handling

- [ ] In `App.tsx`, add effect that runs once on mount to check for deep link:
  ```typescript
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const taskId = params.get('task');
    if (taskId) {
      // Remove the query param from URL without reloading
      const url = new URL(window.location.href);
      url.searchParams.delete('task');
      window.history.replaceState({}, '', url.toString());
      
      // Load and open the task
      // (implementation details in sub-steps)
    }
  }, []);
  ```
- [ ] Add state variable `deepLinkTaskId` to track pending deep link
- [ ] Add effect that watches `tasks` array:
  - When `deepLinkTaskId` is set and tasks are loaded
  - Find matching task and call `handleDetailOpen()`
  - Clear `deepLinkTaskId` after opening
- [ ] If task not found in loaded tasks (pagination), fetch directly via API:
  - Use existing `fetchTask(taskId)` or similar API function
  - Open modal once fetched
- [ ] Handle error case: show toast notification if task not found

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 5: Add Dashboard Hostname Setting UI

- [ ] In `SettingsModal.tsx` notifications section, add new input field:
  - Label: "Dashboard Hostname"
  - Placeholder: "http://localhost:3000" or "https://fusion.example.com"
  - Only visible when `ntfyEnabled` is true
- [ ] Add validation: must be valid URL format (http:// or https://)
- [ ] Include in form state (already covered by Settings type)
- [ ] Save with global settings via `updateGlobalSettings()`
- [ ] Add help text explaining the setting purpose

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Verification steps:**
1. Open dashboard, go to Settings > Notifications
2. Enable ntfy, set topic, set dashboard hostname to `http://localhost:3000`
3. Create a test task and move it to in-review
4. Check ntfy notification includes `Click: http://localhost:3000/?task={id}` header
5. Open dashboard with `?task={id}` in URL
6. Verify task detail modal opens automatically
7. Verify URL param is cleaned from address bar after opening

### Step 7: Documentation & Delivery

- [ ] Update relevant documentation (AGENTS.md ntfy section if exists)
- [ ] Create changeset file for the feature:
  ```bash
  cat > .changeset/ntfy-deep-link.md << 'EOF'
  ---
  "@gsxdsm/fusion": minor
  ---

  Add deep link support to ntfy notifications. Notifications now include a Click URL that opens the dashboard directly to the task. New global setting "Dashboard Hostname" configures the base URL for deep links.
  EOF
  ```
- [ ] Out-of-scope findings: None expected

## Documentation Requirements

**Must Update:**
- None (feature is self-documenting in UI)

**Check If Affected:**
- `AGENTS.md` — Add note about ntfy deep link capability if there's an ntfy section

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Dashboard hostname setting persists across reloads
- [ ] Notifications include Click header when hostname is configured
- [ ] Deep link opens task modal automatically
- [ ] URL parameter cleaned after opening modal

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-669): complete Step N — description`
- **Bug fixes:** `fix(FN-669): description`
- **Tests:** `test(FN-669): description`

Example commits:
- `feat(FN-669): complete Step 1 — add ntfyDashboardHost to GlobalSettings`
- `feat(FN-669): complete Step 2 — add Click header with deep link URL`
- `feat(FN-669): complete Step 4 — handle deep link query param in dashboard`
- `feat(FN-669): complete Step 5 — add dashboard hostname UI in settings`

## Do NOT

- Expand scope to add mobile app support or custom URL schemes
- Modify the ntfy topic validation (keep existing 1-64 char limit)
- Add authentication tokens to the deep link (task IDs are not sensitive)
- Support custom URL paths beyond `/?task={id}` (keep simple)
- Change the notification message body or title format
- Add deep link support for other notification channels (keep ntfy-only)
