---
"@runfusion/fusion": patch
---

summary: Keep Global and Project MCP settings bound to their own scopes in the Settings UI.
category: fix
dev: SettingsModal now reads and edits MCP server configuration from the raw scoped settings response rather than the merged project-effective form, preventing project MCP overrides from appearing as global values or making global saves no-op.
