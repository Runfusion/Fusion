---
"@runfusion/fusion": patch
---

summary: Recover agent interviews when models return thinking-only or malformed JSON responses.
category: fix
dev: Preserves structured thinking output and retries one JSON-only reformat turn before surfacing an error.
