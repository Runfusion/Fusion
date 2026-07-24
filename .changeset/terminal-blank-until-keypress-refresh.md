---
"@runfusion/fusion": patch
---

summary: Fix terminal opening blank (no shell prompt) on some systems until a keypress, font-size change, or new tab.
category: fix
dev: Observer/geometry-driven fits in TerminalModal (`fitAndResizeForSession`, initial fit) and SessionTerminal now always follow `fit()` with `terminal.refresh(0, rows-1)`, so a renderer stalled at init repaints even when cols/rows are unchanged.
