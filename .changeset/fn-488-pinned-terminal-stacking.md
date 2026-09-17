---
"@runfusion/fusion": patch
---

summary: Clicking the bottom-pinned terminal now brings it in front of other windows.
category: fix
dev: The `below` presentation of `TerminalModal` claims the shared `floatingWindowStack` counter (`nextFloatingZ` on mount/re-pin, `bringToFront` on pointerdown/focus behind `useDashboardWindowFocusRestoring`, plus the `focusNonce` signal) and writes it inline on `.terminal-modal--below` only. `.terminal-below-host` deliberately stays free of any stacking context so the fixed bottom bars keep painting above its reserved band. The body-portaled workspace picker menu derives its layer from that claim in the pinned presentation too, and the footer stat tooltip now follows the live `--fusion-max-z` ceiling instead of the static `--z-popover` layer.
