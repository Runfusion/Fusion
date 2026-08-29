---
"@runfusion/fusion": patch
---

summary: Prevent stale workspace task trailers from falsely proving a repo landed.
category: fix
dev: Bounds findProvenLandedCommit degraded scans using taskCreatedAt and recent evidence limits.
