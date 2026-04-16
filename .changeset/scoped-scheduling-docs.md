---
"@gsxdsm/fusion": minor
---

Add scoped scheduling support for automations and routines

Schedules and routines now support `global` and `project` execution scopes:
- **Global** schedules run across all projects (e.g., backups, cross-project maintenance)
- **Project** schedules run within a single project only (e.g., per-project CI, deployments)
- Backward-compatible default: omitted scope resolves to `project` with `projectId="default"`
- Dashboard Scheduled Tasks modal includes a Global/Project scope toggle
- API endpoints accept `?scope=global` or `?scope=project&projectId=<id>`
