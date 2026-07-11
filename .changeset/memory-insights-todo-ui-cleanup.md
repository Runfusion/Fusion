---
"@runfusion/fusion": patch
---

summary: Fix Memory insights parsing and modernize the Memory, Insights, Todos, and agent Memory views.
category: fix
dev: parseInsightsContent filtered bullets after stripping their prefix, collapsing every category into one blob; useMemoryData drops the dead GET /memory and /memory/stats mount fetches and no longer refetches the file list on selection; Engines tab is a 2-column card grid; Todo items are single-row with a quiet inline action cluster; the agent Memory tab uses the shared FileEditor with per-section save actions and fixes the agents.memoryFileMeta {{date}} interpolation.
