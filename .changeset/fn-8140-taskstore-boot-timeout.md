---
"@runfusion/fusion": patch
---

summary: Keep agent reads responsive by reusing the host TaskStore across extension loads.
category: fix
dev: Shares extension store cache state across Pi-loaded module instances to avoid dual backend boots.
