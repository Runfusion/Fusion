---
"@runfusion/fusion": patch
---

summary: Task detail action buttons now render at a consistent size across all themes.
category: fix
dev: Extends the shared --detail-priority-control-min-height / --detail-control-border-radius sizing (FN-7585/FN-7633) to all five .detail-meta-inline-controls controls (attach, GitHub, priority, oversight, execution-mode), pinning a shared height AND square width/min-width so the cluster resolves one uniform square box regardless of theme --space-*/--icon-size-* tokens.
