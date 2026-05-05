---
"@runfusion/fusion": patch
---

Improve dashboard TUI System panel discoverability and panel navigation:

- Default the focused panel to **System** on launch so `Enter` immediately opens the dashboard URL in the browser. Adds an inline hint row (`[Enter] open URL · [c] copy token · [M] mouse on/off`) that is only visible while System is focused.
- Add `[c]` shortcut (when System is focused) to copy the auth token to the clipboard, with the same flash + log-line feedback used by the Logs `[c]` copy. Mouse mode normally blocks click-drag selection of the token, so this gives users a keyboard path.
- Add `[M]` global shortcut to toggle xterm mouse reporting at runtime. Off → click-drag does native text selection (the only path that works under tmux's `mouse on`, where `Shift+drag` is intercepted by tmux before reaching the terminal). On → wheel scrolling on Logs/Files/Git list panels works as before.
- Fix `←`/`→` panel cycling order: `SECTION_ORDER` was `[system, logs, utilities, stats, settings]`, which didn't match the visual layout. Changed to `[system, logs, stats, utilities, settings]` so left/right now matches both the on-screen left-to-right card order and the Tab/Shift+Tab cycle (`PANEL_ORDER`). From Logs going right now lands on Stats; from Settings going left now lands on Utilities.
- Updated the help overlay with the new shortcuts.
