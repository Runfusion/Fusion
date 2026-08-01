---
"@runfusion/fusion": patch
---

summary: A restart during an AI merge no longer auto-pauses the task — reviewing/landing are recognized as live statuses.
category: fix
dev: The KTD-8 legacy-adoption table preserved merging/-pr/-fix but missed the family's other two live members, so startup adoption parked a mid-landing task paused ("legacy-adoption-unmappable: landing"). Both now preserve; self-healing's stale-merge sweeps remain the recovery owner.
