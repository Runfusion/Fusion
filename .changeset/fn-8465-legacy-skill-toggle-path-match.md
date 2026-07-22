---
"@runfusion/fusion": patch
---

summary: Ignore stale flat skill-toggle keys so session skills match the Skills view after category layouts.
category: fix
dev: Session skillsOverride matches +/- patterns by skills/-relative path (not bareSkillName alone); legacy flat disables no longer suppress nested skillFiles bodies (GitHub #2385 / FN-8465).
