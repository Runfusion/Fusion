---
"@runfusion/fusion": patch
---

summary: Fix residual SQLite store constructions so chat, messages, backups, MCP secrets, and project setup work on PostgreSQL.
category: fix
dev: Routes remaining `new TaskStore`/`new AgentStore`/`createDatabase` call sites through `createTaskStoreForBackend`/`resolveAgentStoreBase` (chat.ts, message.ts, task.ts, pr.ts, backup.ts, memory-backup.ts, branch-group.ts, mcp.ts, project.ts, dashboard.ts getProjectStore, dashboard register-project-routes). Also fixes cli-printing-press plugin Drizzle row typing.
