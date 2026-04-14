---
"@gsxdsm/fusion": minor
---

Add skills registry and configuration API for execution defaults

This change introduces backend support for skills management:
- Skills discovery API (`GET /api/skills/discovered`) to list all available skills with their enabled state
- Skills execution toggle API (`PATCH /api/skills/execution`) to enable/disable skills with project-scoped persistence
- Skills catalog API (`GET /api/skills/catalog`) with resilient fallback to fetch skills.sh catalog

Skills are stored in project settings (`.fusion/settings.json`) with support for both top-level skills and package-scoped skills.
