---
"@runfusion/fusion": patch
---

summary: Prevent inline review fixes from leaving approved tasks unable to merge.
category: fix
dev: Re-captures verified review identity, reroutes singular stale content from merge admission and self-healing, and emits bounded audit events.
