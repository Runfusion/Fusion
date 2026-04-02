# Task: KB-026 - Add ntfy.sh notifications for task completion and failures

**Created:** 2026-03-30
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This is a feature addition with moderate blast radius (touches core types, dashboard UI, and engine). Pattern is straightforward (settings → listeners → HTTP call). No security concerns (user-configurable external service). Reversible (settings can be cleared, notifications can be disabled).
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Add support for ntfy.sh push notifications that alert users when tasks complete (move to "in-review" or "done") or fail. Users configure their ntfy topic via the dashboard settings. The feature includes sensible defaults and pre-fills the notification topic in task templates when configured.

ntfy is a free, simple HTTP-based pub-sub notification service. Users self-host or use ntfy.sh public server. Notifications require only a topic name (no auth for public topics).

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Settings type definition, DEFAULT_SETTINGS
- `packages/core/src/store.ts` — TaskStore events (task:moved, task:updated), generateSpecifiedPrompt method
- `packages/dashboard/app/components/SettingsModal.tsx` — Settings UI structure, SETTINGS_SECTIONS, form handling
- `packages/dashboard/app/api.ts` — API client functions (fetchSettings, updateSettings)
- `packages/dashboard/src/routes.ts` — Settings API routes (/settings GET/PUT)
- `packages/engine/src/executor.ts` — TaskExecutor (onComplete, onError callbacks)
- `packages/engine/src/index.ts` — Engine composition where services are wired together

## File Scope

- `packages/core/src/types.ts` — Add ntfy settings fields to Settings interface and DEFAULT_SETTINGS
- `packages/core/src/store.ts` — Modify generateSpecifiedPrompt to include ntfy topic placeholder
- `packages/dashboard/app/components/SettingsModal.tsx` — Add "Notifications" section with ntfy configuration
- `packages/dashboard/app/api.ts` — No changes needed (uses existing Settings type)
- `packages/dashboard/src/routes.ts` — No changes needed (generic settings CRUD handles new fields)
- `packages/engine/src/notifier.ts` — New file: NtfyNotifier service
- `packages/engine/src/index.ts` — Wire up NtfyNotifier to TaskStore events

## Steps

### Step 1: Core Types — Add ntfy Settings

- [ ] Add `ntfyTopic?: string` and `ntfyEnabled?: boolean` to Settings interface in `packages/core/src/types.ts`
- [ ] Add defaults to DEFAULT_SETTINGS: `ntfyEnabled: false`, `ntfyTopic: undefined`
- [ ] Run `pnpm typecheck` in packages/core to verify no type errors

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Dashboard Settings UI — Notifications Section

- [ ] Add `{ id: "notifications", label: "Notifications" }` to SETTINGS_SECTIONS in SettingsModal.tsx
- [ ] Add "notifications" case to renderSectionFields() with:
  - Enable/disable checkbox for ntfyEnabled
  - Text input for ntfyTopic (visible only when enabled)
  - Help text explaining ntfy.sh and how to get a topic
  - Validation: topic must be 1-64 alphanumeric/hyphen/underscore characters when not empty
- [ ] Test the UI renders correctly with different states (enabled/disabled, empty/topic set)

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (new tests)

### Step 3: Engine Notification Service

- [ ] Create `packages/engine/src/notifier.ts` with NtfyNotifier class:
  - Constructor takes TaskStore and optional ntfyBaseUrl (default: https://ntfy.sh)
  - Method `start()` listens to store events
  - Method `stop()` removes listeners
  - Private method `sendNotification(topic: string, title: string, message: string, priority?: 'low'|'default'|'high'|'urgent')` POSTs to ntfy.sh
- [ ] Listen to `task:moved` event:
  - When task moves to "in-review": send notification "Task {id} completed — ready for review"
  - When task moves to "done": send notification "Task {id} merged to main"
- [ ] Listen to `task:updated` event:
  - When task.status becomes "failed": send notification "Task {id} failed" with high priority
- [ ] Add configurable event filtering (only notify for specific columns/status changes)
- [ ] Write unit tests for NtfyNotifier with mocked fetch

**Artifacts:**
- `packages/engine/src/notifier.ts` (new)
- `packages/engine/src/notifier.test.ts` (new)

### Step 4: Wire Up Notifier in Engine

- [ ] Import NtfyNotifier in `packages/engine/src/index.ts`
- [ ] Instantiate NtfyNotifier alongside TaskExecutor in the engine composition
- [ ] Call `notifier.start()` after store is initialized
- [ ] Ensure notifier is stopped gracefully on engine shutdown

**Artifacts:**
- `packages/engine/src/index.ts` (modified)

### Step 5: Template Integration

- [ ] Modify `generateSpecifiedPrompt` in `packages/core/src/store.ts`:
  - Accept settings parameter (or read from this.getSettings())
  - If ntfyEnabled and ntfyTopic are set, append a "## Notifications" section to the generated prompt:
    ```markdown
    ## Notifications

    ntfy topic: `my-topic-name`
    ```
- [ ] Verify the topic appears in newly created task prompts when configured

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all core tests pass
- [ ] Run `pnpm test` in dashboard — all tests pass including new SettingsModal tests
- [ ] Run `pnpm test` in engine — all tests pass including new notifier tests
- [ ] Run `pnpm build` — all packages build without errors
- [ ] Manual verification: Configure ntfy topic in settings, verify it persists after reload
- [ ] Verify the notification service logic with mocked responses

### Step 7: Documentation & Delivery

- [ ] Update `AGENTS.md` — add ntfy configuration to the features list
- [ ] Update README in packages/dashboard if there's a features section
- [ ] Create changeset file: `.changeset/add-ntfy-notifications.md` with patch bump for @dustinbyrne/kb
- [ ] Verify no out-of-scope findings (if any, create follow-up tasks via `task_create`)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add to "Features" or settings documentation:
  ```markdown
  ### Notifications (ntfy.sh)
  Configure push notifications via ntfy.sh in dashboard Settings → Notifications.
  Get notified when tasks complete or fail.
  ```

**Check If Affected:**
- `README.md` — Add brief mention of notification feature if there's a feature list
- `packages/dashboard/README.md` — Document the Notifications settings section

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` in all packages)
- [ ] Build passes (`pnpm build`)
- [ ] Settings UI shows Notifications section with topic input
- [ ] ntfy configuration persists and reloads correctly
- [ ] Task prompts include ntfy topic placeholder when configured
- [ ] Notification service correctly filters events (disabled when ntfyEnabled=false)
- [ ] Documentation updated
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-026): complete Step N — description`
- **Bug fixes:** `fix(KB-026): description`
- **Tests:** `test(KB-026): description`

## Do NOT

- Send actual notifications during tests (mock fetch)
- Require authentication for ntfy (keep it simple, public topics only)
- Add notification history/persistence (out of scope)
- Support notification channels other than ntfy (out of scope)
- Modify the extension.ts CLI tools (notifications are dashboard/engine only)
- Create UI for testing notifications (users can use ntfy.sh web UI to verify)
