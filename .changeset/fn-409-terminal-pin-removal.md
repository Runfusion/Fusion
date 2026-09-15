---
"@runfusion/fusion": minor
---

summary: The terminal now opens pinned above the bottom bar, with no pin button and no empty 36px band.
category: feature
dev: Removes the `docked` TerminalDisplayMode, the `terminal-pin-toggle` control, and their CSS; `readTerminalDisplayMode` normalizes any stored value other than `floating` to `below`. TerminalModal reports its effective pinned layout to App via `onPinnedLayoutChange` so `project-content--with-footer`, `left-sidebar-nav--with-footer`, and `right-dock--with-footer` stop double-reserving `--executor-footer-height`. The detached terminal joins the task-window contract (`layer="task-detail"`, `raiseToFrontSignal`, 800x680 standard opening size).
