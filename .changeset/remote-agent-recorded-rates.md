---
"@runfusion/fusion": minor
---

summary: Record the rates that applied when a remote agent turn is collected, so its cost stays accurate later.
category: feature
dev: The turn-ingest route stamps the applicable rates and basis onto each turn and always overwrites any collector-supplied stamp. Stamped turns price at their recorded rates; unstamped historical turns stay explicitly a recalculation and are never back-filled.
