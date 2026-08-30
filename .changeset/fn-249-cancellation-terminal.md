---
"@runfusion/fusion": patch
---

summary: Reset and manual cancel now stop a running task cleanly, with no failed step or blocked merge.
category: fix
dev: Graph traversal halts on the run abort signal. Durable step-result writes now use a field-bounded TaskStore primitive that serializes with Reset's task advisory lock and checks the exact startedAt attempt before publishing.
