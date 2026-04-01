# Task: FN-663 - Add Clickable Links to Ntfy Notifications

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused feature addition with a single new setting and a simple change to notification headers. Well-contained scope with clear test requirements.
**Score:** 3/8 — Blast radius: 1 (isolated to ntfy notifier), Pattern novelty: 1 (standard header addition), Security: 1 (URL validation needed), Reversibility: 0 (fully reversible)

## Mission

Add support for clickable links in ntfy push notifications. When a user receives a notification that a task is ready for review, has been merged, or has failed, they should be able to tap the notification to open the corresponding task in the kb dashboard.

This requires:
1. A new `dashboardUrl` global setting for users to configure their dashboard URL
2. Modifying the ntfy notifier to include a `Click` header with the task-specific URL when dashboardUrl is configured

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Study `GlobalSettings` interface and `DEFAULT_GLOBAL_SETTINGS` to understand how to add the new setting
- `packages/engine/src/notifier.ts` — Understand current ntfy notification implementation and the `sendNotification` method
- `packages/engine/src/notifier.test.ts` — Review existing test patterns for notifications
- `packages/dashboard/app/components/SettingsModal.tsx` — Look at the notifications section to understand UI patterns for global settings (lines 1-100 for structure, around line 800+ for notifications section)

## File Scope

- `packages/core/src/types.ts` — Add `dashboardUrl` to `GlobalSettings` interface and `DEFAULT_GLOBAL_SETTINGS`
- `packages/core/src/settings-export.ts` — Add `dashboardUrl` to `GLOBAL_SETTINGS_KEYS` if it exists, or verify it's included in global settings export/import
- `packages/engine/src/notifier.ts` — Modify `NtfyNotifier` to construct and include task URLs in notifications
- `packages/engine/src/notifier.test.ts` — Add tests for URL generation and Click header
- `packages/dashboard/app/components/SettingsModal.tsx` — Add dashboard URL input field in the notifications section
- `packages/dashboard/app/api.ts` — Verify no changes needed (uses generic settings API)

## Steps

### Step 1: Add dashboardUrl Setting to Core Types

- [ ] Add `dashboardUrl?: string` to `GlobalSettings` interface in `packages/core/src/types.ts`
- [ ] Add `dashboardUrl: undefined` to `DEFAULT_GLOBAL_SETTINGS`
- [ ] If `GLOBAL_SETTINGS_KEYS` exists in this file, add `"dashboardUrl"` to it
- [ ] Run type check: `pnpm build`

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Update NtfyNotifier with Clickable Links

- [ ] Modify `NtfyNotifier` constructor to accept an optional `dashboardUrl` parameter (or read from settings)
- [ ] Create helper method `buildTaskUrl(taskId: string): string | undefined` that constructs `{dashboardUrl}/task/{taskId}` when dashboardUrl is set
- [ ] Modify `sendNotification` to accept optional `clickUrl` parameter
- [ ] Add `Click` header to fetch request when `clickUrl` is provided (ntfy.sh uses the "Click" header for notification tap actions)
- [ ] Update `handleTaskMoved`, `handleTaskUpdated`, `handleTaskMerged` to pass task URLs to `sendNotification`:
  - `in-review` notification: link to the task detail page
  - `merged` notification: link to the task detail page  
  - `failed` notification: link to the task detail page
- [ ] Handle edge cases: trailing slashes in dashboardUrl, invalid URLs

**Artifacts:**
- `packages/engine/src/notifier.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: "includes Click header with task URL when dashboardUrl is configured"
- [ ] Add test: "does not include Click header when dashboardUrl is not configured" 
- [ ] Add test: "handles dashboardUrl with trailing slash correctly"
- [ ] Add test: "handles dashboardUrl without trailing slash correctly"
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/engine/src/notifier.test.ts` (modified)

### Step 4: Dashboard Settings UI

- [ ] Add dashboard URL input field in the notifications section of SettingsModal
- [ ] Field should show scope indicator (🌐 global) like other global settings
- [ ] Add placeholder text: "https://your-dashboard.example.com"
- [ ] Add help text explaining the purpose: "When set, notifications will include a link to open tasks directly in the dashboard"
- [ ] Validate URL format (must start with http:// or https://) — or rely on browser validation via `type="url"` input
- [ ] Ensure field is disabled when ntfyEnabled is false (consistent with other notification settings)

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 5: Documentation & Delivery

- [ ] Update AGENTS.md ntfy section (around the ntfy settings documentation) to mention the new `dashboardUrl` setting
- [ ] Create changeset file for the change:
```bash
cat > .changeset/ntfy-clickable-links.md << 'EOF'
---
"@gsxdsm/fusion": patch
---

Add dashboardUrl setting for clickable ntfy notifications. When configured, ntfy push notifications now include a link that opens the task directly in the kb dashboard.
EOF
```
- [ ] Run full test suite one final time
- [ ] Check for any out-of-scope findings (e.g., missing documentation, unrelated bugs) and create follow-up tasks via `task_create` if needed

**Artifacts:**
- `.changeset/ntfy-clickable-links.md` (new)
- `AGENTS.md` (modified)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add `dashboardUrl` to the ntfy settings documentation section (near `ntfyEnabled` and `ntfyTopic`)

**Check If Affected:**
- `packages/dashboard/app/api.ts` — Should not need changes (uses generic settings endpoints)
- `packages/cli/src/commands/settings.ts` — Verify no CLI changes needed for this global setting

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Documentation updated (AGENTS.md + changeset)
- [ ] Settings UI shows dashboard URL field in notifications section

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-663): complete Step N — description`
- **Bug fixes:** `fix(FN-663): description`
- **Tests:** `test(FN-663): description`

Example commits:
- `feat(FN-663): complete Step 1 — add dashboardUrl to GlobalSettings`
- `feat(FN-663): complete Step 2 — add Click header to ntfy notifications`
- `test(FN-663): add tests for notification URL generation`
- `feat(FN-663): complete Step 4 — add dashboard URL field to settings UI`

## Do NOT

- Expand scope to include other notification providers
- Change the ntfy base URL configuration (separate concern)
- Add URL shortening or other complex URL handling
- Modify the notification message format (keep text-only body, use Click header for the link)
- Skip validation in the UI (URL format should be validated)
- Skip tests for edge cases (trailing slashes, missing URL, etc.)

## Implementation Notes

### ntfy.sh Click Header

According to ntfy documentation, the `Click` header sets the URL to open when the user taps the notification:

```javascript
fetch("https://ntfy.sh/mytopic", {
  method: "POST",
  headers: {
    "Title": "Task completed",
    "Click": "https://dashboard.example.com/task/FN-001", // This makes it clickable
  },
  body: "Task FN-001 is ready for review",
});
```

### URL Construction

The dashboard task URL format should be: `{dashboardUrl}/task/{taskId}`

Handle both cases:
- `dashboardUrl = "https://kb.example.com"` → `https://kb.example.com/task/FN-001`
- `dashboardUrl = "https://kb.example.com/"` → `https://kb.example.com/task/FN-001` (strip trailing slash)

### Settings Flow

The settings flow works like this:
1. User opens Settings modal, clicks Notifications section
2. UI shows global settings (🌐 indicator)  
3. User enters dashboard URL, clicks Save
4. `updateGlobalSettings()` API call saves to `~/.pi/kb/settings.json`
5. NtfyNotifier receives `settings:updated` event and reloads config
6. Next notification includes the Click header with task URL
