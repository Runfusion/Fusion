---
"@runfusion/fusion": patch
---

summary: Holding Save in the task composer now fills a circular progress ring instead of a bar.
category: feature
dev: QuickEntryBox replaces the `clip-path` fill mask and the lucide `Play` overlay with an SVG progress ring (`.quick-entry-save-ring`) whose `stroke-dashoffset` animates from 100 to 0 over `--quick-entry-hold-duration`, scoped to `[data-hold-state="holding"]`. Gesture timings, the FN-453 click barrier, ARIA labels, and task creation are unchanged.
