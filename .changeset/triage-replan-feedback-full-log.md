---
"@runfusion/fusion": patch
---

summary: Deliver spec revision feedback to the planner when a task is re-planned.
category: fix
dev: Read re-plan feedback from the freshly loaded task log instead of the slim scheduler row, whose log is always empty.
