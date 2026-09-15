---
"@runfusion/fusion": patch
---

summary: Prevent stalled continuation pumps from remaining stuck after an engine pause.
category: fix
dev: Releases the leaked pause-path guard and adds a generation-fenced, progress-based continuation-drain watchdog; sibling guards needed no fix.
