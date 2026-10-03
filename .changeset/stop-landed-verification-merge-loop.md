---
"@runfusion/fusion": patch
---

summary: Stop repeatedly merging already-landed tasks that are waiting on post-merge verification.
category: fix
dev: Honor post-merge evidence at queue admission and clear stale landing activity without changing gate results.
