---
"@runfusion/fusion": patch
---

summary: Stop false CE skill-load warnings when plugin skills resolve without FUSION_CE_SKILLS_DIR.
category: fix
dev: executeWorkflowStep warns [skill-load] only when the named skill is not discoverable after multi-source merge (plugin body dirs and/or FUSION_CE_SKILLS_DIR); unrelated plugin paths do not suppress a missing-name warning; successful non-CE plugin skill nodes no longer warn on unset FUSION_CE_SKILLS_DIR (GitHub #2388 / FN-8461).
