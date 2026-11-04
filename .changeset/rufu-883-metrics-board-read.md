---
"@runfusion/fusion": patch
---

summary: The dashboard no longer loads card comment histories every 5s just to count board columns.
category: performance
dev: The metrics domain sampler now declares `fields: []` on its board read, and `comments` is a new declarable list-read field in `TaskListReadField` (RUFU-627's mechanism). A read that does not declare `comments` no longer receives `comments`/`steeringComments`.
