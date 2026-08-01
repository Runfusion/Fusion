---
"@runfusion/fusion": patch
---

summary: Finished cards on renamed boards now refresh their diff stats after a merge.
category: fix
dev: `mergeSignature`'s dependency list omitted `isCompleteColumn`, so the key stayed undefined when column traits arrived after first paint.
