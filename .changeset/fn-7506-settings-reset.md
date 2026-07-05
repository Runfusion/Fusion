---
"@runfusion/fusion": minor
---

summary: Add a Reset Settings button to restore a menu's or all project settings to defaults.
category: feature
dev: New tested section→keys (scope-aware) registry (packages/dashboard/app/components/settings/section-keys.ts) drives per-menu reset via updateSettings/updateGlobalSettings with null-as-delete; non-blob sections (secrets, MCP, plugins, memory, auth, prompts, CLI agents, runtimes) are excluded with a documented reason.
