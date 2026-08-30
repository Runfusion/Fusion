---
"@runfusion/fusion": minor
---

summary: Press [Shift+V] in the TUI Logs panel for a chrome-free view you can select and copy with the mouse.
category: feature
dev: The Logs panel keeps a border, title and filter row and sits between a header and a status bar, so a rectangular terminal drag captures box-drawing characters and neighbouring rows; mouse reporting is also enabled there for wheel scrolling and swallows the drag entirely. New `logsRawMode` (controller + state) renders only plain log lines starting at column 0, replaces the whole frame above the narrow/grid layout choice — so it works on wide terminals, where the grid layout is used — keeps one trailing hint row, and is excluded from `wantsMouse` so native click-drag works. Bound to `Shift+V` because the Utilities panel already advertises `[v] Auto-Kill Vitest` on the same screen; Esc clears raw mode ahead of the expanded-entry escape. Line shape matches the existing `[c]` single-line copy so mouse and keyboard copies produce identical text. Covered by `raw-logs-mode.test.ts`, which pins the above-layout escape, the mouse release, the binding, and the exit hint.
