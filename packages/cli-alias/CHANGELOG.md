# runfusion.ai

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
