---
"@runfusion/fusion": patch
---

Fix dashboard task deletion failing with "still referenced as a dependency" even after the user confirms removing dependency references. The `useTasks` hook's `deleteTask` was dropping its `options` argument, so the `removeDependencyReferences` flag from the confirmation flow never reached the API.
