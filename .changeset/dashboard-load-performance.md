---
"@gsxdsm/fusion": patch
---

Improve dashboard load performance by adding SQLite indexes for boot-critical queries. The indexes eliminate full table scans and temporary B-tree sorts for task listing, AI session listing, activity log queries, and agent filtering. Users with large task histories should see noticeably faster dashboard startup times.
