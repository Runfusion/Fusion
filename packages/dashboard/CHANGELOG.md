# @fusion/dashboard

## 0.33.0

### Minor Changes

- 6e7f1e5: feat(dashboard): explain "Recent integration-branch advances" and add a one-click "Sync working tree" fix

  Two additions to Git Manager → Status:

  **Info disclosure** — an `[i]` button next to the "Recent integration-branch advances (N need action)" header toggles an inline explainer. Covers what an "advance" is, what each `autoSyncOutcome` value means (`clean-sync`, `synced-with-edits-restored`, `off / not run`, `stash-failed`, `would-conflict`, …), and where to enable `mergeAdvanceAutoSync` for the permanent fix.

  **Sync working tree button** — when ≥1 advance shows `needsAction`, a button surfaces in the same header that calls the existing `POST /api/git/pull` (FN-5358 Smart Pull machinery: auto-stash dirty edits, fast-forward pull, restore stash, surface conflicts). On success the extended git status auto-refetches and the "need action" count drops; on conflict, the existing error toast fires.

  No new state machine — `handlePull`/`remoteLoading === "pull"` is the same plumbing the existing Pull button uses.

- 85786e7: feat(dashboard): show extended integration-branch + working-tree state in Git Manager

  Repository Status panel now answers "what is the actual state of my project root vs the integration branch?" so operators can be sure of the picture even when the Merge Advance Notice banner has been dismissed.

  `GET /api/git/status` accepts a new `?extended=1` query and returns additional optional fields:

  - **integrationBranch** + **integrationBranchSource** — the canonical branch (resolved via `settings.integrationBranch` → legacy `baseBranch` → `origin/HEAD` → `main`) and where the value came from.
  - **integrationTipSha / originIntegrationTipSha** — SHAs at both ends, so operators can spot when local main has been advanced by the merger but origin/main hasn't caught up.
  - **aheadOfIntegration / behindIntegration** — HEAD vs local integration tip (useful when on a non-integration branch).
  - **aheadOfOriginIntegration / behindOriginIntegration** — local integration tip vs `origin/<branch>`.
  - **dirtyDetails** — staged/modified/untracked/conflicted counts + a 12-line porcelain sample.
  - **indexStaleVsHead** — true when the index reflects a previous tip and the worktree is clean against the index but not against HEAD. Surfaces the exact "phantom staged changes" scenario that `mergeAdvanceAutoSync` exists to fix.
  - **stashCount** — for at-a-glance recovery awareness.
  - **recentMergeAdvances** — up to 5 recent `merge:integration-ref-advance` audit events for the project root, joined with their `merge:auto-sync` outcomes; entries whose auto-sync didn't successfully bring this worktree forward are flagged `needsAction: true`.

  `GitManagerModal` now renders all of this:

  - The existing Branch / Commit / Working Tree / Remote Sync cards gain sub-text — Working Tree shows staged/modified/untracked/conflicted breakdown; Branch shows whether you're on the integration branch.
  - A second row of cards adds Integration branch (with resolution source + tip SHA), HEAD-vs-integration ahead/behind, local-integration-vs-origin ahead/behind, and stash count.
  - A yellow warning panel appears when `indexStaleVsHead` is true, telling the operator to enable `mergeAdvanceAutoSync` or run `git reset --hard HEAD`.
  - A "Recent integration-branch advances" list shows the last few merger advances with their per-advance auto-sync outcome, color-coded by whether they still need action.

  All `fetchGitStatus(projectId)` calls inside `GitManagerModal` now pass `{ extended: true }`. Other callers in the app are unaffected — the extra fields are optional and the un-extended response shape is unchanged.

### Patch Changes

- 60a0012: fix(dashboard): stop main-chat and quick-chat composers from instantly dismissing the Android soft keyboard

  Two layered Android-specific fixes for the chat composers:

  1. The body scroll-lock applied while the keyboard is open in main chat was an iOS-specific workaround for visualViewport drift. On Android Chrome it does the opposite of what we want — mutating `body { position: fixed; ... }` while the keyboard is opening causes Chrome to treat it as a focus-target relayout and immediately dismisses the keyboard. `useMobileScrollLock` is now gated to iOS UAs.

  2. ChatView and QuickChatFAB both had an iOS-specific `onTouchStart` on the textarea that called `event.preventDefault()` and then programmatically refocused the input (to suppress iOS's visualViewport auto-scroll on re-focus). On Android, `preventDefault` on a textarea touchstart prevents the soft keyboard from opening — programmatic `focus()` alone does not raise the Android keyboard. Result: tapping the composer focused the input but the keyboard never appeared, looking like an instant dismiss. The touchstart workaround is now gated to iOS UAs via `isIOS()`.

- a10fc56: fix(dashboard): keep Android keyboard open in main chat; disable kanban pinch-zoom

  Two Android-specific fixes:

  1. **Keyboard dismissing in main chat.** `mobileKeyboardOpen` in `App.tsx` (derived from `useMobileKeyboard`) gates `project-content--with-mobile-nav` / `--with-footer` className assignment and MobileNavBar rendering. When the soft keyboard opened, those classes were removed and the nav unmounted, shrinking padding-bottom by ~80px in a single render. Android Chrome treats the resulting jump of the focused chat input as the focus target moving and instantly dismisses the keyboard. With `interactive-widget=resizes-content` set on Android, the layout viewport itself shrinks with the keyboard, so the hide-nav-on-keyboard behavior was redundant on Android (and harmful). The whole pattern is now gated to iOS via `isIOS()`. iOS path is unchanged.

  2. **Pinch-zoom on kanban.** Android Chrome ignores `user-scalable=no` for accessibility, and the kanban board's `overflow-x: auto` columns combined with the inflated ICB produce a broken visual when the user zooms out. Adds `touch-action: pan-x pan-y` to `html, body` inside the mobile media query, which keeps scroll panning but disables pinch-zoom (Chat and MissionManager were unaffected because they don't expose a wide horizontal scrollable region).

- de67c51: fix(dashboard): pull syncs the worktree to local integration tip, not just to origin

  The integration-mode `POST /api/git/pull` (used by the merge-advance-notice banner) only ran `git merge --ff-only origin/<branch>` after fetching. When the merger had advanced local `refs/heads/<integrationBranch>` via `update-ref` but the user hadn't pushed yet, the worktree's HEAD already resolved to the new sha (symbolic ref follow) but the working tree and index were still at the old state. The fast-forward step short-circuited (`already up to date with origin`) and the user saw "Pull completed" with `fromSha === toSha` while their files visibly stayed behind.

  Pull now explicitly resets the worktree to `refs/heads/<integrationBranch>` after the origin fast-forward step. The autostash above protects user edits, so the reset is safe regardless of whether the origin FF ran.

- 5d35b64: fix(dashboard): remove duplicate integration-advances UI; Sync working tree is now pure-local (no origin fetch)

  **Removed duplicate UI** — Git Manager → Status had two overlapping sections rendering the same data: a `Sync local tip` button + a `Recent integration advances` list, sitting above the highlighted `Recent integration-branch advances` block (the one with the lost-work warnings). Deleted the duplicate (`gm-integration-actions` + `gm-recent-advances`) along with the dead `mergeAdvanceEvents` state, fetcher, and SSE subscription that only fed it.

  **Sync working tree is now pure-local** — for the "N need action" case the merger has already advanced `refs/heads/<integration>` locally and the worktree just needs to follow. Previously the button called the integration-mode pull which ran `tryFastForwardFromOrigin` first, silently pulling in unrelated remote commits. New `skipOriginFetch` option on `PullGitBranchOptions.integration` (and the matching `POST /api/git/pull` body field) skips the origin step entirely. The Sync button passes `skipOriginFetch: true`, so the sequence is: auto-stash → `git reset --hard refs/heads/<integration>` → restore stash. Origin is not touched.

  Help disclosure updated to match the new behavior.

- 4f38ed1: fix(dashboard): clear `needs action` on recent integration-branch advances after manual sync

  The Git Manager's "Recent integration-branch advances" list derived `needsAction` purely from the original `merge:auto-sync` audit-event outcome. When the operator clicked "Sync working tree" — or fixed up the worktree by hand — the worktree caught up to the integration tip, but the list kept showing "(N need action)" because the historical audit events still recorded the original failure/disabled state.

  `collectRecentMergeAdvances` now also checks whether each advance's `toSha` is reachable from the current HEAD. If it is, the worktree already contains that advance and `needsAction` is false regardless of what the audit trail recorded.

- ef12df4: fix(dashboard): close 8 review findings on extended Git Manager status + Integration branch setting

  **Settings persistence (data-loss)** — the project-settings patch builder now applies null-as-delete to all non-model keys, matching the global-settings branch. Previously, clearing the Integration branch field (picking `(auto-detect)` or clicking `Use dropdown`) set `integrationBranch: undefined`, which `JSON.stringify` silently dropped — the server retained the stale explicit value and the operator could not un-pin the branch from the UI.

  **`isIndexStale` was wrong both directions** — the heuristic (`diff --cached --name-only` non-empty AND `diff --name-only` empty) fired false-positive on benign `git add` and false-negative whenever the worktree had any unrelated edit. Replaced with a reflog-anchored check: stale iff `refs/heads/<integrationBranch>@{1}` exists, HEAD is a descendant of it, and `git diff-index --cached <prevTip>` is empty (i.e. the index exactly matches the pre-advance state).

  **Auto-sync attribution** — two fixes to `collectRecentMergeAdvances` in `register-git-github.ts`:

  - Auto-sync events are now matched by `(taskId, newSha)` instead of `taskId`-only. A task that produced multiple advances over time no longer has all its older entries mislabeled with the most-recent outcome.
  - `worktreePath` comparison now runs both sides through `fs.realpathSync` first. On macOS the merger emits canonicalized paths (via `canonicalizePath` in `worktree-pool.ts`) while the route was called with the store's raw `rootDir`; symlinked project paths caused every advance to be marked `needsAction: true` indefinitely.

  **Extended path no longer 500s on git failure** — the `?extended=1` branch wraps `computeExtendedGitStatus` in its own try/catch and falls back to the basic status shape on any unhandled failure. Previously an unguarded `git branch --show-current` throw escaped to the route's outer catch and returned HTTP 500, while the basic path returned 200 with the swallowed-failure shape — surface parity matters because the dashboard always passes `extended=1` and would otherwise render an error toast where it should render the degraded panel. Also wrapped the same call inside `computeExtendedGitStatus` so detached-HEAD / non-git states return an empty `currentBranch` instead of throwing.

  **Integration branch falls back to `refs/remotes/origin/<branch>`** — when the configured branch exists only as a remote-tracking ref (e.g. operator set `integrationBranch: "release/v2"` without ever `git switch`-ing it locally), `integrationTipSha` now resolves to the origin tip instead of being null. A new `integrationTipSource: "local" | "remote-only" | "missing"` field tells the UI which side won; the Git Manager surfaces this with a `(remote-only — run git switch <branch> to track locally)` sub-text and a `no ref found` error state when both refs are missing.

  **Copy commit hash shows two buttons** — the Copy button now copies `status.commit` (the short SHA actually displayed in the `<code>` element). A second Copy-full button surfaces `status.headSha` for git operations that need the 40-char SHA. Previously the single button silently copied the full SHA when extended was on, so what the user saw on screen was no longer what they pasted.

  **Detached HEAD no longer shows misleading "(not on main)"** — `git branch --show-current` returns empty on detached HEAD; the route now leaves `isOnIntegrationBranch` as `undefined` (not `false`) in that case, and the UI's "(not on <branch>)" sub-text only renders when we know we're on a different branch — not when we're on no branch at all.

- d5cfa92: fix(dashboard): close 7 review findings on the extended-status hardening pass

  Follow-up to the prior fix commit; closes 7 more issues that an independent code review surfaced.

  **Settings inheritance regression (high)** — `SettingsModal.handleSave`'s non-model project branch lost the "only write if changed" gate when the prior commit added null-as-delete support. Result: every effective/inherited project key was being persisted as an explicit project override on every save, silently breaking inheritance across ~30+ keys. Restored the `value !== initialProjectValue` gate, matched against the model-lane branch's existing pattern.

  **Git Manager `Local <branch> vs origin` card showed misleading "Synced" in remote-only mode** — when `integrationTipSource === "remote-only"`, both `aheadOfOriginIntegration` / `behindOriginIntegration` are deliberately undefined (there's no local branch to compare), but the card's render fell through to `(ahead ?? 0) === 0 && (behind ?? 0) === 0 → "Synced"`. Now renders an explicit "no local tracking" sub-text in that case, with a separate `HEAD vs origin/<branch>` card surfacing a meaningful distance.

  **`isIndexStale` extended to multi-hop and gated to integration-branch worktrees** —

  - Walks up to 16 `refs/heads/<integration>` reflog entries so an A→B→C burst whose middle sync also missed is detected (the prior check only consulted `@{1}`).
  - Only fires when `isOnIntegrationBranch === true`. Previously, a feature-branch worktree whose HEAD happened to descend from `<integration>@{1}` (e.g. `git switch -c hotfix main@{N}`) would trip the stale-index warning despite being perfectly healthy.

  **`enumeration-failed` auto-sync events no longer dropped** — the new `(taskId, newSha)` join filter required both `worktreePath` and `newSha` on every auto-sync event, which discarded the merger's early-failure events that emit neither. Now: events with both fields use the per-advance pair-key (with macOS realpath canonicalization on both sides); events with neither use a task-id fallback so the diagnostic outcome still surfaces on the matching advance.

  **`aheadOfIntegration` no longer silently shifts semantics** — split into three distinct distance fields so consumers don't have to read `integrationTipSource` to know which comparison they got:

  - `aheadOfIntegration` / `behindIntegration` — HEAD vs **local** integration tip; undefined when only the remote tip exists.
  - `aheadOfIntegrationRemote` / `behindIntegrationRemote` — HEAD vs `origin/<integrationBranch>`; defined whenever the remote tracking ref exists.
  - `aheadOfOriginIntegration` / `behindOriginIntegration` — local integration tip vs `origin/<integrationBranch>`; defined only when both refs exist.

  **`currentBranch` failure no longer masks wrong-branch state** — `git branch --show-current` returns empty on detached HEAD (success) and throws on transient git errors (lock contention, timeout). The prior catch collapsed both into `currentBranch = ""` so the UI couldn't distinguish them. New `currentBranchDetectionFailed?: boolean` field on `GitStatus` lets the UI surface "branch detection unavailable" on a real failure rather than silently hiding the wrong-branch warning.

- 916047c: feat(dashboard): Integration branch setting is now a dropdown of local branches with Custom… fallback

  Replaces the plain text input with a `<select>` that lists the project's local branches (loaded via `fetchGitBranches` when the Merge section becomes visible) plus an `(auto-detect — origin/HEAD → main)` default and a `Custom…` option for branches that don't exist locally yet.

  Branch list is deduplicated and sorted with common integration names (`main`, `master`, `trunk`, `develop`) pinned to the top so the typical case is one click. Choosing `Custom…` swaps in a text input with a `Use dropdown` link to revert.

  A previously-saved value that isn't in the loaded list (e.g. branch deleted locally, or initial load before branches fetch resolved) falls through to the custom text input automatically so the operator can still see and edit it.

- 084bdc6: feat(dashboard): expose `integrationBranch` setting in the project settings modal

  Adds a text input for the canonical integration branch (the branch Fusion merges tasks into, and the reference for all ahead/behind / overlap / pre-rebase computations). Lives directly under the Auto-completion mode select inside the merge-strategy panel — visible regardless of direct vs PR mode, since the setting applies to both.

  Blank value (the default) preserves the existing auto-resolution cascade: `integrationBranch` → legacy `baseBranch` → `origin/HEAD` symbolic ref → fallback `main`. Setting it to `master` / `trunk` / `develop` / etc. pins the resolution explicitly without changing other settings.

  Field trims whitespace and stores `undefined` (not empty string) when cleared so the auto-resolution remains active.

- d8493f9: feat(dashboard): expose `mergeAdvanceAutoSync` in the project settings modal

  Adds the missing form control for the auto-sync mode introduced by the merger hook. Lives next to the existing Direct merge commit routing / Integration worktree controls inside the merge-strategy panel and only renders when `mergeStrategy === "direct"`. Three options with the same labels and descriptions as `docs/settings-reference.md`:

  - **Stash + fast-forward (default)** — preserve local edits across the auto-snap
  - **Fast-forward only** — skip dirty worktrees, surface the banner instead
  - **Off** — legacy behavior, project root stays stale until manual pull

  Value is normalized through `normalizeMergeAdvanceAutoSyncMode` on both the merged-settings and scoped-settings load paths so a missing/invalid stored value cleanly falls back to the default without spamming validation errors.

- 99359b6: fix(dashboard): unbreak Merge Advance Notice banner dismiss and suppress when auto-sync already handled it

  Two bugs were keeping the banner stuck on screen even when there was nothing for the user to do:

  - **Dismiss was dead.** The `notice` memo never applied `dismissedShas`, so clicking the close button (or a successful Pull, which calls `dismiss()` after the API returns) updated localStorage but the same advance event kept matching the filter and the banner re-rendered immediately.
  - **Auto-sync success was ignored.** With the new `mergeAdvanceAutoSync` setting at its `stash-and-ff` default, the merger snaps the project-root checkout forward as part of the merge — there is nothing left to pull. The banner kept appearing anyway because the route's `autoSync` payload wasn't consulted. Clicking Pull then hit `/api/git/pull`, which fetched origin (no change, since the merger only advanced the local ref) and returned `pull-clean` with no actual work done.

  The `notice` memo now (a) filters out `dismissedShas`, and (b) suppresses any advance event whose `autoSync` entry for the _current user's_ `worktreePath` reports `clean-sync` or `synced-with-edits-restored`. Conflict and skipped outcomes (`synced-with-pop-conflict`, `skipped-dirty`, `skipped-*`, `failed`) still surface the banner so the user can recover.

  Banner suppression checks the per-worktree path, so a multi-checkout project where auto-sync handled one root and a sibling root is still stale will keep showing the banner on the stale one.

- 6083de2: fix(dashboard): unbreak Merge Advance Notice banner by preserving store `this` binding in events endpoint

  `GET /api/tasks/merge-advance-events` was extracting `getRunAuditEvents` off the scoped store as a bare function reference and calling it without `this`, which made `this.db.prepare(...)` throw "Cannot read properties of undefined (reading 'db')" on every request. The `useMergeAdvanceNotice` hook caught the failure silently (`catch { setEvents([]) }`), so the banner never appeared even after the merger advanced the integration branch ref.

  Fix: keep the store reference and call `storeWithRunAudit.getRunAuditEvents(...)` as a method so `this` is preserved, matching the pattern used by other routes that read run-audit events.

- dc94494: fix(engine,dashboard): close 7 code-review findings on the mergeAdvanceAutoSync hook

  Tightens the freshly-landed merger auto-sync feature based on a structured code review.

  **Data-loss fixes in `syncWorktreeToHead`:**

  - Untracked-file restore now compares against `git ls-tree -r --name-only HEAD` to detect when the new tip introduced a tracked file at the same path; collisions are reported in `untrackedSkippedAsTracked` and the user's bytes stay in the stage dir instead of clobbering the merged content.
  - When `git apply --3way` fails because a patched file was deleted/renamed at the new tip (`--diff-filter=U` returns nothing because nothing got staged), `conflictedFiles` falls back to parsing `diff --git a/<p> b/<p>` headers out of the captured patch — so the conflict surfaces with the right file names instead of `[]`.
  - `git ls-files` / `diff` calls now pass `-c core.quotePath=false` so paths with non-ASCII or special characters round-trip through `copyFileSync` instead of failing on backslash-escaped octal tokens.
  - The stash-and-ff path re-verifies `rev-parse HEAD === newSha` immediately before each destructive `reset --hard HEAD`; a concurrent merger advance now bails with `skipped-head-not-at-new-sha` (with the captured patch preserved on disk) instead of applying the patch against the wrong tree.
  - The stage dir is now tracked with a `preserveStageDir` flag in a `try/finally`: it is rm'd on all clean paths and on `skipped-head-not-at-new-sha` exits, but preserved whenever the user's edits live only in `patchPath` (pop-conflict, untracked-collides-with-tracked, reset failure, outer exception).
  - Patch is written to disk before the apply attempt, not only on failure, so a crash between snapshot and apply doesn't lose the user's edits.

  **Multi-worktree-same-branch fix:**

  - New `getRegisteredWorktreeBranches` helper in `worktree-pool.ts` returns ALL `(branch, worktreePath)` entries rather than collapsing duplicates into a `Map<branch, path>`. Multiple worktrees can legitimately share a branch when the user created secondary checkouts via `git worktree add --force -b`; the merger now syncs every one of them instead of silently skipping all but the last.

  **Contract + surfacing fixes:**

  - JSDoc on `merge:auto-sync` GitMutationType now documents the actually-emitted outcome strings (`clean-sync`, `synced-with-edits-restored`, `synced-with-pop-conflict`, `skipped-*`, `failed`, `enumeration-failed`, `exception`) and the actual `stage` enum, replacing the obsolete `smartPull`-shaped strings.
  - `GET /api/tasks/merge-advance-events` now joins `merge:auto-sync` events within a ±5min window of each advance and returns them in a new `autoSync: AutoSyncOutcome[]` field; `useMergeAdvanceNotice` exposes the same shape so the banner can surface pop-conflicts (including `patchPath` pointing at the user's saved edits) instead of leaving them in a black hole.

  **Hygiene:**

  - Merger's setting read now uses `normalizeMergeAdvanceAutoSyncMode(settings.mergeAdvanceAutoSync)` (the exported normalizer) instead of an inline equality check + `as unknown` cast that bypassed type-checking.

  **New backstop tests** in `merger-auto-sync.slow.test.ts`:

  - Untracked file colliding with a newly-tracked path is NOT overwritten and the merged content survives.
  - `git apply --3way` failure on a file deleted at the new tip populates `conflictedFiles` from the patch header.

  **Route test** asserts `autoSync` outcomes are joined onto the matching advance event within the time window.

- e138289: fix(dashboard): compensate Android Chrome inflated ICB for fixed-position UI

  Android Chrome (multi-window / split-screen / certain WebView configs) can leave the initial containing block (window.innerWidth/Height) stuck larger than the actual rendered canvas — DOM, body, and visualViewport report the true dimensions, but `position: fixed` uses the ICB, pinning fixed-bottom elements off the bottom of the visible viewport. JS-side meta override (both setAttribute and full element replacement) does not force Chrome to recompute the ICB on these builds.

  Instead, publish the ICB→visualViewport delta as CSS variables (`--icb-bottom-offset`, `--icb-right-offset`) on `<html>` and consume them in `MobileNavBar` and `ExecutorStatusBar` so they pin to the visible viewport edge regardless of ICB drift. The math also handles pinch-zoom in (offsets compensate) and pinch-zoom out (offsets clamp at 0). Healthy browsers see 0px and behave unchanged.

- 76429a8: fix(dashboard): keep mobile nav bar pinned to page bottom when keyboard opens

  The mobile nav bar's `bottom` defaults to `var(--icb-bottom-offset)`, which on iOS equals the soft-keyboard height once it opens — floating the bar above the keyboard. The existing `.mobile-nav-bar--keyboard-open` override (which pins `bottom: 0`) was only applied when `!modalManager.anyModalOpen && isIOS()`, so the bar still tracked the keyboard with a modal open. Introduces `mobileNavKeyboardOpen = isMobile && keyboardOpen` as a nav-bar-only flag so the bar stays pinned in all keyboard cases. Content padding and ExecutorStatusBar remain on the gated `mobileKeyboardOpen` to preserve their existing behavior.

- ed4d021: fix(dashboard): keep mobile nav visible on Android in landscape and when keyboard opens

  - Broaden mobile media query to `(max-width: 768px), (max-height: 480px)` so phones held in landscape (which exceed 768 CSS px wide) still render the bottom nav and mobile board layout instead of the desktop horizontally-scrollable columns.
  - Distinguish pinch-zoom from keyboard-open in `useMobileKeyboard` by checking `visualViewport.scale > 1` — Android Chrome ignores `user-scalable=no` for a11y, and a zoomed-in textarea was false-positiving keyboard-open and hiding `MobileNavBar`.
  - Use `documentElement.clientHeight` instead of stale `window.innerHeight` when computing keyboard overlap (Android multi-window can leave `innerHeight` cached at a wildly different value than the actual layout viewport).
  - Add `interactive-widget=resizes-content` to the viewport meta so Android Chrome shrinks the layout viewport with the soft keyboard, matching iOS behavior.

- Updated dependencies [98033bc]
- Updated dependencies [db9928a]
- Updated dependencies [02971ef]
- Updated dependencies [9ce26ee]
- Updated dependencies [e708870]
- Updated dependencies [a3ec2e5]
- Updated dependencies [408e20b]
- Updated dependencies [acf3502]
- Updated dependencies [ec6643e]
- Updated dependencies [a201f56]
- Updated dependencies [4c31e88]
- Updated dependencies [dc94494]
- Updated dependencies [bf4428c]
- Updated dependencies [0c0839e]
- Updated dependencies [ec1269f]
- Updated dependencies [51fc826]
- Updated dependencies [d02cd38]
  - @fusion/engine@0.33.0
  - @fusion/core@0.33.0
  - @fusion-plugin-examples/cli-printing-press@0.1.10
  - @fusion-plugin-examples/dependency-graph@0.1.24
  - @fusion-plugin-examples/roadmap@0.1.12
  - @fusion-plugin-examples/cursor-runtime@0.1.12
  - @fusion-plugin-examples/droid-runtime@0.1.19
  - @fusion-plugin-examples/hermes-runtime@0.2.43
  - @fusion-plugin-examples/openclaw-runtime@0.2.43
  - @fusion-plugin-examples/paperclip-runtime@0.2.43

## 0.32.0

### Patch Changes

- 67aff5d: Fix dashboard occasionally serving a blank/broken page until the server is restarted. The server cached `index.html` and the Vite view-chunk manifest forever with no invalidation, so any on-disk change (release upgrade, rebuild) left the server handing out stale HTML referencing chunk hashes that no longer existed. Both caches now invalidate automatically when the underlying file's mtime changes. The `serveIndexHtml` catch path also now logs the failure and clears the templated cache so a subsequent request can recover, instead of silently returning 404 forever.
- Updated dependencies [1f0bb7e]
  - @fusion/core@0.32.0
  - @fusion/engine@0.32.0
  - @fusion-plugin-examples/cli-printing-press@0.1.9
  - @fusion-plugin-examples/dependency-graph@0.1.23
  - @fusion-plugin-examples/roadmap@0.1.11
  - @fusion-plugin-examples/cursor-runtime@0.1.11
  - @fusion-plugin-examples/droid-runtime@0.1.18
  - @fusion-plugin-examples/hermes-runtime@0.2.42
  - @fusion-plugin-examples/openclaw-runtime@0.2.42
  - @fusion-plugin-examples/paperclip-runtime@0.2.42

## 0.31.0

### Patch Changes

- @fusion/core@0.31.0
- @fusion/engine@0.31.0
- @fusion-plugin-examples/cli-printing-press@0.1.8
- @fusion-plugin-examples/dependency-graph@0.1.22
- @fusion-plugin-examples/roadmap@0.1.10
- @fusion-plugin-examples/cursor-runtime@0.1.10
- @fusion-plugin-examples/droid-runtime@0.1.17
- @fusion-plugin-examples/hermes-runtime@0.2.41
- @fusion-plugin-examples/openclaw-runtime@0.2.41
- @fusion-plugin-examples/paperclip-runtime@0.2.41

## 0.30.0

### Patch Changes

- @fusion/core@0.30.0
- @fusion/engine@0.30.0
- @fusion-plugin-examples/cli-printing-press@0.1.7
- @fusion-plugin-examples/dependency-graph@0.1.21
- @fusion-plugin-examples/roadmap@0.1.9
- @fusion-plugin-examples/cursor-runtime@0.1.9
- @fusion-plugin-examples/droid-runtime@0.1.16
- @fusion-plugin-examples/hermes-runtime@0.2.40
- @fusion-plugin-examples/openclaw-runtime@0.2.40
- @fusion-plugin-examples/paperclip-runtime@0.2.40

## 0.29.0

### Patch Changes

- @fusion/core@0.29.0
- @fusion/engine@0.29.0
- @fusion-plugin-examples/cli-printing-press@0.1.6
- @fusion-plugin-examples/dependency-graph@0.1.20
- @fusion-plugin-examples/roadmap@0.1.8
- @fusion-plugin-examples/cursor-runtime@0.1.8
- @fusion-plugin-examples/droid-runtime@0.1.15
- @fusion-plugin-examples/hermes-runtime@0.2.39
- @fusion-plugin-examples/openclaw-runtime@0.2.39
- @fusion-plugin-examples/paperclip-runtime@0.2.39

## 0.28.1

### Patch Changes

- 681770f: Remove false-positive `committed_reservation_for_existing_id` task-ID-integrity check. The rule flagged every committed reservation that pointed at an existing task, but that's the happy-path steady state — a reservation transitions to `committed` immediately after the task row is inserted, so it's always expected to map to an existing ID. The banner was firing on every healthy node with task history.
- Updated dependencies [681770f]
  - @fusion/core@0.28.1
  - @fusion/engine@0.28.1
  - @fusion-plugin-examples/cli-printing-press@0.1.5
  - @fusion-plugin-examples/dependency-graph@0.1.19
  - @fusion-plugin-examples/roadmap@0.1.7
  - @fusion-plugin-examples/cursor-runtime@0.1.7
  - @fusion-plugin-examples/droid-runtime@0.1.14
  - @fusion-plugin-examples/hermes-runtime@0.2.38
  - @fusion-plugin-examples/openclaw-runtime@0.2.38
  - @fusion-plugin-examples/paperclip-runtime@0.2.38

## 0.28.0

### Patch Changes

- @fusion/core@0.28.0
- @fusion/engine@0.28.0
- @fusion-plugin-examples/cli-printing-press@0.1.4
- @fusion-plugin-examples/dependency-graph@0.1.18
- @fusion-plugin-examples/roadmap@0.1.6
- @fusion-plugin-examples/cursor-runtime@0.1.6
- @fusion-plugin-examples/droid-runtime@0.1.13
- @fusion-plugin-examples/hermes-runtime@0.2.37
- @fusion-plugin-examples/openclaw-runtime@0.2.37
- @fusion-plugin-examples/paperclip-runtime@0.2.37

## 0.27.1

### Patch Changes

- @fusion/core@0.27.1
- @fusion/engine@0.27.1
- @fusion-plugin-examples/cli-printing-press@0.1.3
- @fusion-plugin-examples/dependency-graph@0.1.17
- @fusion-plugin-examples/roadmap@0.1.5
- @fusion-plugin-examples/cursor-runtime@0.1.5
- @fusion-plugin-examples/droid-runtime@0.1.12
- @fusion-plugin-examples/hermes-runtime@0.2.36
- @fusion-plugin-examples/openclaw-runtime@0.2.36
- @fusion-plugin-examples/paperclip-runtime@0.2.36

## 0.27.0

### Patch Changes

- @fusion/core@0.27.0
- @fusion/engine@0.27.0
- @fusion-plugin-examples/cli-printing-press@0.1.2
- @fusion-plugin-examples/dependency-graph@0.1.16
- @fusion-plugin-examples/roadmap@0.1.4
- @fusion-plugin-examples/cursor-runtime@0.1.4
- @fusion-plugin-examples/droid-runtime@0.1.11
- @fusion-plugin-examples/hermes-runtime@0.2.35
- @fusion-plugin-examples/openclaw-runtime@0.2.35
- @fusion-plugin-examples/paperclip-runtime@0.2.35

## 0.26.0

### Patch Changes

- @fusion/core@0.26.0
- @fusion/engine@0.26.0
- @fusion-plugin-examples/dependency-graph@0.1.15
- @fusion-plugin-examples/roadmap@0.1.3
- @fusion-plugin-examples/cursor-runtime@0.1.3
- @fusion-plugin-examples/droid-runtime@0.1.10
- @fusion-plugin-examples/hermes-runtime@0.2.34
- @fusion-plugin-examples/openclaw-runtime@0.2.34
- @fusion-plugin-examples/paperclip-runtime@0.2.34

## 0.25.0

### Patch Changes

- @fusion/core@0.25.0
- @fusion/engine@0.25.0
- @fusion-plugin-examples/dependency-graph@0.1.14
- @fusion-plugin-examples/roadmap@0.1.2
- @fusion-plugin-examples/cursor-runtime@0.1.2
- @fusion-plugin-examples/droid-runtime@0.1.9
- @fusion-plugin-examples/hermes-runtime@0.2.33
- @fusion-plugin-examples/openclaw-runtime@0.2.33
- @fusion-plugin-examples/paperclip-runtime@0.2.33

## 0.24.0

### Patch Changes

- @fusion/core@0.24.0
- @fusion/engine@0.24.0
- @fusion-plugin-examples/dependency-graph@0.1.13
- @fusion-plugin-examples/roadmap@0.1.1
- @fusion-plugin-examples/cursor-runtime@0.1.1
- @fusion-plugin-examples/droid-runtime@0.1.8
- @fusion-plugin-examples/hermes-runtime@0.2.32
- @fusion-plugin-examples/openclaw-runtime@0.2.32
- @fusion-plugin-examples/paperclip-runtime@0.2.32

## 0.23.0

### Patch Changes

- @fusion/core@0.23.0
- @fusion/engine@0.23.0
- @fusion-plugin-examples/dependency-graph@0.1.12
- @fusion-plugin-examples/droid-runtime@0.1.7
- @fusion-plugin-examples/hermes-runtime@0.2.31
- @fusion-plugin-examples/openclaw-runtime@0.2.31
- @fusion-plugin-examples/paperclip-runtime@0.2.31

## 0.22.0

### Minor Changes

- e658e8e: Decouple permanent agent heartbeats from task state, and add per-agent `allowParallelExecution` setting.

  Heartbeats now run for permanent agents regardless of bound-task block state — the prior early-exit on `queued + blockedBy` is removed along with its dead state-tracking machinery. `HEARTBEAT_SYSTEM_PROMPT` is rewritten to scope heartbeats to ambient coordination (messaging, memory, finding work, delegation, surfacing/chasing blockers, status); task body work continues to run via the executor path. Ephemeral agents are unchanged — they don't run heartbeats and their blocked-task gating in the scheduler is untouched.

  New `allowParallelExecution` flag (default `true`, permanent agents only) on `AgentHeartbeatConfig`. When `false`, the heartbeat and task executor paths serialize symmetrically: a heartbeat will not start while the agent's bound task has an active executor session, and an executor session will not start while the agent has an active heartbeat run. Either side re-dispatches the other's deferred work on completion via `resumeTaskForAgent` and the in-process runtime's `onRunCompleted` hook.

  UI toggle surfaces in the agent's Heartbeat Settings tab alongside `runMissedHeartbeatOnStartup`.

- bb32765: Add a "Tools: On/Off" toggle next to the existing "Markdown/Plain" toggle in the agent log viewer (used by both agent logs and task agent logs). When tool output is off, entries of type `tool` / `tool_result` / `tool_error` are hidden — only agent text and thinking are shown. Both toggles now persist globally across sessions via `localStorage` (`fn-agent-log-markdown`, `fn-agent-log-tool-output`).

### Patch Changes

- 9d13295: Move the agent Import button to the global agents header, next to "New Agent", and remove it from individual agent detail pages and the controls panel.
- 11e5f69: Show provider icons in chat: small icon next to the model name in the sidebar session list, and replace the generic robot icon in the chat thread header and assistant message avatars with the active provider icon.
- 24017b8: Drop residual `terminated` AgentState references that the merger autostash dropped during FN-3530 cleanup: `[data-state="terminated"]` selectors in `AgentListModal.css`, `--terminated` CSS-class assertions in `agent-css-classes.test.ts`, and a `state: "terminated"` test fixture in `routes-agents.test.ts` (now `paused`, which is correctly rejected as paused→paused is not a valid transition).
- Updated dependencies [e658e8e]
- Updated dependencies [aecc050]
- Updated dependencies [6ee3225]
- Updated dependencies [81bf882]
  - @fusion/core@0.22.0
  - @fusion/engine@0.22.0
  - @fusion-plugin-examples/dependency-graph@0.1.11
  - @fusion-plugin-examples/droid-runtime@0.1.6
  - @fusion-plugin-examples/hermes-runtime@0.2.30
  - @fusion-plugin-examples/openclaw-runtime@0.2.30
  - @fusion-plugin-examples/paperclip-runtime@0.2.30

## 0.21.0

### Patch Changes

- e6fd593: Differentiate the CLI banner between missing-install and version-mismatch states: when the installed `fn`/`fusion` CLI is out of date, show "Update the Fusion CLI" with current vs target versions and an "Update with npm" button instead of the generic install copy.
- dc8863d: Add `blocked` to `FeatureStatus` so blocked features render with mission-blocked colors in the mission manager.
  - @fusion/core@0.21.0
  - @fusion/engine@0.21.0
  - @fusion-plugin-examples/dependency-graph@0.1.10
  - @fusion-plugin-examples/droid-runtime@0.1.5
  - @fusion-plugin-examples/hermes-runtime@0.2.29
  - @fusion-plugin-examples/openclaw-runtime@0.2.29
  - @fusion-plugin-examples/paperclip-runtime@0.2.29

## 0.20.0

### Patch Changes

- ba6666f: Fix Planning Mode modal getting stuck at partial height on mobile. Two issues: (1) `useModalResizePersist` was replaying a desktop-saved pixel height into the inline `style` attribute, overriding the mobile `height: 100dvh` rule and leaving the modal at half-screen even before the keyboard appeared — now skipped on touch devices ≤768px wide. (2) When the iOS keyboard was dismissed, React reconciled the removed CSS custom properties (`--vv-height`, `--keyboard-overlap`, `--vv-offset-top`) by setting them to empty string instead of calling `removeProperty()`. On Safari that left `var(--vv-height, 100dvh)` resolving to empty (the fallback only kicks in when the variable is undefined), collapsing the modal to content height — now driven imperatively via `setProperty`/`removeProperty` on the modal ref.
  - @fusion/core@0.20.0
  - @fusion/engine@0.20.0
  - @fusion-plugin-examples/dependency-graph@0.1.9
  - @fusion-plugin-examples/droid-runtime@0.1.4
  - @fusion-plugin-examples/hermes-runtime@0.2.28
  - @fusion-plugin-examples/openclaw-runtime@0.2.28
  - @fusion-plugin-examples/paperclip-runtime@0.2.28

## 0.19.0

### Patch Changes

- 082c62a: Fix a cross-agent overwrite bug in the Agents split view. The Config tab's form state was initialized once at mount and never resynced on `agent` change, while the master-detail layout reused the same `<AgentDetailView>` / `<ConfigTab>` instance across selections (no `key`). Switching agents while sitting on the Config tab made `hasChanges` evaluate true (stale form values vs. the newly loaded agent), and the 700ms autosave then wrote the previously-viewed agent's name/role/title/icon/model/skills onto the newly-selected agent's row. Adds `key={selectedAgentId}` to `<AgentDetailView>` and `key={agent.id}` to `<ConfigTab>` so both remount with fresh state on every agent transition.
- Updated dependencies [54f2832]
  - @fusion/engine@0.19.0
  - @fusion/core@0.19.0
  - @fusion-plugin-examples/dependency-graph@0.1.8
  - @fusion-plugin-examples/droid-runtime@0.1.3
  - @fusion-plugin-examples/hermes-runtime@0.2.27
  - @fusion-plugin-examples/openclaw-runtime@0.2.27
  - @fusion-plugin-examples/paperclip-runtime@0.2.27

## 0.18.1

### Patch Changes

- @fusion/core@0.18.1
- @fusion/engine@0.18.1
- @fusion-plugin-examples/dependency-graph@0.1.7
- @fusion-plugin-examples/droid-runtime@0.1.2
- @fusion-plugin-examples/hermes-runtime@0.2.26
- @fusion-plugin-examples/openclaw-runtime@0.2.26
- @fusion-plugin-examples/paperclip-runtime@0.2.26

## 0.18.0

### Patch Changes

- @fusion/core@0.18.0
- @fusion/engine@0.18.0
- @fusion-plugin-examples/dependency-graph@0.1.6
- @fusion-plugin-examples/droid-runtime@0.1.1
- @fusion-plugin-examples/hermes-runtime@0.2.25
- @fusion-plugin-examples/openclaw-runtime@0.2.25
- @fusion-plugin-examples/paperclip-runtime@0.2.25

## 0.17.2

### Patch Changes

- Updated dependencies [17a6634]
  - @fusion/engine@0.17.2
  - @fusion/core@0.17.2
  - @fusion-plugin-examples/dependency-graph@0.1.5
  - @fusion-plugin-examples/hermes-runtime@0.2.24
  - @fusion-plugin-examples/openclaw-runtime@0.2.24
  - @fusion-plugin-examples/paperclip-runtime@0.2.24

## 0.17.1

### Patch Changes

- 08aa64e: Fix mobile keyboard regressions in the dashboard.

  - **Dashboard pushed up after closing a modal on mobile.** Adds a shared `useMobileScrollLock` hook that pins `body` with `position: fixed; top: -scrollY; width: 100%` while a fullscreen mobile overlay is open and restores scroll on cleanup — the same pattern Bootstrap, Headless UI, and Stripe Elements use to prevent iOS Safari from scrolling the document (and shifting `visualViewport.offsetTop`) when an input inside a `position: fixed` overlay is focused. Reference-counted so nested overlays don't release each other's locks. Wired into TodoModal, PlanningModeModal, TaskDetailModal, NewTaskModal, SettingsModal, MailboxModal, AddNodeModal, MissionInterviewModal, MilestoneSliceInterviewModal, SubtaskBreakdownModal, GitHubImportModal, AgentGenerationModal, AgentImportModal, ScriptsModal, ResearchTaskActionModal, and ChatView (replacing its inline body-overflow effect).
  - **Auto-reload prompt missed rebuilds.** Widens `computeBuildVersion` in `vite.config.ts` to hash the entire `app/` source tree (FN-3333 follow-up). The previous version only hashed `app/main.tsx` and `package.json`, so edits to any other component or stylesheet produced an identical build version and the version-check poll never noticed the rebuild.
  - **ChatView composer crawled down with iOS's keyboard-dismiss animation.** `useMobileKeyboard` now requires a focused input for `keyboardOpen=true`. The moment any input blurs, `keyboardOpen` flips to `false` instead of waiting for iOS's slow visualViewport animation to settle (hundreds of ms). This propagates to App-level `mobileKeyboardOpen` so the MobileNavBar reappears and `project-content` regains its nav-bar padding immediately — chat-thread, modals, and any other consumer all snap to their post-keyboard layout in one frame.

- Updated dependencies [c2f6dd3]
  - @fusion/engine@0.17.1
  - @fusion/core@0.17.1
  - @fusion-plugin-examples/dependency-graph@0.1.4
  - @fusion-plugin-examples/hermes-runtime@0.2.23
  - @fusion-plugin-examples/openclaw-runtime@0.2.23
  - @fusion-plugin-examples/paperclip-runtime@0.2.23

## 0.17.0

### Patch Changes

- @fusion/core@0.17.0
- @fusion/engine@0.17.0
- @fusion-plugin-examples/dependency-graph@0.1.3
- @fusion-plugin-examples/hermes-runtime@0.2.22
- @fusion-plugin-examples/openclaw-runtime@0.2.22
- @fusion-plugin-examples/paperclip-runtime@0.2.22

## 0.16.0

### Patch Changes

- c769444: Fix `git diff --no-index` calls treating exit code 1 as an error in the dashboard git-routes. `--no-index` exits 1 when files differ — that's the success case for synthetic untracked-file diffs. Switched to `spawn` so we accept exit 0 and 1 with stdout, independent of how callers wrap `execFile`/`promisify`.
  - @fusion/core@0.16.0
  - @fusion/engine@0.16.0
  - @fusion-plugin-examples/dependency-graph@0.1.2
  - @fusion-plugin-examples/hermes-runtime@0.2.21
  - @fusion-plugin-examples/openclaw-runtime@0.2.21
  - @fusion-plugin-examples/paperclip-runtime@0.2.21

## 0.15.0

### Patch Changes

- @fusion/core@0.15.0
- @fusion/engine@0.15.0
- @fusion-plugin-examples/dependency-graph@0.1.1
- @fusion-plugin-examples/hermes-runtime@0.2.20
- @fusion-plugin-examples/openclaw-runtime@0.2.20
- @fusion-plugin-examples/paperclip-runtime@0.2.20

## 0.14.3

### Patch Changes

- @fusion/core@0.14.3
- @fusion/engine@0.14.3
- @fusion-plugin-examples/hermes-runtime@0.2.19
- @fusion-plugin-examples/openclaw-runtime@0.2.19
- @fusion-plugin-examples/paperclip-runtime@0.2.19

## 0.14.2

### Patch Changes

- @fusion/core@0.14.2
- @fusion/engine@0.14.2
- @fusion-plugin-examples/hermes-runtime@0.2.18
- @fusion-plugin-examples/openclaw-runtime@0.2.18
- @fusion-plugin-examples/paperclip-runtime@0.2.18

## 0.14.1

### Patch Changes

- @fusion/core@0.14.1
- @fusion/engine@0.14.1
- @fusion-plugin-examples/hermes-runtime@0.2.17
- @fusion-plugin-examples/openclaw-runtime@0.2.17
- @fusion-plugin-examples/paperclip-runtime@0.2.17

## 0.14.0

### Patch Changes

- @fusion/core@0.14.0
- @fusion/engine@0.14.0
- @fusion-plugin-examples/hermes-runtime@0.2.16
- @fusion-plugin-examples/openclaw-runtime@0.2.16
- @fusion-plugin-examples/paperclip-runtime@0.2.16

## 0.13.0

### Patch Changes

- @fusion/core@0.13.0
- @fusion/engine@0.13.0
- @fusion-plugin-examples/hermes-runtime@0.2.15
- @fusion-plugin-examples/openclaw-runtime@0.2.15
- @fusion-plugin-examples/paperclip-runtime@0.2.15

## 0.12.0

### Patch Changes

- @fusion/core@0.12.0
- @fusion/engine@0.12.0
- @fusion-plugin-examples/hermes-runtime@0.2.14
- @fusion-plugin-examples/openclaw-runtime@0.2.14
- @fusion-plugin-examples/paperclip-runtime@0.2.14

## 0.11.0

### Patch Changes

- @fusion/core@0.11.0
- @fusion/engine@0.11.0
- @fusion-plugin-examples/hermes-runtime@0.2.13
- @fusion-plugin-examples/openclaw-runtime@0.2.13
- @fusion-plugin-examples/paperclip-runtime@0.2.13

## 0.10.0

### Patch Changes

- @fusion/core@0.10.0
- @fusion/engine@0.10.0
- @fusion-plugin-examples/hermes-runtime@0.2.12
- @fusion-plugin-examples/openclaw-runtime@0.2.12
- @fusion-plugin-examples/paperclip-runtime@0.2.12

## 0.9.4

### Patch Changes

- @fusion/core@0.9.4
- @fusion/engine@0.9.4
- @fusion-plugin-examples/hermes-runtime@0.2.11
- @fusion-plugin-examples/openclaw-runtime@0.2.11
- @fusion-plugin-examples/paperclip-runtime@0.2.11

## 0.9.3

### Patch Changes

- @fusion/core@0.9.3
- @fusion/engine@0.9.3
- @fusion-plugin-examples/hermes-runtime@0.2.10
- @fusion-plugin-examples/openclaw-runtime@0.2.10
- @fusion-plugin-examples/paperclip-runtime@0.2.10

## 0.9.2

### Patch Changes

- @fusion/core@0.10.0
- @fusion/engine@0.10.0
- @fusion-plugin-examples/hermes-runtime@0.2.9
- @fusion-plugin-examples/openclaw-runtime@0.2.9
- @fusion-plugin-examples/paperclip-runtime@0.2.9

## 0.9.1

### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.
- Updated dependencies [76deb48]
- Updated dependencies [f6242c2]
  - @fusion/core@0.9.1
  - @fusion/engine@0.9.1
  - @fusion-plugin-examples/hermes-runtime@0.2.8
  - @fusion-plugin-examples/openclaw-runtime@0.2.8
  - @fusion-plugin-examples/paperclip-runtime@0.2.8

## 0.9.0

### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- 9ce811a: Remote access (Tailscale) overhaul: the auth/scan URL now uses the live `https://<machine>.<tailnet>.ts.net/` URL captured from `tailscale funnel` instead of a constructed `http://<hostname>:<port>` from a configured label, so QR codes lead to a working public endpoint. The hostname label is no longer required (engine validation and the Settings UI both dropped it; `tailscale funnel` never used it). QR codes are now rendered with the `qrcode` library — previously the SVG was just the URL drawn as text — and a new `format=terminal` returns ASCII QR for the TUI. The Tailscale readiness parser now waits for the line containing the URL before flipping to `running`, fixing missing-URL captures. Dashboard polls remote status while `starting`/`stopping` so state updates without reopening the modal. The TUI shows a global `● tunnel` indicator with URL in the header when running, and `Ctrl+Q` opens an ASCII QR overlay anywhere in the app.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.
- Updated dependencies [48208db]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [91f9f20]
- Updated dependencies [b91533c]
- Updated dependencies [7f42c7f]
- Updated dependencies [9ce811a]
- Updated dependencies [17a072c]
- Updated dependencies [1beebc0]
- Updated dependencies [a654795]
- Updated dependencies [bb5402a]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
  - @fusion/core@0.9.0
  - @fusion/engine@0.9.0
  - @fusion-plugin-examples/hermes-runtime@0.2.7
  - @fusion-plugin-examples/openclaw-runtime@0.2.7
  - @fusion-plugin-examples/paperclip-runtime@0.2.7

## 0.8.4

### Patch Changes

- @fusion/core@0.8.4
- @fusion/engine@0.8.4
- @fusion-plugin-examples/hermes-runtime@0.2.6
- @fusion-plugin-examples/openclaw-runtime@0.2.6
- @fusion-plugin-examples/paperclip-runtime@0.2.6

## 0.8.3

### Patch Changes

- 9850bfa: Fix TUI token rendering, memory tracking fix, and other minor improvements
  - @fusion/core@0.8.3
  - @fusion/engine@0.8.3
  - @fusion-plugin-examples/hermes-runtime@0.2.5
  - @fusion-plugin-examples/openclaw-runtime@0.2.5
  - @fusion-plugin-examples/paperclip-runtime@0.2.5

## 0.8.2

### Patch Changes

- @fusion/core@0.8.2
- @fusion/engine@0.8.2
- @fusion-plugin-examples/hermes-runtime@0.2.4
- @fusion-plugin-examples/openclaw-runtime@0.2.4
- @fusion-plugin-examples/paperclip-runtime@0.2.4

## 0.8.1

### Patch Changes

- @fusion/core@0.8.1
- @fusion/engine@0.8.1
- @fusion-plugin-examples/hermes-runtime@0.2.3
- @fusion-plugin-examples/openclaw-runtime@0.2.3
- @fusion-plugin-examples/paperclip-runtime@0.2.3

## 0.8.0

### Patch Changes

- @fusion/core@0.8.0
- @fusion/engine@0.8.0
- @fusion-plugin-examples/hermes-runtime@0.2.2
- @fusion-plugin-examples/openclaw-runtime@0.2.2
- @fusion-plugin-examples/paperclip-runtime@0.2.2

## 0.7.1

### Patch Changes

- ce6dcef: fix(0.7.1): mobile polish, modal layout fixes, paperclip CLI parity, schema migration

  Mobile / dashboard:

  - ModelOnboardingModal: dialog was off-screen on phones because the desktop `min-width: 640px` won over the mobile `max-width: 100%`. Reset min-width/min-height to 0 in the mobile media query (with `!important` so persisted desktop sizes from `useModalResizePersist` cannot re-pin it). Compact provider cards: keep the icon inline beside the name + description, shrink the icon container, drop name/description font sizes, and rely on flex-wrap so the API-key actions still drop to their own row underneath. The API-key input + Save button now live on a single row at the full card width — input grows left-aligned, Save shrinks to the right with a hairline of inline padding.
  - NewAgentDialog: the dialog's top was rendering hidden behind the in-page Agents header on mobile. Render the dialog through `createPortal(..., document.body)` so the overlay escapes the `.agents-view` stacking context. Mobile media query also drops the overlay padding, fills 100vw / 100dvh with safe-area insets on header/footer for iOS notch + home indicator, and fixes the classic flex `min-height: auto` bug that prevented `overflow-y: auto` on the body from activating.
  - TerminalModal: same root cause as the onboarding modal — desktop `min-width: 480px` / `min-height: 320px` pinned the modal off-screen on phones. Reset to 0 in the mobile rule with `!important` so persisted desktop sizes can't override.
  - WorkflowStepManager: fix React error #310 ("Rendered more hooks than during the previous render") that prevented the workflow steps panel from loading. `useOverlayDismiss` was being called after an `if (!isOpen) return null` early return, so the hook count differed between open/closed renders. Moved the hook above the early return.
  - SettingsModal auth panel: tightened `.auth-panel-body` horizontal padding from `--space-xl` (24px) to `--space-md` (12px), giving each provider card more horizontal room.

  Paperclip runtime:

  - CLI parity: in the dashboard's "Local CLI" tab, Test / fetch companies / fetch agents now actually shell out to `paperclipai` instead of making HTTP calls through a derived URL. New CLI-backed variants (`probePaperclipViaCli`, `listCompaniesViaCli`, `listCompanyAgentsViaCli`, `createIssueViaCli`, `getIssueViaCli`, `agentsMeViaCli`) drive every Paperclip call that has a CLI counterpart; the runtime adapter routes through them when `transport=cli`. `getIssueComments` / `wakeAgent` / `getRunEvents` continue using HTTP (no matching `paperclipai` subcommands) but rely on the apiKey discovered from the local paperclipai config so CLI mode works end-to-end.
  - New dashboard routes `/providers/paperclip/cli-status`, `/cli-companies`, `/cli-agents` exposing the CLI helpers.

  Plugin runtime registry:

  - `GET /api/plugins/runtimes` now merges a bundled hermes/openclaw/paperclip fallback list on top of installed plugins, so the NewAgentDialog "Plugin Runtime" dropdown populates without requiring `fn plugin install` on a fresh setup. Installed plugins override the bundled entry by `runtimeId`. Coalesced the optional `version` field to `"0.0.0"` to satisfy the bundled-runtime type.

  Core:

  - Schema migration fix: bumped `SCHEMA_VERSION` from 48 → 49 so migration 49 (per-task `nodeId` column for remote-node routing) actually runs. Existing DBs at version 48 hit the early-return guard, never created the column, and `TaskStore.listTasks` crashed at startup with `no such column: nodeId` — the dashboard exited before initialization. The bump unblocks app startup on any pre-existing 0.7.0 install.

- Updated dependencies [ce6dcef]
  - @fusion/core@0.7.1
  - @fusion/engine@0.7.1
  - @fusion-plugin-examples/hermes-runtime@0.2.1
  - @fusion-plugin-examples/openclaw-runtime@0.2.1
  - @fusion-plugin-examples/paperclip-runtime@0.2.1

## 0.7.0

### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

### Patch Changes

- Updated dependencies [b30e017]
  - @fusion/core@0.7.0
  - @fusion/engine@0.7.0
  - @fusion-plugin-examples/hermes-runtime@0.2.0
  - @fusion-plugin-examples/openclaw-runtime@0.2.0
  - @fusion-plugin-examples/paperclip-runtime@0.2.0

## 0.6.0

### Patch Changes

- @fusion/core@0.6.0
- @fusion/engine@0.6.0

## 0.5.0

### Patch Changes

- @fusion/core@0.5.0
- @fusion/engine@0.5.0

## 0.4.1

### Patch Changes

- @fusion/core@0.4.1
- @fusion/engine@0.4.1

## 0.4.0

### Patch Changes

- @fusion/core@0.4.0
- @fusion/engine@0.4.0

## 0.2.7

### Patch Changes

- @fusion/core@0.2.7
- @fusion/engine@0.2.7

## 0.2.6

### Patch Changes

- @fusion/core@0.2.6
- @fusion/engine@0.2.6
