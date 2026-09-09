---
"@runfusion/fusion": patch
---

summary: Keep chat composers editable immediately after stopping a response.
category: fix
dev: Queues text at the dispatch fence, clears cancellation before draining, and refuses attachments during reconciliation.
