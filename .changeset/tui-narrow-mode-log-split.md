---
"@runfusion/fusion": minor
---

Add a horizontal log split to the TUI's narrow single-pane main view. When
the terminal is too narrow for the multi-pane grid, the bottom of the
screen now shows a live log strip while the top keeps the active section
(System, Stats, Utilities, or Settings). The split is dynamic: the top
pane gets exactly the rows it needs to render its content without
truncating (computed from the System chip wrap at the current width, or
each panel's known row count for Stats/Utilities/Settings), and the log
strip absorbs all remaining rows — maximizing log visibility without
clipping the active section. The split disables itself if the leftover
would give the log strip fewer than 6 rows. Down-arrow shifts sub-focus
into
the strip with the same key bindings as the dedicated logs section
(j/k, Home/G, Enter to expand, w to wrap, c to copy, f to filter).
Up-arrow at the top of the strip returns focus to the main pane; Esc
also exits the split. Right/Left/Tab continue to cycle sections,
including the dedicated full-screen logs view.
