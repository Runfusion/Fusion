# runfusion.ai

## 0.8.2

### Patch Changes

- Updated dependencies [531b13e]
- Updated dependencies [531b13e]
  - @runfusion/fusion@0.8.2

## 0.8.1

### Patch Changes

- Updated dependencies [a8dbdbc]
  - @runfusion/fusion@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [f19ecac]
- Updated dependencies [58510e1]
- Updated dependencies [cc9181d]
- Updated dependencies [5cc7597]
- Updated dependencies [2029968]
- Updated dependencies [cd03c6a]
- Updated dependencies [7227b87]
- Updated dependencies [81c6f01]
- Updated dependencies [c9241d8]
- Updated dependencies [198f85c]
- Updated dependencies [22bac2d]
  - @runfusion/fusion@0.8.0

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
  - @runfusion/fusion@0.7.1

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

- Updated dependencies [ec09282]
- Updated dependencies [92b8631]
- Updated dependencies [8fbd3bd]
- Updated dependencies [347cae8]
- Updated dependencies [0a5dcf1]
- Updated dependencies [3c8a490]
- Updated dependencies [637f435]
- Updated dependencies [7691bab]
- Updated dependencies [b30e017]
  - @runfusion/fusion@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [f4d98ed]
- Updated dependencies [6caab17]
- Updated dependencies [fdf8ca9]
  - @runfusion/fusion@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [112ad67]
- Updated dependencies [16ec204]
- Updated dependencies [79ce48c]
- Updated dependencies [c85ffa9]
- Updated dependencies [03a48ae]
- Updated dependencies [c1b0121]
- Updated dependencies [b969635]
  - @runfusion/fusion@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies [b5200ba]
- Updated dependencies [8097db2]
  - @runfusion/fusion@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [f560af5]
- Updated dependencies [cd4cef3]
- Updated dependencies [7e05a20]
- Updated dependencies [c818d71]
- Updated dependencies [c818d71]
- Updated dependencies [ff6a68b]
- Updated dependencies [1b3994f]
- Updated dependencies [1a8058f]
- Updated dependencies [39622f0]
- Updated dependencies [26f9c74]
- Updated dependencies [9d8852e]
  - @runfusion/fusion@0.4.0

## 0.2.7

### Patch Changes

- Updated dependencies [adbad8a]
  - @runfusion/fusion@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies [dbc9446]
  - @runfusion/fusion@0.2.6

## 0.2.5

### Patch Changes

- 69f789f: TUI: layered defenses for the resize / wrong-height-layout bug

  Materially reduces (but doesn't fully eliminate) the symptom of the header rendering off-screen or the layout taking 1-2 too many rows, especially under tmux/ssh.

  - Enter alternate-screen buffer on start; leave on stop. The TUI gets a dedicated fullscreen surface that doesn't share scrollback.
  - StatusBar Text children no longer wrap (default `wrap="wrap"` was letting long hotkey + URL strings wrap to 2 rows, throwing the row budget off by 1).
  - Controller subscribes to `process.stdout` "resize" and calls `inkInstance.clear()` to reset log-update's frame tracking.
  - App-level resize listener + key-based remount on dimension change so React rebuilds the tree from scratch with fresh bounds.
  - Root Box gets explicit width + overflow="hidden"; MainHeader outer Box too.
  - Settings + Utilities side-by-side now stretch to equal heights (UtilitiesPanel switched from `flexShrink={0}` to `flexGrow={1}`).

- Updated dependencies [69f789f]
  - @runfusion/fusion@0.2.5

## 0.2.4

### Patch Changes

- 88b4ecb: TUI fixes: help overlay no longer crashes, header stays rendered

  - Help overlay (`?` / `h`) crashed with "Encountered two children with the same key" because several shortcut entries share the same display key (`[t]` for Git view AND for Toggle engine pause; `[r]` for Refresh stats AND Refresh agent detail). Switch to index-based keys — each row is unique by position, not by character.
  - Refresh the help text to reflect the unified header (`[m]` Main, `[b/a/g/t/e]` views), the Settings/Files/Agents `←/→` pane swap, the Git push/fetch shortcuts, the Files hidden-files toggle, and the Logs `G` jump-to-end.
  - Main view (status mode) header sometimes vanished after a tmux pane switch and stayed missing until a terminal resize. Two fixes: (a) drop the `rows < 10` auto-hide in `MainHeader` — tmux pane switches can briefly report stale or zero dimensions, and a transient `return null` was orphaning the header. (b) Wrap `MainHeader` and `StatusBar` in `flexShrink={0}` boxes inside `StatusModeGrid` and `StatusModeSingle` (matching the prior fix in `InteractiveMode`), so Yoga can't squeeze them to 0 rows when content pressures the row budget.

- Updated dependencies [88b4ecb]
  - @runfusion/fusion@0.2.4

## 0.2.3

### Patch Changes

- 0f070d8: TUI header redesign and Settings ←/→ pane navigation

  - Replace the dual section + interactive tab strips with a single unified strip: `[m] Main  [b] Board  [a] Agents  [g] Settings  [t] Git  [e] Explorer`. Status mode highlights the Main pill; interactive views highlight their own. Number-key shortcuts (1–5) for status sections still work but are no longer rendered in the header chrome.
  - Width tiers now fit comfortably at every terminal size: full labels at cols ≥ 90, glyph-only at 50–89 (every shortcut still visible), FUSION + active pill only below 50. Help/quit shows at cols ≥ 110.
  - New `m` shortcut switches to status mode (Main); `s` kept as alias.
  - Settings interactive view: `←` focuses the list pane, `→` focuses the detail pane. `Tab` still cycles either way (consistent with Agents view).

- Updated dependencies [0f070d8]
  - @runfusion/fusion@0.2.3

## 0.2.2

### Patch Changes

- 58688fa: Keep the FUSION header from wrapping when the terminal is narrow. The `MiniLogo` and tab pills had Yoga's default `flexShrink: 1`, so the row's collective content overrunning the width was being absorbed by shrinking every child — including FUSION, which then wrapped to two lines. Pin all fixed-content header children to `flexShrink={0}`; the trailing flexGrow filler absorbs slack instead.
- Updated dependencies [58688fa]
  - @runfusion/fusion@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [07d7bac]
  - @runfusion/fusion@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [a8f5591]
  - @runfusion/fusion@0.2.0

## 0.1.3

### Patch Changes

- Updated dependencies [c105cfa]
- Updated dependencies [86521e2]
- Updated dependencies [76961d4]
- Updated dependencies [f77dd9d]
- Updated dependencies [f4d2a4b]
- Updated dependencies [f77dd9d]
- Updated dependencies [31f021a]
- Updated dependencies [eef56af]
- Updated dependencies [832c32c]
- Updated dependencies [dce70bf]
- Updated dependencies [f078a4e]
  - @runfusion/fusion@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [9bf2981]
- Updated dependencies
- Updated dependencies [94473c8]
- Updated dependencies
- Updated dependencies [c01892d]
  - @runfusion/fusion@0.1.2

## 0.1.1

Catch-up version bump so `runfusion.ai` stays in sync with `@runfusion/fusion`. The two packages are now grouped under changesets `fixed` in `.changeset/config.json` and will always share a version number from here on.

## 0.0.8

### Patch Changes

- Updated dependencies [39f7709]
- Updated dependencies [585e480]
- Updated dependencies [86fd24e]
- Updated dependencies [585e480]
- Updated dependencies [7d31b21]
- Updated dependencies
- Updated dependencies [ff5df16]
- Updated dependencies [df2836c]
- Updated dependencies [bbdd11a]
- Updated dependencies [0bb0100]
  - @runfusion/fusion@0.1.1

## 0.0.7

### Patch Changes

- Updated dependencies [25d44e1]
- Updated dependencies [a2ed6d0]
  - @runfusion/fusion@0.1.0

## 0.0.6

### Patch Changes

- Updated dependencies
  - @runfusion/fusion@0.0.6

## 0.0.5

### Patch Changes

- Updated dependencies [41553a5]
  - @runfusion/fusion@0.0.5

## 0.0.4

### Patch Changes

- Bump the alias package to stay in sync with the current Fusion release.

## 0.0.3

### Patch Changes

- Updated dependencies [0da498a]
  - @runfusion/fusion@0.0.4

## 0.0.2

### Patch Changes

- Updated dependencies [1fc72d1]
- Updated dependencies [46b8032]
- Updated dependencies [c1bc5b9]
- Updated dependencies [06704cf]
  - @runfusion/fusion@0.0.3
