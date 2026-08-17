---
"@runfusion/fusion": patch
---

summary: Plan New Mission now sits at the top of the mission list and is slightly taller.
category: fix
dev: Replaced footer CTA wrappers with top mission-manager__sidebar-cta-bar and mission-list__header-actions containers using calc(var(--space-lg) * 2 + var(--space-sm)); removed the duplicate empty-state CTA.
