---
"@runfusion/fusion": minor
---

Add a Todo aging indicator on the board. The Todo column header now shows
per-bucket counts (0–7d, 8–30d, 31+d) derived from `columnMovedAt`
(falling back to `createdAt`, then `updatedAt`). Clicking a bucket filters
the Todo column to that bucket; clicking it again clears the filter.
