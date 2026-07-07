---
"@runfusion/fusion": patch
---

summary: Fix mobile dashboard terminal sometimes rendering completely blank on open.
category: fix
dev: TerminalModal now attaches a persistent ResizeObserver directly on the xterm container (mirroring SessionTerminal's existing pattern), so a container that reports a zero/collapsed box at the first post-open fit recovers as soon as its real box settles, instead of staying at FitAddon's degenerate 2x1-cell floor forever.
