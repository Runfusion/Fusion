---
"@runfusion/fusion": patch
---

summary: Keep task-card active glow during replan and revise while agents work.
category: fix
dev: isTaskAgentActive treats needs-replan (and plan-in-place replan freshness) as agent-active for board/list chrome; lock policy documented in taskActivity FNXC.
