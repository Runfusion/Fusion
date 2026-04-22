---
"@gsxdsm/fusion": patch
---

Make `fn agent import` import package skills alongside agents when importing from directory or archive sources. Skills are written to `{project}/skills/imported/{company-slug}/{skill-slug}/SKILL.md` with proper frontmatter formatting. Existing skill files are skipped rather than overwritten. Single AGENTS.md file imports do not include package skills.
