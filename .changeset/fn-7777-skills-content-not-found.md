---
"@runfusion/fusion": patch
---

summary: Fix Skills view showing "Skill not found" when opening any skill's content.
category: fix
dev: The /skills/:id/content and /skills/:id/file routes double-decoded the URL param (Express 5 already decodes route params once), corrupting the encoded source segment so the id no longer matched computeSkillId's discovery output. Routes now use the once-decoded canonical id (FN-7777).
